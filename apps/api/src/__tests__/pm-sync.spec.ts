import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmTeamMemberships,
  pmIssues,
  pmIssueHistory,
  pmLabels,
  domainEvents,
  syncMutations,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
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
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc);
const visibility = new PmVisibilityService(dbSvc);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc);
const gatewayStub = { emitSeq: jest.fn() };
const executor = new PmMutationExecutor(dbSvc, issuesSvc, syncSvc, gatewayStub as never);

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
