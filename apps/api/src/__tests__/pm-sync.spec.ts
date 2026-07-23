import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmTeamMemberships,
  pmIssues,
  pmIssueHistory,
  pmIssueSubscribers,
  pmCycles,
  pmCycleSnapshots,
  pmLabels,
  pmWorkflowStates,
  pmProjects,
  domainEvents,
  syncMutations,
  notifications,
  notificationPreferences,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmJobs } from '../jobs/pm.jobs';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmMutationExecutor } from '../modules/pm/sync/mutation-executor.service';

/**
 * PRD v6 Sprint 32 — FSE foundations. Real-Postgres: workspace self-seeding,
 * atomic numbering, in-tx event emission with sync refs, mutate idempotency,
 * delta upserts/tombstones, and the non-negotiable private-team exclusion in
 * bootstrap AND delta (§16 — the isolation class that must never regress).
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc);
// REAL NotificationsService — Sprint 38 asserts on actual inbox rows
// (collapse, preferences, sweeps). Emails are spied per-test, never sent.
const notificationsSvc = new NotificationsService(
  db as never,
  dbAdmin as never,
  new ConfigService(),
  emitter,
);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc);
const visibility = new PmVisibilityService(dbSvc);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility);
const gatewayStub = { emitSeq: jest.fn() };
const executor = new PmMutationExecutor(dbSvc, issuesSvc, projectsSvc, syncSvc, gatewayStub as never);

let tenantId: string;
let ownerId: string;
let outsiderId: string; // member of tenant, NOT of the private team
let teamId: string; // default (public) team
let privateTeamId: string;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `Apex Studio ${rid()}`, slug: `pm-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const mkUser = async (email: string) => {
    const [u] = await dbAdmin.insert(users).values({ email, full_name: 'PM Tester', status: 'active' }).returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role: 'owner', status: 'active' });
    return u!.id;
  };
  ownerId = await mkUser(`pm-owner-${rid()}@t.test`);
  outsiderId = await mkUser(`pm-outsider-${rid()}@t.test`);

  // Self-heal seeds the default team (both users are members — org-open).
  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin
    .select()
    .from(pmTeams)
    .where(eq(pmTeams.tenant_id, tenantId));
  teamId = team!.id;

  // A private team with ONLY the owner.
  const priv = await teamsSvc.create(tenantId, ownerId, { key: 'SEC', name: 'Secret', is_private: true });
  privateTeamId = priv.data.id;
  await dbAdmin
    .delete(pmTeamMemberships)
    .where(and(eq(pmTeamMemberships.team_id, privateTeamId), eq(pmTeamMemberships.user_id, outsiderId)));
});

afterAll(async () => {
  await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, ownerId));
  await dbAdmin.delete(users).where(eq(users.id, outsiderId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Workspace seeding (§4, AC-ZERO)', () => {
  it('concurrent first bootstraps seed exactly ONE team (StrictMode race)', async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `Race Co ${rid()}`, slug: `pmrace-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
      .returning();
    const [u] = await dbAdmin.insert(users).values({ email: `pm-race-${rid()}@t.test`, full_name: 'Racer', status: 'active' }).returning();
    await dbAdmin.insert(memberships).values({ tenant_id: t!.id, user_id: u!.id, role: 'owner', status: 'active' });
    try {
      // Both used to pass the existence check and the loser died on the
      // pm_teams_tenant_id_key_key unique — the advisory lock serializes them.
      const results = await Promise.all([
        teamsSvc.ensureWorkspace(t!.id, u!.id),
        teamsSvc.ensureWorkspace(t!.id, u!.id),
        teamsSvc.ensureWorkspace(t!.id, u!.id),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1); // one seeder, two no-ops
      const rows = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, t!.id));
      expect(rows).toHaveLength(1);
    } finally {
      await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, t!.id));
      await dbAdmin.delete(tenants).where(eq(tenants.id, t!.id));
      await dbAdmin.delete(users).where(eq(users.id, u!.id));
    }
  });

  it('seeded one team from the company name with 8 states, counter and members', async () => {
    const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.id, teamId));
    expect(team!.key).toMatch(/^[A-Z0-9]{2,6}$/);
    expect(team!.default_state_id).not.toBeNull();
    const list = await teamsSvc.list(tenantId, ownerId);
    expect(list.data.states.filter((s) => s.team_id === teamId)).toHaveLength(8);
    expect(list.data.memberships.some((m) => m.user_id === ownerId)).toBe(true);
    // Re-entrant: second call does not duplicate.
    expect(await teamsSvc.ensureWorkspace(tenantId, ownerId)).toBe(false);
  });
});

describe('Issues core (§5)', () => {
  it('creates with atomic numbering, default state, ranks and creator subscription', async () => {
    const a = await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'First issue' });
    const b = await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Second issue' });
    expect(b.data.number).toBe(a.data.number + 1);
    expect(a.data.board_rank < b.data.board_rank).toBe(true);
    expect(a.data.state_id).toBeTruthy();
  });

  it('state transitions stamp lifecycle timestamps and write history (§5.2)', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Lifecycle' })).data;
    const list = await teamsSvc.list(tenantId, ownerId);
    const started = list.data.states.find((s) => s.team_id === teamId && s.category === 'started')!;
    const done = list.data.states.find((s) => s.team_id === teamId && s.category === 'completed')!;

    const s1 = await issuesSvc.moveState(tenantId, ownerId, issue.id, started.id);
    expect(s1.data.started_at).not.toBeNull();
    const s2 = await issuesSvc.moveState(tenantId, ownerId, issue.id, done.id);
    expect(s2.data.completed_at).not.toBeNull();

    const history = await dbAdmin.select().from(pmIssueHistory).where(eq(pmIssueHistory.issue_id, issue.id));
    expect(history.filter((h) => h.field === 'state')).toHaveLength(2);
  });

  it('every write publishes a pm.* event with sync refs in the same commit', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Event check' })).data;
    const events = await dbAdmin
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, tenantId), eq(domainEvents.event_name, 'pm.issue.created')));
    const mine = events.find((e) => (e.payload as { issue_id?: string }).issue_id === issue.id);
    expect(mine).toBeDefined();
    expect((mine!.payload as { sync: Array<{ t: string }> }).sync.some((s) => s.t === 'pm_issues')).toBe(true);
    expect(mine!.sync_seq).toBeGreaterThan(0);
  });
});

describe('Mutation executor (§3.5)', () => {
  it('applies a batch, is idempotent per clientMutationId, pings once', async () => {
    gatewayStub.emitSeq.mockClear();
    const cid = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const items = [
      {
        clientMutationId: cid,
        op: 'issue.create' as const,
        id: issueId,
        fields: { team_id: teamId, title: 'Executor-born issue' },
      },
    ];
    const first = await executor.execute(tenantId, ownerId, items);
    expect(first.results[0]!.status).toBe('applied');
    expect(first.results[0]!.rows?.pm_issues?.[0]?.id).toBe(issueId);
    expect(gatewayStub.emitSeq).toHaveBeenCalledTimes(1);

    // Replay: no second application, no second issue.
    const second = await executor.execute(tenantId, ownerId, items);
    expect(second.results[0]!.status).toBe('duplicate');
    const rows = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, issueId));
    expect(rows).toHaveLength(1);
    const ledger = await dbAdmin
      .select()
      .from(syncMutations)
      .where(and(eq(syncMutations.tenant_id, tenantId), eq(syncMutations.client_mutation_id, cid)));
    expect(ledger).toHaveLength(1);
  });

  it('rejects an invalid op without touching state and records the rejection', async () => {
    const cid = crypto.randomUUID();
    const res = await executor.execute(tenantId, ownerId, [
      { clientMutationId: cid, op: 'issue.move_state' as const, id: crypto.randomUUID(), fields: { state_id: crypto.randomUUID() } },
    ]);
    expect(res.results[0]!.status).toBe('rejected');
    const ledger = await dbAdmin
      .select()
      .from(syncMutations)
      .where(and(eq(syncMutations.tenant_id, tenantId), eq(syncMutations.client_mutation_id, cid)));
    expect(ledger[0]!.status).toBe('rejected');
  });
});

describe('Bootstrap + delta visibility (§3.3/§3.4/§16)', () => {
  let secretIssueId: string;

  beforeAll(async () => {
    secretIssueId = (
      await issuesSvc.create(tenantId, ownerId, { team_id: privateTeamId, title: 'Confidential design work' })
    ).data.id;
  });

  it('bootstrap NEVER carries private-team rows to a non-member', async () => {
    const ownerLines = (await syncSvc.bootstrap(tenantId, ownerId)).join('\n');
    const outsiderLines = (await syncSvc.bootstrap(tenantId, outsiderId)).join('\n');
    expect(ownerLines).toContain(secretIssueId);
    expect(ownerLines).toContain(privateTeamId);
    expect(outsiderLines).not.toContain(secretIssueId);
    expect(outsiderLines).not.toContain(privateTeamId);
    expect(outsiderLines).not.toContain('Confidential design work');
  });

  it('delta upserts a touched issue for a member and EXCLUDES it for a non-member', async () => {
    const before = await syncSvc.latestSeq();
    await issuesSvc.setPriority(tenantId, ownerId, secretIssueId, 1);

    const ownerDelta = await syncSvc.delta(tenantId, ownerId, before);
    expect('upserts' in ownerDelta && ownerDelta.upserts.pm_issues?.some((r) => (r as { id: string }).id === secretIssueId)).toBe(true);

    const outsiderDelta = await syncSvc.delta(tenantId, outsiderId, before);
    if ('upserts' in outsiderDelta) {
      const leaked = outsiderDelta.upserts.pm_issues?.some((r) => (r as { id: string }).id === secretIssueId) ?? false;
      expect(leaked).toBe(false);
      // Invisible-but-touched rows tombstone for the non-member (visibility-loss rule).
      expect(outsiderDelta.tombstones.pm_issues ?? []).toContain(secretIssueId);
    } else {
      throw new Error('unexpected re-bootstrap');
    }
  });

  it('membership revoke → next delta tombstones the private team for that user (§16)', async () => {
    // Add the outsider to the private team, let them see it once…
    await dbAdmin.insert(pmTeamMemberships).values({
      team_id: privateTeamId,
      tenant_id: tenantId,
      user_id: outsiderId,
      is_lead: false,
    });
    const seen = await syncSvc.bootstrap(tenantId, outsiderId);
    expect(seen.join('\n')).toContain(privateTeamId);

    const before = await syncSvc.latestSeq();
    // …then revoke and publish the membership-changed event (team-scoped ref).
    await dbAdmin
      .delete(pmTeamMemberships)
      .where(and(eq(pmTeamMemberships.team_id, privateTeamId), eq(pmTeamMemberships.user_id, outsiderId)));
    await domainEventsSvc.publish({
      name: 'pm.team.membership_changed',
      tenantId,
      actorUserId: ownerId,
      payload: { team_id: privateTeamId, sync: [{ t: 'pm_teams', id: privateTeamId }] },
    });

    const delta = await syncSvc.delta(tenantId, outsiderId, before);
    if (!('upserts' in delta)) throw new Error('unexpected re-bootstrap');
    expect(delta.tombstones.pm_teams ?? []).toContain(privateTeamId);
    // The member still sees it as an upsert.
    const ownerDelta = await syncSvc.delta(tenantId, ownerId, before);
    if (!('upserts' in ownerDelta)) throw new Error('unexpected re-bootstrap');
    expect(ownerDelta.upserts.pm_teams?.some((r) => (r as { id: string }).id === privateTeamId)).toBe(true);
  });

  it('auditor mutations are rejected wholesale (§16)', async () => {
    const res = await executor.execute(
      tenantId,
      ownerId,
      [{ clientMutationId: crypto.randomUUID(), op: 'issue.create' as const, id: crypto.randomUUID(), fields: { team_id: teamId, title: 'Auditor try' } }],
      'auditor',
    );
    expect(res.results.every((r) => r.status === 'rejected')).toBe(true);
    expect(res.results[0]!.errorCode).toContain('read-only');
  });

  it('a 20-mutation batch replays exactly-once (offline replay contract)', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      clientMutationId: crypto.randomUUID(),
      op: 'issue.create' as const,
      id: crypto.randomUUID(),
      fields: { team_id: teamId, title: `Replay batch ${i}` },
    }));
    const first = await executor.execute(tenantId, ownerId, items);
    expect(first.results.filter((r) => r.status === 'applied')).toHaveLength(20);
    const second = await executor.execute(tenantId, ownerId, items);
    expect(second.results.filter((r) => r.status === 'duplicate')).toHaveLength(20);
    const rows = await dbAdmin
      .select({ id: pmIssues.id })
      .from(pmIssues)
      .where(and(eq(pmIssues.tenant_id, tenantId), inArray(pmIssues.id, items.map((i) => i.id))));
    expect(rows).toHaveLength(20);
  });

  it('two clients converge to identical state after interleaved batches', async () => {
    const issueId = crypto.randomUUID();
    await executor.execute(tenantId, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'issue.create' as const, id: issueId, fields: { team_id: teamId, title: 'Converge me' } },
    ]);
    const start = await syncSvc.latestSeq();

    // Interleaved concurrent edits (priority vs assign) — commit order unknown.
    await Promise.all([
      executor.execute(tenantId, ownerId, [
        { clientMutationId: crypto.randomUUID(), op: 'issue.set_priority' as const, id: issueId, fields: { priority: 2 } },
      ]),
      executor.execute(tenantId, ownerId, [
        { clientMutationId: crypto.randomUUID(), op: 'issue.assign' as const, id: issueId, fields: { assignee_user_id: outsiderId } },
      ]),
    ]);

    // Both simulated clients pull their own deltas → identical final row.
    const applyDelta = async () => {
      const d = await syncSvc.delta(tenantId, ownerId, start);
      if (!('upserts' in d)) throw new Error('re-bootstrap');
      return d.upserts.pm_issues?.find((r) => (r as { id: string }).id === issueId) as Record<string, unknown>;
    };
    const clientA = await applyDelta();
    const clientB = await applyDelta();
    expect(clientA).toBeDefined();
    expect(clientA.priority).toBe(2);
    expect(clientA.assignee_user_id).toBe(outsiderId);
    expect(clientB).toEqual(clientA);
  });

  it('full op set: labels, comment, delete, restore round-trip through the executor', async () => {
    const issueId = crypto.randomUUID();
    const [labelRow] = await dbAdmin
      .insert(pmLabels)
      .values({ tenant_id: tenantId, name: `bug-${crypto.randomBytes(3).toString('hex')}`, color: '#F8786B' })
      .returning();
    const commentId = crypto.randomUUID();

    const res = await executor.execute(tenantId, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'issue.create' as const, id: issueId, fields: { team_id: teamId, title: 'Full ops' } },
      { clientMutationId: crypto.randomUUID(), op: 'issue.set_labels' as const, id: issueId, fields: { label_ids: [labelRow!.id] } },
      { clientMutationId: crypto.randomUUID(), op: 'comment.create' as const, id: commentId, fields: { issue_id: issueId, body: 'First comment' } },
      { clientMutationId: crypto.randomUUID(), op: 'issue.delete' as const, id: issueId },
      { clientMutationId: crypto.randomUUID(), op: 'issue.restore' as const, id: issueId },
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
    const [row] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, issueId));
    expect(row!.deleted_at).toBeNull(); // restored
  });

  it('rankBetween stays ordered under repeated same-gap inserts (rebalance-free)', async () => {
    const { rankBetween } = await import('@flicks/shared/pm');
    let lo: string | null = null;
    const hi: string | null = null;
    const ranks: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r: string = rankBetween(lo, hi);
      ranks.push(r);
      lo = r; // append pattern
    }
    for (let i = 1; i < ranks.length; i++) expect(ranks[i - 1]! < ranks[i]!).toBe(true);
    // Squeeze 30 keys into ONE gap — worst case for fractional indexing.
    let a: string | null = ranks[10]!;
    const b: string | null = ranks[11]!;
    for (let i = 0; i < 30; i++) {
      const mid: string = rankBetween(a, b);
      expect(a! < mid && mid < b!).toBe(true);
      a = mid;
    }
  });

  it('a batch with one bad item reports per-item statuses (partial failure)', async () => {
    const good = crypto.randomUUID();
    const res = await executor.execute(tenantId, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'issue.create' as const, id: good, fields: { team_id: teamId, title: 'Good one' } },
      { clientMutationId: crypto.randomUUID(), op: 'issue.move_state' as const, id: crypto.randomUUID(), fields: { state_id: crypto.randomUUID() } },
      { clientMutationId: crypto.randomUUID(), op: 'issue.set_priority' as const, id: good, fields: { priority: 3 } },
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'rejected', 'applied']);
  });

  it('move_team renumbers via the target counter and remaps the state by category', async () => {
    const target = await teamsSvc.create(tenantId, ownerId, { key: 'OPS', name: 'Operations' });
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Migrating issue' })).data;
    const moved = (await issuesSvc.moveTeam(tenantId, ownerId, issue.id, target.data.id)).data;
    expect(moved.team_id).toBe(target.data.id);
    expect(moved.number).toBe(1); // fresh counter
    const [state] = await dbAdmin
      .select()
      .from((await import('@flicks/db/schema')).pmWorkflowStates)
      .where(eq((await import('@flicks/db/schema')).pmWorkflowStates.id, moved.state_id));
    expect(state!.team_id).toBe(target.data.id);
    expect(state!.category).toBe('backlog'); // same category, target team's state
  });

  it('PM saved views + favorites round-trip through the crm facade (§9.4)', async () => {
    const { SavedViewsService } = await import('../modules/crm/saved-views.service');
    const { CrmPublicService } = await import('../modules/crm/public');
    const { PmViewsService } = await import('../modules/pm/views.service');
    const savedViewsSvc = new SavedViewsService(dbSvc, audit);
    const crmPublic = new CrmPublicService(null as never, null as never, null as never, savedViewsSvc);
    const viewsSvc = new PmViewsService(dbSvc, crmPublic, domainEventsSvc);

    const created = await viewsSvc.create(tenantId, ownerId, {
      object_type: 'pm_issue',
      name: `Urgent unassigned ${crypto.randomBytes(3).toString('hex')}`,
      filters: { prios: [1], assignee: 'unassigned' },
    });
    const viewId = (created.data as { id: string }).id;
    await viewsSvc.setFavorite(tenantId, ownerId, viewId, true);
    const list = await viewsSvc.list(tenantId, ownerId, 'pm_issue');
    expect((list.data.views as Array<{ id: string }>).some((v) => v.id === viewId)).toBe(true);
    expect(list.data.favorite_ids).toContain(viewId);
    await viewsSvc.setFavorite(tenantId, ownerId, viewId, false);
    const after = await viewsSvc.list(tenantId, ownerId, 'pm_issue');
    expect(after.data.favorite_ids).not.toContain(viewId);
    // Non-PM object types are refused at this surface.
    await expect(viewsSvc.create(tenantId, ownerId, { object_type: 'deal', name: 'x' })).rejects.toThrow(/pm_issue/);
  });

  it('state + label management respects the lead gate (§16)', async () => {
    // Employee (non-lead) is rejected; owner passes.
    const [emp] = await dbAdmin
      .insert(users)
      .values({ email: `pm-emp-${rid()}@t.test`, full_name: 'Emp E', status: 'active' })
      .returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: emp!.id, role: 'employee', status: 'active' });
    await expect(
      teamsSvc.upsertState(tenantId, emp!.id, 'employee', teamId, { name: 'QA', color: '#3E7BFA', category: 'started' }),
    ).rejects.toThrow(/lead/i);
    const created = await teamsSvc.upsertState(tenantId, ownerId, 'owner', teamId, { name: 'QA', color: '#3E7BFA', category: 'started' });
    expect(created.data.category).toBe('started');
    const label = await teamsSvc.upsertLabel(tenantId, ownerId, 'owner', { name: `feat-${rid()}`, color: '#27D280' });
    expect(label.data.id).toBeTruthy();
    await dbAdmin.delete(users).where(eq(users.id, emp!.id));
  });

  it('a cursor past the horizon triggers RE_BOOTSTRAP', async () => {
    const horizon = await syncSvc.minSeqHorizon();
    if (horizon > 0) {
      const res = await syncSvc.delta(tenantId, ownerId, horizon - 1);
      expect('reBootstrap' in res && res.reBootstrap).toBe(true);
    } else {
      // Fresh DB retains everything — horizon 0 means no cursor can be stale.
      expect(horizon).toBe(0);
    }
  });

  it('delta tombstones a vanished row and advances the cursor', async () => {
    const before = await syncSvc.latestSeq();
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Short-lived' })).data;
    // Simulate a hard delete under the row (delta re-fetch finds nothing).
    await dbAdmin.delete(pmIssues).where(eq(pmIssues.id, issue.id));
    const delta = await syncSvc.delta(tenantId, ownerId, before);
    if (!('upserts' in delta)) throw new Error('unexpected re-bootstrap');
    expect(delta.tombstones.pm_issues ?? []).toContain(issue.id);
    expect(delta.latest_seq).toBeGreaterThan(before);
  });
});

describe('Sprint 35 — search, detail, mentions, duplicate-close (§5.2, §10, §13)', () => {
  it('search: issue-key prefix, FTS full word, trigram partial word — private teams excluded', async () => {
    const { PmSearchService } = await import('../modules/pm/search.service');
    const searchSvc = new PmSearchService(dbSvc, visibility);
    const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.id, teamId));
    const pub = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Authentication flow hardening' })).data;
    const priv = (await issuesSvc.create(tenantId, ownerId, { team_id: privateTeamId, title: 'Authentication secret rotation' })).data;

    // 1. Key prefix — "KEY-N" resolves directly.
    const byKey = (await searchSvc.search(tenantId, ownerId, `${team!.key}-${pub.number}`)).data.issues;
    expect(byKey.some((i) => i.id === pub.id && i.match === 'key')).toBe(true);

    // 2. FTS — full word via websearch semantics.
    const byWord = (await searchSvc.search(tenantId, ownerId, 'authentication')).data.issues;
    expect(byWord.some((i) => i.id === pub.id)).toBe(true);

    // 3. Trigram/substring — partial words with NO FTS prefix match still hit,
    //    including the short-query-vs-long-title case ("auth").
    for (const partial of ['authen', 'auth']) {
      const byPartial = (await searchSvc.search(tenantId, ownerId, partial)).data.issues;
      expect(byPartial.some((i) => i.id === pub.id && i.match === 'trigram')).toBe(true);
    }

    // §16 — the outsider NEVER sees the private-team issue, on any path.
    for (const q of ['authentication', 'authen', `SEC-${priv.number}`]) {
      const hits = (await searchSvc.search(tenantId, outsiderId, q)).data.issues;
      expect(hits.some((i) => i.id === priv.id)).toBe(false);
    }
    // Owner (member) DOES see it — the filter is visibility, not blanket.
    const ownerHits = (await searchSvc.search(tenantId, ownerId, 'authentication')).data.issues;
    expect(ownerHits.some((i) => i.id === priv.id)).toBe(true);
  });

  it('comment @mention subscribes the mentioned member; unknown ids are ignored (§10)', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Mention target' })).data;
    await issuesSvc.createComment(tenantId, ownerId, issue.id, {
      body: 'Looping in @tester',
      mentioned_user_ids: [outsiderId, crypto.randomUUID()], // second id is not a member
    });
    const subs = await dbAdmin
      .select()
      .from(pmIssueSubscribers)
      .where(and(eq(pmIssueSubscribers.tenant_id, tenantId), eq(pmIssueSubscribers.issue_id, issue.id)));
    const ids = subs.map((s) => s.user_id);
    expect(ids).toContain(ownerId); // creator auto-subscribe
    expect(ids).toContain(outsiderId); // mention subscribe
    expect(ids).toHaveLength(2); // the bogus mention was dropped, not inserted
  });

  it('duplicate-close: relate duplicate_of moves the issue to Duplicate and stamps canceled_at (§5.1)', async () => {
    const dupe = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Dupe report' })).data;
    const canonical = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Canonical report' })).data;
    await issuesSvc.relate(tenantId, ownerId, dupe.id, { related_issue_id: canonical.id, type: 'duplicate_of' });
    const [after] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, dupe.id));
    expect(after!.canceled_at).not.toBeNull();
    const [state] = await dbAdmin.select().from(pmWorkflowStates).where(eq(pmWorkflowStates.id, after!.state_id));
    expect(state!.category).toBe('canceled');
    // The canonical issue is untouched.
    const [canon] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, canonical.id));
    expect(canon!.canceled_at).toBeNull();
  });

  it('detail returns the lazy bundle: comments, history, sub-issues, relations, subscribers (§3.3)', async () => {
    const parent = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Detail parent' })).data;
    const child = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Detail child', parent_issue_id: parent.id })).data;
    const other = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Detail blocker' })).data;
    await issuesSvc.relate(tenantId, ownerId, other.id, { related_issue_id: parent.id, type: 'blocks' });
    await issuesSvc.createComment(tenantId, ownerId, parent.id, { body: 'A detail comment' });
    await issuesSvc.setPriority(tenantId, ownerId, parent.id, 2); // history entries come from mutations, not create

    const detail = (await issuesSvc.detail(tenantId, ownerId, parent.id)).data;
    expect(detail.issue.id).toBe(parent.id);
    expect(detail.comments.map((c) => c.body)).toContain('A detail comment');
    expect(detail.sub_issues.map((c: { id: string }) => c.id)).toContain(child.id);
    expect(detail.relations.some((r) => r.issue_id === other.id && r.type === 'blocks')).toBe(true);
    expect(detail.subscriber_ids).toContain(ownerId);
    expect(detail.history.length).toBeGreaterThan(0); // create writes history

    // §16 — an outsider cannot fetch detail for a private-team issue.
    const priv = (await issuesSvc.create(tenantId, ownerId, { team_id: privateTeamId, title: 'Private detail' })).data;
    await expect(issuesSvc.detail(tenantId, outsiderId, priv.id)).rejects.toThrow();
  });
});

describe('Sprint 36 — projects, milestones, updates, initiatives (§6, §9.3)', () => {
  it('progress = estimate points with per-issue fallback 1; canceled excluded (§6.1)', async () => {
    const project = (await projectsSvc.create(tenantId, ownerId, { name: 'Progress math', team_ids: [teamId] })).data;
    const mk = async (title: string, estimate: number | null) =>
      (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title, estimate })).data;
    const a = await mk('P-a', 5); // will complete
    const b = await mk('P-b', 3); // will start
    const c = await mk('P-c', null); // weight 1, backlog
    const d = await mk('P-d', 8); // will cancel — excluded entirely
    for (const i of [a, b, c, d]) await issuesSvc.setProject(tenantId, ownerId, i.id, { project_id: project.id });
    const states = (await teamsSvc.list(tenantId, ownerId)).data.states.filter((s) => s.team_id === teamId);
    const done = states.find((s) => s.category === 'completed')!;
    const started = states.find((s) => s.category === 'started')!;
    const canceled = states.find((s) => s.category === 'canceled')!;
    await issuesSvc.moveState(tenantId, ownerId, a.id, done.id);
    await issuesSvc.moveState(tenantId, ownerId, b.id, started.id);
    await issuesSvc.moveState(tenantId, ownerId, d.id, canceled.id);
    const detail = (await projectsSvc.detail(tenantId, ownerId, project.id)).data;
    expect(detail.progress).toEqual({ scope: 9, started: 3, done: 5 }); // 5+3+1, canceled 8 gone
  });

  it('latest health wins: postUpdate denormalizes onto the project (§6.3)', async () => {
    const project = (await projectsSvc.create(tenantId, ownerId, { name: 'Health log', team_ids: [teamId] })).data;
    await projectsSvc.postUpdate(tenantId, ownerId, project.id, { health: 'at_risk', body_md: 'Migration slower than planned.' });
    await projectsSvc.postUpdate(tenantId, ownerId, project.id, { health: 'on_track', body_md: 'Unblocked — SSO fix landed.' });
    const [row] = await dbAdmin.select().from((await import('@flicks/db/schema')).pmProjects)
      .where(eq((await import('@flicks/db/schema')).pmProjects.id, project.id));
    expect(row!.health).toBe('on_track');
    const detail = (await projectsSvc.detail(tenantId, ownerId, project.id)).data;
    expect(detail.updates).toHaveLength(2);
    expect(detail.updates[0]!.health).toBe('on_track'); // newest first
  });

  it('milestones keep position order; delete nulls issue pointers via FK (§6.2)', async () => {
    const project = (await projectsSvc.create(tenantId, ownerId, { name: 'MS order', team_ids: [teamId] })).data;
    const m2 = (await projectsSvc.createMilestone(tenantId, ownerId, { project_id: project.id, name: 'UAT', position: 2 })).data;
    const m1 = (await projectsSvc.createMilestone(tenantId, ownerId, { project_id: project.id, name: 'Kickoff', position: 1 })).data;
    const detail = (await projectsSvc.detail(tenantId, ownerId, project.id)).data;
    expect(detail.milestones.map((m) => m.name)).toEqual(['Kickoff', 'UAT']);
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'On milestone' })).data;
    await issuesSvc.setProject(tenantId, ownerId, issue.id, { project_id: project.id, milestone_id: m1.id });
    await projectsSvc.deleteMilestone(tenantId, ownerId, m1.id);
    const [after] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, issue.id));
    expect(after!.milestone_id).toBeNull();
    expect(after!.project_id).toBe(project.id); // project link survives
    void m2;
  });

  it('multi-team visibility: private-only projects are invisible to non-members (§16)', async () => {
    const pub = (await projectsSvc.create(tenantId, ownerId, { name: 'Public project', team_ids: [teamId] })).data;
    const priv = (await projectsSvc.create(tenantId, ownerId, { name: 'Secret project', team_ids: [privateTeamId] })).data;
    const both = (await projectsSvc.create(tenantId, ownerId, { name: 'Spanning project', team_ids: [teamId, privateTeamId] })).data;
    const outsiderList = (await projectsSvc.list(tenantId, outsiderId)).data;
    const ids = outsiderList.projects.map((p) => p.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id); // ONLY private team → hidden
    expect(ids).toContain(both.id); // spans a visible team → visible
    await expect(projectsSvc.detail(tenantId, outsiderId, priv.id)).rejects.toThrow();
    // Delta path: private-only project rows never reach the outsider.
    const before = await syncSvc.latestSeq();
    await projectsSvc.postUpdate(tenantId, ownerId, priv.id, { health: 'off_track', body_md: 'secret' });
    const delta = await syncSvc.delta(tenantId, outsiderId, before);
    if (!('upserts' in delta)) throw new Error('unexpected re-bootstrap');
    const projRows = (delta.upserts.pm_projects ?? []) as Array<{ id: string }>;
    expect(projRows.some((r) => r.id === priv.id)).toBe(false);
    const updRows = (delta.upserts.pm_project_updates ?? []) as Array<{ project_id: string }>;
    expect(updRows.some((r) => r.project_id === priv.id)).toBe(false);
  });

  it('initiatives: role gate + project set round-trip through the executor', async () => {
    // Employee cannot create initiatives (§16 matrix).
    const empRes = await executor.execute(tenantId, outsiderId, [
      { clientMutationId: crypto.randomUUID(), op: 'initiative.create' as const, id: crypto.randomUUID(), fields: { name: 'Nope' } },
    ], 'employee');
    expect(empRes.results[0]!.status).toBe('rejected');
    // Owner path: create initiative + project + link them via executor ops.
    const initId = crypto.randomUUID();
    const projId = crypto.randomUUID();
    const res = await executor.execute(tenantId, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'initiative.create' as const, id: initId, fields: { name: 'Q3 · Reliability', target_quarter: 'Q3 2026' } },
      { clientMutationId: crypto.randomUUID(), op: 'project.create' as const, id: projId, fields: { name: 'Exec-made project', team_ids: [teamId] } },
      { clientMutationId: crypto.randomUUID(), op: 'initiative.set_projects' as const, id: initId, fields: { project_ids: [projId] } },
      { clientMutationId: crypto.randomUUID(), op: 'project.post_update' as const, id: projId, fields: { health: 'on_track', body_md: 'Exec update' } },
    ], 'owner');
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    const list = (await projectsSvc.listInitiatives(tenantId, ownerId)).data;
    expect(list.projects[initId]).toEqual([projId]);
    // Bootstrap now carries the projects layer.
    const lines = await syncSvc.bootstrap(tenantId, ownerId);
    const models = lines.map((l) => JSON.parse(l)).filter((o) => 'model' in o);
    const tables = new Set(models.map((m) => m.model));
    for (const t of ['pm_projects', 'pm_project_teams', 'pm_project_milestones', 'pm_project_updates', 'pm_initiatives', 'pm_initiative_projects']) {
      expect(tables.has(t)).toBe(true);
    }
  });
});

describe('Sprint 37 — cycles, Autopilot, snapshots, triage (§7/§8, fake-clock)', () => {
  const notifStub = { createInAppNotification: jest.fn().mockResolvedValue(undefined) };
  const cyclesSvc = new (require('../modules/pm/cycles.service').PmCyclesService)(
    dbSvc, dbAdmin as never, domainEventsSvc, notifStub as never, visibility,
  );
  let cycTeamId: string;

  beforeAll(async () => {
    const t = await teamsSvc.create(tenantId, ownerId, { key: 'CYC', name: 'Cycle Team' });
    cycTeamId = t.data.id;
    await teamsSvc.updateConfig(tenantId, ownerId, 'owner', cycTeamId, {
      cycles_enabled: true, cycle_length_weeks: 2, cooldown_days: 2, cycle_start_dow: 1,
      timezone: 'Europe/Berlin', upcoming_cycles: 2,
    });
  });

  it('sweep creates upcoming cycles at Berlin-midnight boundaries and activates on time', async () => {
    const t0 = new Date('2026-07-01T10:00:00Z'); // a Wednesday
    const r1 = await cyclesSvc.runCycleSweep(t0);
    expect(r1.created).toBeGreaterThanOrEqual(3); // want+1 windows
    const rows = await dbAdmin.select().from(pmCycles).where(eq(pmCycles.team_id, cycTeamId));
    expect(rows.map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // §17: boundary at BERLIN midnight — July = CEST (UTC+2) → 22:00 UTC.
    const first = rows.find((c) => c.number === 1)!;
    expect(first.starts_at.getUTCHours()).toBe(22);
    expect(first.starts_at.getUTCDay()).toBe(0); // Sunday 22:00 UTC = Monday 00:00 Berlin
    // Not yet started → still upcoming.
    expect(first.status).toBe('upcoming');
    // Advance past starts_at → activation.
    const r2 = await cyclesSvc.runCycleSweep(new Date(first.starts_at.getTime() + 3_600_000));
    expect(r2.activated).toBe(1);
    const [active] = await dbAdmin.select().from(pmCycles).where(and(eq(pmCycles.team_id, cycTeamId), eq(pmCycles.status, 'active')));
    expect(active!.number).toBe(1);
    // Snapshot taken for the active cycle on that local day; idempotent re-run.
    const r3 = await cyclesSvc.runCycleSweep(new Date(first.starts_at.getTime() + 2 * 3_600_000));
    expect(r3.snapshots).toBe(0); // same Berlin day — already snapped by r2
  });

  it('auto-add-started: starting an issue outside a cycle joins the active one (§7.1)', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: cycTeamId, title: 'Auto-add me', estimate: 3 })).data;
    expect(issue.cycle_id).toBeNull();
    const started = (await teamsSvc.list(tenantId, ownerId)).data.states.find((s) => s.team_id === cycTeamId && s.category === 'started')!;
    const moved = (await issuesSvc.moveState(tenantId, ownerId, issue.id, started.id)).data;
    expect(moved.cycle_id).not.toBeNull();
  });

  it('Autopilot: P1 rolls to the next cycle, P3 returns to backlog, digest EXACTLY once (§7.1)', async () => {
    const [active] = await dbAdmin.select().from(pmCycles).where(and(eq(pmCycles.team_id, cycTeamId), eq(pmCycles.status, 'active')));
    const p1 = (await issuesSvc.create(tenantId, ownerId, { team_id: cycTeamId, title: 'Urgent leftover', priority: 1, assignee_user_id: ownerId })).data;
    const p3 = (await issuesSvc.create(tenantId, ownerId, { team_id: cycTeamId, title: 'Medium leftover', priority: 3, assignee_user_id: outsiderId })).data;
    await issuesSvc.setCycle(tenantId, ownerId, p1.id, { cycle_id: active!.id });
    await issuesSvc.setCycle(tenantId, ownerId, p3.id, { cycle_id: active!.id });

    notifStub.createInAppNotification.mockClear();
    const afterEnd = new Date(active!.ends_at.getTime() + 3_600_000);
    await cyclesSvc.runCycleSweep(afterEnd);
    await cyclesSvc.runCycleSweep(afterEnd); // repeat — must be a no-op

    const [p1After] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, p1.id));
    const [p3After] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, p3.id));
    const [nextCycle] = await dbAdmin.select().from(pmCycles).where(and(eq(pmCycles.team_id, cycTeamId), eq(pmCycles.number, active!.number + 1)));
    expect(p1After!.cycle_id).toBe(nextCycle!.id); // urgent rolled forward
    expect(p3After!.cycle_id).toBeNull(); // medium returned to backlog
    // Digest went to lead + assignees of RETURNED issues, exactly once each.
    const digestCalls = notifStub.createInAppNotification.mock.calls.filter((c) => c[1] === 'pm.cycle.review');
    expect(digestCalls.length).toBeGreaterThanOrEqual(1);
    const recipients = digestCalls.map((c) => c[0]);
    expect(new Set(recipients).size).toBe(recipients.length); // no double sends
    expect(recipients).toContain(outsiderId); // returned issue's assignee
  });

  it('cooldown blocks activation until cooldown_ends_at (§7.2)', async () => {
    const cycles = await dbAdmin.select().from(pmCycles).where(eq(pmCycles.team_id, cycTeamId));
    const ended = cycles.find((c) => c.status === 'completed')!;
    const next = cycles.find((c) => c.number === ended.number + 1)!;
    // Inside the cooldown window (and force next to look startable).
    const inCooldown = new Date(ended.ends_at.getTime() + 3_600_000);
    await dbAdmin.update(pmCycles).set({ starts_at: inCooldown }).where(eq(pmCycles.id, next.id));
    await cyclesSvc.runCycleSweep(new Date(inCooldown.getTime() + 60_000));
    const [stillUpcoming] = await dbAdmin.select().from(pmCycles).where(eq(pmCycles.id, next.id));
    expect(stillUpcoming!.status).toBe('upcoming'); // §7.2 — blocked
    // After the cooldown passes → activates.
    await cyclesSvc.runCycleSweep(new Date(ended.cooldown_ends_at.getTime() + 60_000));
    const [nowActive] = await dbAdmin.select().from(pmCycles).where(eq(pmCycles.id, next.id));
    expect(nowActive!.status).toBe('active');
  });

  it('velocity matches hand-computed completed points (§7.3)', async () => {
    // Fabricate three completed cycles with known final snapshots.
    const mk = async (number: number, completed: number) => {
      const month = String(number - 100).padStart(2, '0'); // 101→01, 102→02, 103→03
      const [c] = await dbAdmin.insert(pmCycles).values({
        tenant_id: tenantId, team_id: cycTeamId, number,
        starts_at: new Date(`2026-${month}-01T00:00:00Z`), ends_at: new Date(`2026-${month}-14T00:00:00Z`),
        cooldown_ends_at: new Date(`2026-${month}-16T00:00:00Z`), status: 'completed',
      }).returning();
      await dbAdmin.insert(pmCycleSnapshots).values({
        tenant_id: tenantId, cycle_id: c!.id, snapshot_date: `2026-${month}-14`,
        scope_points: '24', started_points: '2', completed_points: String(completed),
      });
    };
    await mk(101, 17);
    await mk(102, 19);
    await mk(103, 22);
    const res = await cyclesSvc.teamCycles(tenantId, ownerId, cycTeamId);
    // Last 3 completed by number desc = 103, 102, 101 → mean 19.3.
    expect(res.data.stats.velocity).toBeCloseTo((22 + 19 + 17) / 3, 1);
  });

  it('sample pack: seed fills every surface, remove deletes EXACTLY those rows', async () => {
    const { PmSampleDataService } = require('../modules/pm/sample-data.service');
    const sampleSvc = new PmSampleDataService(dbSvc, audit, domainEventsSvc, issuesSvc);

    const before = await dbAdmin.select({ id: pmIssues.id }).from(pmIssues).where(eq(pmIssues.tenant_id, tenantId));
    const seeded = await sampleSvc.seed(tenantId, ownerId);
    expect(seeded.data.issues).toBe(24); // Appendix B
    expect(seeded.data.projects).toBe(2);
    // Second seed refuses.
    await expect(sampleSvc.seed(tenantId, ownerId)).rejects.toThrow(/already loaded/);

    // The pack lights up cycles + triage + review.
    const { pmProjects: projTable, pmInitiatives: initTable } = require('@flicks/db/schema');
    const projects = await dbAdmin.select().from(projTable).where(and(eq(projTable.tenant_id, tenantId), sql`${projTable.name} LIKE '%(sample)'`));
    expect(projects).toHaveLength(2);
    const cyclesRows = await dbAdmin.select().from(pmCycles).where(eq(pmCycles.tenant_id, tenantId));
    expect(cyclesRows.some((c) => c.status === 'completed')).toBe(true);
    expect(cyclesRows.some((c) => c.status === 'active')).toBe(true);
    const cyclesSvcRes = await cyclesSvc.teamCycles(tenantId, ownerId, teamId);
    expect(cyclesSvcRes.data.last_review).not.toBeNull();
    expect((cyclesSvcRes.data.last_review!.returned as unknown[]).length).toBeGreaterThan(0);
    const triageIssues = await dbAdmin
      .select({ id: pmIssues.id, state_id: pmIssues.state_id })
      .from(pmIssues)
      .where(and(eq(pmIssues.tenant_id, tenantId), sql`${pmIssues.title} LIKE '%(sample)'`));
    expect(triageIssues).toHaveLength(24);

    // Remove: exactly the pack — pre-existing rows untouched.
    const removed = await sampleSvc.remove(tenantId, ownerId);
    expect(removed.data.loaded).toBe(false);
    const leftSample = await dbAdmin
      .select({ id: pmIssues.id })
      .from(pmIssues)
      .where(and(eq(pmIssues.tenant_id, tenantId), sql`${pmIssues.title} LIKE '%(sample)'`));
    expect(leftSample).toHaveLength(0);
    const after = await dbAdmin.select({ id: pmIssues.id }).from(pmIssues).where(eq(pmIssues.tenant_id, tenantId));
    expect(after.length).toBe(before.length); // nothing user-made was touched
    const projectsAfter = await dbAdmin.select().from(projTable).where(and(eq(projTable.tenant_id, tenantId), sql`${projTable.name} LIKE '%(sample)'`));
    expect(projectsAfter).toHaveLength(0);
  });

  it('triage: entry rule, accept, decline, snooze, send-to-triage (§8)', async () => {
    // Entry rule — a NON-member creating in a public team lands in Triage.
    const t = await teamsSvc.create(tenantId, ownerId, { key: 'INT', name: 'Intake' });
    const intTeamId = t.data.id;
    await dbAdmin
      .delete(pmTeamMemberships)
      .where(and(eq(pmTeamMemberships.team_id, intTeamId), eq(pmTeamMemberships.user_id, outsiderId)));
    const intake = (await issuesSvc.create(tenantId, outsiderId, { team_id: intTeamId, title: 'From a non-member' })).data;
    const states = (await teamsSvc.list(tenantId, ownerId)).data.states.filter((s) => s.team_id === intTeamId);
    const stateCat = (id: string) => states.find((s) => s.id === id)?.category;
    expect(stateCat(intake.state_id)).toBe('triage');
    // A member's create still goes to backlog.
    const member = (await issuesSvc.create(tenantId, ownerId, { team_id: intTeamId, title: 'From a member' })).data;
    expect(stateCat(member.state_id)).toBe('backlog');

    // Snooze hides until due (server just stamps; conveyor filters client-side).
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const snoozed = (await issuesSvc.snooze(tenantId, ownerId, intake.id, until)).data;
    expect(snoozed.snoozed_until).not.toBeNull();

    // Accept → default backlog state + triaged_at + snooze cleared.
    const accepted = (await issuesSvc.triageAccept(tenantId, ownerId, intake.id, { priority: 2 })).data;
    expect(accepted.triaged_at).not.toBeNull();
    expect(accepted.snoozed_until).toBeNull();
    expect(accepted.priority).toBe(2);
    expect(stateCat(accepted.state_id)).toBe('backlog');

    // Send back to triage clears the stamps (§5.2).
    const back = (await issuesSvc.sendToTriage(tenantId, ownerId, intake.id)).data;
    expect(stateCat(back.state_id)).toBe('triage');
    expect(back.triaged_at).toBeNull();

    // Decline → canceled + canceled_at; reason lands in history.
    const declined = (await issuesSvc.triageDecline(tenantId, ownerId, intake.id, 'duplicate of roadmap work')).data;
    expect(stateCat(declined.state_id)).toBe('canceled');
    expect(declined.canceled_at).not.toBeNull();
    const history = await dbAdmin
      .select()
      .from(pmIssueHistory)
      .where(and(eq(pmIssueHistory.issue_id, intake.id), eq(pmIssueHistory.field, 'triage')));
    expect(history.some((h) => (h.to_value ?? '').includes('declined: duplicate of roadmap work'))).toBe(true);
  });
});

describe('Sprint 38 — Inbox, digesting, timesheet linkage (§11, §15.3)', () => {
  const cyclesStub = { runCycleSweep: jest.fn() };
  const pmJobs = new PmJobs(dbAdmin as never, notificationsSvc, cyclesStub as never);
  let inbTeamId: string;

  const rowsFor = (userId: string) =>
    dbAdmin.select().from(notifications).where(eq(notifications.user_id, userId));

  // notifyInbox is fire-and-forget — wait until the row lands (or timeout).
  const settle = async (pred: () => Promise<boolean>) => {
    for (let i = 0; i < 40; i++) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    const t = await teamsSvc.create(tenantId, ownerId, { key: 'INB', name: 'Inbox Team' });
    inbTeamId = t.data.id;
  });

  beforeEach(async () => {
    await dbAdmin.delete(notifications).where(inArray(notifications.user_id, [ownerId, outsiderId]));
    await dbAdmin
      .delete(notificationPreferences)
      .where(inArray(notificationPreferences.user_id, [ownerId, outsiderId]));
  });

  it('assignment notifies the assignee (never the actor) with a per-issue group key', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Wire the webhooks' })).data;
    await issuesSvc.assign(tenantId, ownerId, issue.id, outsiderId);
    await settle(async () => (await rowsFor(outsiderId)).length > 0);
    const rows = await rowsFor(outsiderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('pm.issue.assigned');
    expect(rows[0]!.group_key).toBe(`pm.issue:${issue.id}`);
    expect(rows[0]!.message).toContain('assigned to you');

    // Self-assign → silence.
    const mine = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Mine alone' })).data;
    await issuesSvc.assign(tenantId, ownerId, mine.id, ownerId);
    await new Promise((r) => setTimeout(r, 300));
    expect(await rowsFor(ownerId)).toHaveLength(0);
  });

  it('repeat activity collapses into ONE unread row with a climbing count (§11.3)', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Collapse target' })).data;
    await issuesSvc.assign(tenantId, ownerId, issue.id, outsiderId); // subscribes outsider
    await settle(async () => (await rowsFor(outsiderId)).length === 1);

    await issuesSvc.createComment(tenantId, ownerId, issue.id, { body: 'first pass done' });
    await settle(async () => (await rowsFor(outsiderId)).some((r) => r.group_count >= 2));
    await issuesSvc.createComment(tenantId, ownerId, issue.id, { body: 'second pass done' });
    await settle(async () => (await rowsFor(outsiderId)).some((r) => r.group_count >= 3));

    const rows = await rowsFor(outsiderId);
    expect(rows).toHaveLength(1); // one row per issue, not three
    expect(rows[0]!.group_count).toBe(3);
    expect(rows[0]!.type).toBe('pm.issue.comment'); // newest event wins the row
    expect(rows[0]!.read_at).toBeNull();

    // A READ row is history — the next event opens a fresh row.
    await notificationsSvc.markRead(rows[0]!.id, outsiderId);
    await issuesSvc.createComment(tenantId, ownerId, issue.id, { body: 'third pass' });
    await settle(async () => (await rowsFor(outsiderId)).length === 2);
    const after = await rowsFor(outsiderId);
    expect(after.filter((r) => r.read_at === null)).toHaveLength(1);
  });

  it('mention beats the ambient comment notice; in-app preference suppresses (§11.2)', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Mention me' })).data;
    await issuesSvc.createComment(tenantId, ownerId, issue.id, {
      body: 'ping @outsider',
      mentioned_user_ids: [outsiderId],
    });
    await settle(async () => (await rowsFor(outsiderId)).length > 0);
    const rows = await rowsFor(outsiderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('pm.issue.mention');

    // Turn OFF pm_comment in-app for outsider → ambient comment stays silent.
    await notificationsSvc.setPreference(outsiderId, 'pm_comment', 'in_app', false);
    await notificationsSvc.markRead(rows[0]!.id, outsiderId);
    const other = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Quiet one' })).data;
    await issuesSvc.assign(tenantId, ownerId, other.id, outsiderId);
    await settle(async () => (await rowsFor(outsiderId)).some((r) => r.type === 'pm.issue.assigned'));
    const before = (await rowsFor(outsiderId)).length;
    await issuesSvc.createComment(tenantId, ownerId, other.id, { body: 'ambient noise' });
    await new Promise((r) => setTimeout(r, 400));
    expect((await rowsFor(outsiderId)).length).toBe(before); // no new row, no bump
  });

  it('urgent email: 5-min unread-only, exactly once; reading first cancels it (§11.4)', async () => {
    const sendSpy = jest.spyOn(notificationsSvc, 'sendEmail').mockResolvedValue(true);
    try {
      const a = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Email me' })).data;
      const b = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Read first' })).data;
      await issuesSvc.assign(tenantId, ownerId, a.id, outsiderId);
      await issuesSvc.assign(tenantId, ownerId, b.id, outsiderId);
      await settle(async () => (await rowsFor(outsiderId)).length === 2);
      const rows = await rowsFor(outsiderId);
      const readOne = rows.find((r) => r.group_key === `pm.issue:${b.id}`)!;
      await notificationsSvc.markRead(readOne.id, outsiderId);

      // Not due yet (created "now", sweep at now) → nothing sends.
      expect(await pmJobs.runUrgentEmailSweep(new Date())).toBe(0);

      const later = new Date(Date.now() + 6 * 60_000);
      const sent = await pmJobs.runUrgentEmailSweep(later);
      expect(sent).toBe(1); // only the UNREAD one
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0]![0]).toBe('pm-inbox-urgent');

      // Exactly once — the second sweep is a no-op.
      expect(await pmJobs.runUrgentEmailSweep(later)).toBe(0);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('digest fold: hourly sends now, daily waits for 8am in the user tz (§11.4)', async () => {
    const sendSpy = jest.spyOn(notificationsSvc, 'sendEmail').mockResolvedValue(true);
    try {
      const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Fold me' })).data;
      await issuesSvc.assign(tenantId, ownerId, issue.id, outsiderId);
      await settle(async () => (await rowsFor(outsiderId)).length === 1);
      // Make it an AMBIENT row (comment), which the digest folds — and opt
      // the user IN to comment emails (the P10 default is in-app only).
      await dbAdmin
        .update(notifications)
        .set({ type: 'pm.issue.comment' })
        .where(eq(notifications.user_id, outsiderId));
      await notificationsSvc.setPreference(outsiderId, 'pm_comment', 'email', true);

      await notificationsSvc.setEmailDigestFreq(outsiderId, 'daily');
      // Default test-user tz is Asia/Kolkata; pick an instant that is NOT 8am IST.
      const notEight = new Date('2026-07-01T12:00:00Z'); // 17:30 IST
      expect(await pmJobs.runInboxDigestSweep(notEight)).toBe(0);

      await notificationsSvc.setEmailDigestFreq(outsiderId, 'hourly');
      const sent = await pmJobs.runInboxDigestSweep(new Date());
      expect(sent).toBe(1);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0]![0]).toBe('pm-inbox-digest');

      // Folded exactly once.
      expect(await pmJobs.runInboxDigestSweep(new Date())).toBe(0);

      // 'urgent' users never get a fold.
      await notificationsSvc.setEmailDigestFreq(outsiderId, 'urgent');
      await dbAdmin.update(notifications).set({ emailed_at: null }).where(eq(notifications.user_id, outsiderId));
      expect(await pmJobs.runInboxDigestSweep(new Date())).toBe(0);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('snooze hides until due, archive removes; getInbox and getUnread agree (§11.5)', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: inbTeamId, title: 'Snooze me' })).data;
    await issuesSvc.assign(tenantId, ownerId, issue.id, outsiderId);
    await settle(async () => (await rowsFor(outsiderId)).length === 1);
    const [row] = await rowsFor(outsiderId);

    await notificationsSvc.snooze(row!.id, outsiderId, new Date(Date.now() + 3_600_000));
    let inbox = await notificationsSvc.getInbox(outsiderId, { scope: 'pm' });
    expect(inbox.items).toHaveLength(0);
    expect(inbox.snoozed).toHaveLength(1);
    expect((await notificationsSvc.getUnread(outsiderId)).total).toBe(0);

    // Snooze elapses → the row reappears.
    await dbAdmin
      .update(notifications)
      .set({ snoozed_until: new Date(Date.now() - 60_000) })
      .where(eq(notifications.id, row!.id));
    inbox = await notificationsSvc.getInbox(outsiderId, { scope: 'pm' });
    expect(inbox.items).toHaveLength(1);
    expect((await notificationsSvc.getUnread(outsiderId)).total).toBe(1);

    await notificationsSvc.archive(row!.id, outsiderId);
    inbox = await notificationsSvc.getInbox(outsiderId, { scope: 'pm' });
    expect(inbox.items).toHaveLength(0);
    expect((await notificationsSvc.getUnread(outsiderId)).total).toBe(0);
    const [archived] = await rowsFor(outsiderId);
    expect(archived!.archived_at).not.toBeNull();
    expect(archived!.read_at).not.toBeNull(); // archive implies read
  });

  it('timesheet ↔ PM FKs are attached AND validated (0045 §15.3)', async () => {
    const [projectFk] = await dbAdmin.execute(
      sql`SELECT convalidated FROM pg_constraint WHERE conname = 'timesheet_entries_project_id_fkey'`,
    );
    const [taskFk] = await dbAdmin.execute(
      sql`SELECT convalidated FROM pg_constraint WHERE conname = 'timesheet_entries_task_id_fkey'`,
    );
    expect(projectFk?.convalidated).toBe(true);
    expect(taskFk?.convalidated).toBe(true);
  });
});
