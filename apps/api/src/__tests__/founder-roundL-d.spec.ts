/**
 * Founder round L (2026-09-17) — agent D: PM issue relations (item 5), the
 * issue-open latency work (item 7), the origin-aware navigation (item 8) and
 * the Phase-2 attachment wiring (item 6 integration).
 *
 *  Item 5 — POST pm/issues/:id/unrelate exists (REST twin of the sync op);
 *           relate/unrelate write a `relation` history line on BOTH issues
 *           holding the other issue's ID (`type:<uuid>`), which detail()
 *           resolves to KEY-N through the reader's visibility (or `hidden`);
 *           the other issue's assignee gets a best-effort inbox notice worded
 *           from their side only; self-relate is refused; a repeat relate is
 *           a no-op; every DTO-supplied id (relation end, parent) is NotFound
 *           when foreign, invisible (private team / project, guest scope) or
 *           deleted — never a 403; detail() enriches relations with the
 *           OTHER issue and hides invisible ends, parents and sub-issues;
 *           bootstrap ships both directions deduped by id and never a row
 *           whose other end the user can't see; delta ships the inverse
 *           direction; parent_issue_id is validated (self, cycle, foreign,
 *           private) and rides the sync executor.
 *  Item 7 — detail() ships the newest 50 comments + comments_total +
 *           has_earlier, history capped at 20; GET pm/issues/:id/comments
 *           pages back with the (created_at ms, id) keyset; the private-
 *           project 404 is unchanged.
 *  Item 6 — create/update/createComment clean markdown, bind own live
 *           drafts (another user's ⇒ 400), attachment-only comments are
 *           accepted, detail().files lists the issue's + comments' files.
 *
 * Service-level against the real Postgres (pm-sync harness; R2 stubbed).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmTeamMemberships,
  pmIssues,
  pmIssueHistory,
  pmIssueRelations,
  pmIssueComments,
  pmProjects,
  pmProjectMembers,
  recordFiles,
  domainEvents,
  notifications,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ForbiddenException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmFilesService } from '../modules/pm/files.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmMutationExecutor } from '../modules/pm/sync/mutation-executor.service';
import { PmController } from '../modules/pm/pm.controller';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const media = { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never;

const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, media);
// REAL NotificationsService — the relation notice is asserted on inbox rows.
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, new ConfigService(), emitter);
// R2 stubbed (no storage in CI) — signing is a pure function of the key.
const r2 = {
  isConfigured: () => true,
  putObject: jest.fn(async () => undefined),
  signedGetUrl: jest.fn(async (key: string, ttl?: number) => `https://signed.test/${key}?ttl=${ttl}`),
  deleteObjects: jest.fn(async () => undefined),
  deleteObject: jest.fn(async () => undefined),
};
const filesSvc = new PmFilesService(dbSvc, dbAdmin as never, visibility, r2 as never, audit);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility, filesSvc);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility, media);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc, media);
const executor = new PmMutationExecutor(dbSvc, issuesSvc, projectsSvc, syncSvc, { emitSeq: jest.fn() } as never);
// The controller with only the issues service wired — enough to drive the
// two new routes exactly the way Nest would.
const controller = new PmController(
  null as never, issuesSvc, null as never, null as never, null as never, null as never,
  null as never, null as never, null as never, null as never, null as never, null as never,
);

/** notifyInbox is fire-and-forget by design (house rule 6) — poll. */
async function settle(pred: () => Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('settle timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}

const historyOf = (issueId: string, field: string) =>
  dbAdmin
    .select()
    .from(pmIssueHistory)
    .where(and(eq(pmIssueHistory.issue_id, issueId), eq(pmIssueHistory.field, field)))
    .orderBy(asc(pmIssueHistory.created_at));

const csv = (tag = rid()) => Buffer.from(`name,qty\n${tag},1\n`);
const draft = async (userId: string, tenant = T1) =>
  (await filesSvc.upload(tenant, userId, {
    objectType: 'draft',
    objectId: crypto.randomUUID(),
    kind: 'attachment',
    files: [{ buffer: csv(), originalname: `d-${rid()}.csv` }],
  })).data[0]!;

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string;
let T2: string;
let ownerId: string;
let memberId: string; // employee seat — public teams only, NOT in SEC
let guestId: string; // project-scoped seat on projectG1 only
let t2OwnerId: string;
let teamA: { id: string; key: string };
let teamB: { id: string; key: string };
let teamQ: { id: string; key: string };
let secTeamId: string;
let projectG1: string; // the guest's project
let projectG2: string; // another project, not the guest's
let t2TeamId: string;
const userIds: string[] = [];
const jwt = (sub: string, tenantId: string, role: string) => ({ sub, tenantId, role }) as never;

async function mkUser(label: string, tenantId: string, role: 'owner' | 'employee' | 'guest') {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rl-${label}-${rid()}@t.test`, full_name: `${label} Tester`, status: 'active' })
    .returning();
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' });
  userIds.push(u!.id);
  return u!.id;
}

const mkIssue = (teamId: string, title: string, userId = ownerId, extra: Record<string, unknown> = {}) =>
  issuesSvc.create(T1, userId, { team_id: teamId, title, ...extra }).then((r) => r.data);

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RL Relations ${rid()}`, slug: `rl-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T1 = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `RL Other ${rid()}`, slug: `rl2-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T2 = t2!.id;
  ownerId = await mkUser('owner', T1, 'owner');
  memberId = await mkUser('member', T1, 'employee');
  guestId = await mkUser('guest', T1, 'guest');
  t2OwnerId = await mkUser('zed', T2, 'owner');

  await teamsSvc.ensureWorkspace(T1, ownerId);
  const [a] = await dbAdmin.select({ id: pmTeams.id, key: pmTeams.key }).from(pmTeams).where(eq(pmTeams.tenant_id, T1));
  teamA = a!;
  const b = await teamsSvc.create(T1, ownerId, { key: 'OPS', name: 'Operations' });
  teamB = { id: b.data.id, key: 'OPS' };
  const q = await teamsSvc.create(T1, ownerId, { key: 'QA', name: 'Quality' });
  teamQ = { id: q.data.id, key: 'QA' };
  const sec = await teamsSvc.create(T1, ownerId, { key: 'SEC', name: 'Secret', is_private: true });
  secTeamId = sec.data.id;
  for (const uid of [memberId, guestId]) {
    await dbAdmin
      .delete(pmTeamMemberships)
      .where(and(eq(pmTeamMemberships.team_id, secTeamId), eq(pmTeamMemberships.user_id, uid)));
  }
  projectG1 = (await projectsSvc.create(T1, ownerId, { name: 'Guest project', team_ids: [teamA.id] })).data.id;
  projectG2 = (await projectsSvc.create(T1, ownerId, { name: 'Other project', team_ids: [teamA.id] })).data.id;
  await dbAdmin.insert(pmProjectMembers).values({ tenant_id: T1, project_id: projectG1, user_id: guestId });

  await teamsSvc.ensureWorkspace(T2, t2OwnerId);
  t2TeamId = (await dbAdmin.select({ id: pmTeams.id }).from(pmTeams).where(eq(pmTeams.tenant_id, T2)))[0]!.id;
});

afterAll(async () => {
  for (const t of [T1, T2]) {
    await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, t));
    await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  }
  if (userIds.length) await dbAdmin.delete(users).where(inArray(users.id, userIds));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 5 — relations
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — item 5: relate / unrelate (route, history on both sides, inbox notice)', () => {
  it('POST pm/issues/:id/unrelate and GET pm/issues/:id/comments are registered on the controller', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PmController.prototype.unrelate)).toBe('issues/:id/unrelate');
    expect(Reflect.getMetadata(METHOD_METADATA, PmController.prototype.unrelate)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, PmController.prototype.listComments)).toBe('issues/:id/comments');
    expect(Reflect.getMetadata(METHOD_METADATA, PmController.prototype.listComments)).toBe(RequestMethod.GET);
  });

  it('relate stores `relation` history on BOTH issues as ids, detail() resolves them to KEY-N; refuses self; ignores a repeat', async () => {
    const a1 = await mkIssue(teamA.id, 'Blocker');
    const a2 = await mkIssue(teamA.id, 'Blocked');
    await expect(
      issuesSvc.relate(T1, ownerId, a1.id, { related_issue_id: a1.id, type: 'blocks' }),
    ).rejects.toThrow(BadRequestException);

    const first = await issuesSvc.relate(T1, ownerId, a1.id, { related_issue_id: a2.id, type: 'blocks' });
    expect((first.data as { id?: string }).id).toBeTruthy();
    // Stored: the OTHER issue's id, never its key (finding D).
    const mine = await historyOf(a1.id, 'relation');
    const theirs = await historyOf(a2.id, 'relation');
    expect(mine.map((h) => [h.from_value, h.to_value])).toEqual([[null, `blocks:${a2.id}`]]);
    expect(theirs.map((h) => [h.from_value, h.to_value])).toEqual([[null, `blocked_by:${a1.id}`]]);
    expect(mine[0]!.actor_user_id).toBe(ownerId);
    // Read: resolved through the reader's visibility.
    const d1 = (await issuesSvc.detail(T1, ownerId, a1.id)).data;
    const line = d1.history.find((h) => h.field === 'relation')!;
    expect(line.to_value).toBe(`blocks:${teamA.key}-${a2.number}`);
    expect(line.to_ref).toEqual({ id: a2.id, key: `${teamA.key}-${a2.number}`, title: 'Blocked' });
    expect(line.from_ref).toBeNull();
    const d2 = (await issuesSvc.detail(T1, memberId, a2.id)).data;
    expect(d2.history.find((h) => h.field === 'relation')!.to_value).toBe(`blocked_by:${teamA.key}-${a1.number}`);
    expect(d2.team_key).toBe(teamA.key);

    // Repeat: the unique index swallows it — no second row, no second line.
    const again = await issuesSvc.relate(T1, ownerId, a1.id, { related_issue_id: a2.id, type: 'blocks' });
    expect((again.data as { id?: string }).id).toBeUndefined();
    expect(await historyOf(a1.id, 'relation')).toHaveLength(1);
    expect(await historyOf(a2.id, 'relation')).toHaveLength(1);
    const rows = await dbAdmin
      .select()
      .from(pmIssueRelations)
      .where(and(eq(pmIssueRelations.tenant_id, T1), eq(pmIssueRelations.issue_id, a1.id)));
    expect(rows).toHaveLength(1);
  });

  it('unrelate through the REST route removes the row and writes the unlink on BOTH sides; a miss is a no-op', async () => {
    const a1 = await mkIssue(teamA.id, 'Unlink me');
    const b1 = await mkIssue(teamB.id, 'Ops twin');
    await issuesSvc.relate(T1, ownerId, a1.id, { related_issue_id: b1.id, type: 'relates_to' });

    const res = await controller.unrelate(jwt(ownerId, T1, 'owner'), a1.id, { related_issue_id: b1.id, type: 'relates_to' });
    expect(res.data).toEqual({ issue_id: a1.id, removed: 1 });
    const left = await dbAdmin
      .select()
      .from(pmIssueRelations)
      .where(and(eq(pmIssueRelations.tenant_id, T1), eq(pmIssueRelations.issue_id, a1.id)));
    expect(left).toHaveLength(0);
    const mine = await historyOf(a1.id, 'relation');
    const theirs = await historyOf(b1.id, 'relation');
    expect(mine.map((h) => [h.from_value, h.to_value])).toEqual([
      [null, `relates_to:${b1.id}`],
      [`relates_to:${b1.id}`, null],
    ]);
    expect(theirs.map((h) => [h.from_value, h.to_value])).toEqual([
      [null, `relates_to:${a1.id}`],
      [`relates_to:${a1.id}`, null],
    ]);
    const resolved = (await issuesSvc.detail(T1, ownerId, a1.id)).data.history.filter((h) => h.field === 'relation');
    expect(resolved.map((h) => [h.from_value, h.to_value])).toEqual([
      [`relates_to:OPS-${b1.number}`, null],
      [null, `relates_to:OPS-${b1.number}`],
    ]);

    // Nothing there any more → quiet, no extra history.
    const miss = await controller.unrelate(jwt(ownerId, T1, 'owner'), a1.id, { related_issue_id: b1.id, type: 'relates_to' });
    expect(miss.data).toEqual({ issue_id: a1.id, removed: 0 });
    expect(await historyOf(a1.id, 'relation')).toHaveLength(2);
    await expect(
      controller.unrelate(jwt(ownerId, T1, 'owner'), a1.id, { related_issue_id: b1.id, type: 'nope' as never }),
    ).rejects.toThrow(BadRequestException);
    // "Blocked by X" is stored on X — removing it is unrelate(X, me).
    await issuesSvc.relate(T1, ownerId, b1.id, { related_issue_id: a1.id, type: 'blocks' });
    const viaOther = await issuesSvc.unrelate(T1, ownerId, b1.id, a1.id, 'blocks');
    expect(viaOther.data.removed).toBe(1);
    const a1Hist = await historyOf(a1.id, 'relation');
    expect(a1Hist[a1Hist.length - 1]!.from_value).toBe(`blocked_by:${b1.id}`);
  });

  it("the OTHER issue's assignee gets one `pm.issue.related` inbox row worded from their side — never the actor, never the current issue's key", async () => {
    await dbAdmin.delete(notifications).where(eq(notifications.user_id, memberId));
    const a1 = await mkIssue(teamA.id, 'Notice source');
    const a2 = await mkIssue(teamA.id, 'Notice target');
    await issuesSvc.assign(T1, ownerId, a2.id, memberId);
    await settle(async () => (await dbAdmin.select().from(notifications).where(eq(notifications.user_id, memberId))).length >= 1);
    await dbAdmin.delete(notifications).where(eq(notifications.user_id, memberId)); // drop the assign notice

    await issuesSvc.relate(T1, ownerId, a1.id, { related_issue_id: a2.id, type: 'blocks' });
    await settle(async () =>
      (await dbAdmin.select().from(notifications).where(eq(notifications.user_id, memberId))).some((n) => n.type === 'pm.issue.related'),
    );
    const rows = await dbAdmin.select().from(notifications).where(eq(notifications.user_id, memberId));
    const notice = rows.find((n) => n.type === 'pm.issue.related')!;
    expect(notice.message).toBe(`${teamA.key}-${a2.number} has a new blocker — Notice target`);
    expect(notice.message).not.toContain(`-${a1.number} `);
    expect(notice.message).not.toContain('Notice source');
    expect(notice.link_url).toBe(`/pm/issues/${a2.id}`);
    expect(notice.group_key).toBe(`pm.issue:${a2.id}`);
    expect(notice.tenant_id).toBe(T1);
    // The actor's own issue assignee (the owner) hears nothing.
    await new Promise((r) => setTimeout(r, 300));
    const ownerRows = await dbAdmin.select().from(notifications).where(and(eq(notifications.user_id, ownerId), eq(notifications.type, 'pm.issue.related')));
    expect(ownerRows).toHaveLength(0);
  });

  it('DTO-supplied ids are NotFound when foreign, invisible (private team, private project, guest scope) or unknown — never 403', async () => {
    const a1 = await mkIssue(teamA.id, 'Public side');
    const s1 = await mkIssue(secTeamId, 'Secret side');
    const z1 = (await issuesSvc.create(T2, t2OwnerId, { team_id: t2TeamId, title: 'Other tenant' })).data;
    const priv = (await projectsSvc.create(T1, ownerId, { name: 'Members only', team_ids: [teamA.id] })).data;
    await dbAdmin.update(pmProjects).set({ is_private: true }).where(eq(pmProjects.id, priv.id));
    const p1 = await mkIssue(teamA.id, 'In the private project', ownerId, { project_id: priv.id });

    // Relation target.
    for (const target of [s1.id, z1.id, p1.id, crypto.randomUUID(), 'not-a-uuid']) {
      await expect(
        issuesSvc.relate(T1, memberId, a1.id, { related_issue_id: target, type: 'relates_to' }),
      ).rejects.toThrow(NotFoundException);
    }
    expect(await historyOf(a1.id, 'relation')).toHaveLength(0);
    // Parent.
    for (const target of [s1.id, z1.id, p1.id, crypto.randomUUID()]) {
      await expect(issuesSvc.update(T1, memberId, a1.id, { parent_issue_id: target })).rejects.toThrow(NotFoundException);
      await expect(mkIssue(teamA.id, 'Child of hidden', memberId, { parent_issue_id: target })).rejects.toThrow(NotFoundException);
    }
    // A foreign-tenant id as the URL id: relate / unrelate / detail / comments page.
    await expect(issuesSvc.relate(T1, ownerId, z1.id, { related_issue_id: a1.id, type: 'relates_to' })).rejects.toThrow(NotFoundException);
    await expect(issuesSvc.unrelate(T1, ownerId, z1.id, a1.id, 'relates_to')).rejects.toThrow(NotFoundException);
    await expect(issuesSvc.detail(T1, ownerId, z1.id)).rejects.toThrow(NotFoundException);
    await expect(issuesSvc.listComments(T1, ownerId, z1.id, {})).rejects.toThrow(NotFoundException);
    // …and a foreign id as the relation target of a T1 issue by the T1 owner.
    await expect(issuesSvc.relate(T1, ownerId, a1.id, { related_issue_id: z1.id, type: 'blocks' })).rejects.toThrow(NotFoundException);
    const foreignRows = await dbAdmin.select().from(pmIssueRelations).where(eq(pmIssueRelations.related_issue_id, z1.id));
    expect(foreignRows).toHaveLength(0);
  });

  it('a guest cannot relate/unrelate across projects, and a cross-project relation never reaches them (detail, bootstrap, delta)', async () => {
    const g1 = await mkIssue(teamA.id, 'Guest can see', ownerId, { project_id: projectG1 });
    const g2 = await mkIssue(teamA.id, 'Guest cannot see', ownerId, { project_id: projectG2 });
    await expect(
      issuesSvc.relate(T1, guestId, g1.id, { related_issue_id: g2.id, type: 'relates_to' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      issuesSvc.relate(T1, guestId, g2.id, { related_issue_id: g1.id, type: 'relates_to' }),
    ).rejects.toThrow(NotFoundException);

    const before = await syncSvc.latestSeq(T1);
    const rel = (await issuesSvc.relate(T1, ownerId, g1.id, { related_issue_id: g2.id, type: 'blocks' })).data as { id: string };
    await expect(issuesSvc.unrelate(T1, guestId, g1.id, g2.id, 'blocks')).rejects.toThrow(NotFoundException);
    const [still] = await dbAdmin.select().from(pmIssueRelations).where(eq(pmIssueRelations.id, rel.id));
    expect(still).toBeDefined();

    const asGuest = (await issuesSvc.detail(T1, guestId, g1.id)).data;
    expect(asGuest.relations).toEqual([]);
    expect(asGuest.history.find((h) => h.field === 'relation')!.to_value).toBe('blocks:hidden');
    expect(JSON.stringify(asGuest)).not.toContain(g2.id);
    expect(JSON.stringify(asGuest)).not.toContain('Guest cannot see');
    const lines = (await syncSvc.bootstrap(T1, guestId)).join('\n');
    expect(lines).toContain(g1.id);
    expect(lines).not.toContain(rel.id);
    expect(lines).not.toContain(g2.id);
    const delta = await syncSvc.delta(T1, guestId, before);
    if (!('upserts' in delta)) throw new Error('unexpected re-bootstrap');
    expect(JSON.stringify(delta)).not.toContain(rel.id);
    expect(JSON.stringify(delta)).not.toContain(g2.id);
    // A guest CAN link inside their own project.
    const g3 = await mkIssue(teamA.id, 'Also in the guest project', ownerId, { project_id: projectG1 });
    const ok = await issuesSvc.relate(T1, guestId, g1.id, { related_issue_id: g3.id, type: 'relates_to' });
    expect((ok.data as { id?: string }).id).toBeTruthy();
    expect((await issuesSvc.unrelate(T1, guestId, g1.id, g3.id, 'relates_to')).data.removed).toBe(1);
  });
});

describe('Round L — item 5: detail() enrichment + visibility', () => {
  it('related_issue carries the OTHER issue (team_key is the other team’s) on both pages; team_key is the issue’s own', async () => {
    const a1 = await mkIssue(teamA.id, 'Cross-team A');
    const b1 = await mkIssue(teamB.id, 'Cross-team B');
    await issuesSvc.relate(T1, ownerId, a1.id, { related_issue_id: b1.id, type: 'relates_to' });

    const fromA = (await issuesSvc.detail(T1, ownerId, a1.id)).data;
    expect(fromA.team_key).toBe(teamA.key);
    expect(fromA.relations).toHaveLength(1);
    expect(fromA.relations[0]!.related_issue).toMatchObject({ id: b1.id, number: b1.number, title: 'Cross-team B', team_id: teamB.id, team_key: 'OPS', state_id: b1.state_id, completed_at: null, canceled_at: null });
    expect(fromA.relations[0]!.issue_id).toBe(a1.id);

    const fromB = (await issuesSvc.detail(T1, memberId, b1.id)).data;
    expect(fromB.team_key).toBe('OPS');
    expect(fromB.relations).toHaveLength(1);
    expect(fromB.relations[0]!.related_issue).toMatchObject({ id: a1.id, number: a1.number, team_key: teamA.key });
    expect(fromB.relations[0]!.related_issue_id).toBe(b1.id); // stored direction untouched
    expect(fromB.parent_issue).toBeNull();
  });

  it('a relation whose other end lives in a private team is hidden from a non-member (detail, history, bootstrap, delta); unrelate of it is NotFound', async () => {
    const a3 = await mkIssue(teamA.id, 'Half visible');
    const s1 = await mkIssue(secTeamId, 'Hidden end');
    // Cursor AFTER both creates (so no create-tombstone names the secret
    // id) and BEFORE the link, so the delta below carries the relate event.
    const before = await syncSvc.latestSeq(T1);
    const rel = (await issuesSvc.relate(T1, ownerId, a3.id, { related_issue_id: s1.id, type: 'blocks' })).data as { id: string };

    const asOwner = (await issuesSvc.detail(T1, ownerId, a3.id)).data;
    expect(asOwner.relations.map((r) => r.related_issue.id)).toEqual([s1.id]);
    expect(asOwner.history.find((h) => h.field === 'relation')!.to_value).toBe(`blocks:SEC-${s1.number}`);
    const asMember = (await issuesSvc.detail(T1, memberId, a3.id)).data;
    expect(asMember.relations).toEqual([]);
    const memberLine = asMember.history.find((h) => h.field === 'relation')!;
    expect(memberLine.to_value).toBe('blocks:hidden');
    expect(memberLine.to_ref).toBeNull();
    const memberDump = JSON.stringify(asMember);
    expect(memberDump).not.toContain('SEC-');
    expect(memberDump).not.toContain(s1.id);
    expect(memberDump).not.toContain('Hidden end');
    // The URL id in a private team: the team rule answers 403 (unchanged), never the row.
    await expect(issuesSvc.detail(T1, memberId, s1.id)).rejects.toThrow(ForbiddenException);
    // The member cannot unlink what they cannot see.
    await expect(issuesSvc.unrelate(T1, memberId, a3.id, s1.id, 'blocks')).rejects.toThrow(NotFoundException);

    const memberLines = (await syncSvc.bootstrap(T1, memberId)).join('\n');
    expect(memberLines).not.toContain(rel.id);
    expect(memberLines).not.toContain(s1.id);
    const ownerLines = (await syncSvc.bootstrap(T1, ownerId)).join('\n');
    expect(ownerLines.split(rel.id).length - 1).toBe(1);

    // Delta: the relate event touches both issues; the member's re-fetch
    // must not carry the row (nor a tombstone that names the secret id).
    const memberDelta = await syncSvc.delta(T1, memberId, before);
    if (!('upserts' in memberDelta)) throw new Error('unexpected re-bootstrap');
    const memberRel = (memberDelta.upserts.pm_issue_relations ?? []) as Array<{ id: string }>;
    expect(memberRel.some((r) => r.id === rel.id)).toBe(false);
    expect(JSON.stringify(memberDelta)).not.toContain(s1.id);
    const ownerDelta = await syncSvc.delta(T1, ownerId, before);
    if (!('upserts' in ownerDelta)) throw new Error('unexpected re-bootstrap');
    expect(((ownerDelta.upserts.pm_issue_relations ?? []) as Array<{ id: string }>).some((r) => r.id === rel.id)).toBe(true);
  });

  it('parent_issue and sub_issues follow the reader’s visibility (private team parent, private-project child)', async () => {
    const pub = await mkIssue(teamA.id, 'Public child');
    const secretParent = await mkIssue(secTeamId, 'Secret parent');
    await issuesSvc.update(T1, ownerId, pub.id, { parent_issue_id: secretParent.id });
    const ownerView = (await issuesSvc.detail(T1, ownerId, pub.id)).data;
    expect(ownerView.parent_issue).toEqual({ id: secretParent.id, number: secretParent.number, title: 'Secret parent', team_id: secTeamId, team_key: 'SEC' });
    expect(ownerView.history.find((h) => h.field === 'parent')!.to_value).toBe(`SEC-${secretParent.number}`);
    const memberView = (await issuesSvc.detail(T1, memberId, pub.id)).data;
    expect(memberView.parent_issue).toBeNull();
    expect(memberView.history.find((h) => h.field === 'parent')!.to_value).toBe('hidden');
    expect(JSON.stringify(memberView)).not.toContain('SEC-');
    expect(JSON.stringify(memberView)).not.toContain('Secret parent');
    // A soft-deleted parent is not shown either.
    const gone = await mkIssue(teamA.id, 'Soon deleted');
    const kid = await mkIssue(teamA.id, 'Orphaned', ownerId, { parent_issue_id: gone.id });
    await issuesSvc.softDelete(T1, ownerId, gone.id);
    expect((await issuesSvc.detail(T1, ownerId, kid.id)).data.parent_issue).toBeNull();

    // A child inside a private project never surfaces on a public parent.
    const priv = (await projectsSvc.create(T1, ownerId, { name: 'Private kids', team_ids: [teamA.id] })).data;
    await dbAdmin.update(pmProjects).set({ is_private: true }).where(eq(pmProjects.id, priv.id));
    const parent = await mkIssue(teamA.id, 'Public parent');
    const openKid = await mkIssue(teamA.id, 'Open kid', ownerId, { parent_issue_id: parent.id });
    const privKid = await mkIssue(teamA.id, 'Private kid', ownerId, { parent_issue_id: parent.id, project_id: priv.id });
    expect((await issuesSvc.detail(T1, ownerId, parent.id)).data.sub_issues.map((s) => s.id).sort()).toEqual([openKid.id, privKid.id].sort());
    const memberKids = (await issuesSvc.detail(T1, memberId, parent.id)).data;
    expect(memberKids.sub_issues.map((s) => s.id)).toEqual([openKid.id]);
    expect(memberKids.sub_issues[0]).toMatchObject({ team_id: teamA.id, team_key: teamA.key });
    expect(JSON.stringify(memberKids)).not.toContain('Private kid');
  });

  it('bootstrap ships a cross-team relation ONCE (both buckets reach it) and delta ships the inverse direction', async () => {
    const q1 = await mkIssue(teamQ.id, 'QA blocker');
    const a2 = await mkIssue(teamA.id, 'Blocked by QA');
    const rel = (await issuesSvc.relate(T1, ownerId, q1.id, { related_issue_id: a2.id, type: 'blocks' })).data as { id: string };

    const lines = await syncSvc.bootstrap(T1, memberId);
    const relRows = lines
      .map((l) => JSON.parse(l) as { model?: string; rows?: Array<{ id: string; issue_id: string; related_issue_id: string; type: string }> })
      .filter((o) => o.model === 'pm_issue_relations')
      .flatMap((o) => o.rows ?? []);
    const hits = relRows.filter((r) => r.id === rel.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ issue_id: q1.id, related_issue_id: a2.id, type: 'blocks' });
    // Every shipped row has both ends in the shipped issue set.
    const issueIds = new Set(
      lines
        .map((l) => JSON.parse(l) as { model?: string; rows?: Array<{ id: string }> })
        .filter((o) => o.model === 'pm_issues')
        .flatMap((o) => (o.rows ?? []).map((r) => r.id)),
    );
    for (const r of relRows) {
      expect(issueIds.has(r.issue_id)).toBe(true);
      expect(issueIds.has(r.related_issue_id)).toBe(true);
    }

    // A ref naming only the RELATED side (a2) must still bring the row —
    // the old forward-only query (issue_id IN scope) returned nothing here.
    const before = await syncSvc.latestSeq(T1);
    await domainEventsSvc.publish({
      name: 'pm.issue.related',
      tenantId: T1,
      actorUserId: ownerId,
      payload: { issue_id: a2.id, sync: [{ t: 'pm_issue_relations', id: a2.id }] },
    });
    const delta = await syncSvc.delta(T1, memberId, before);
    if (!('upserts' in delta)) throw new Error('unexpected re-bootstrap');
    const rows = (delta.upserts.pm_issue_relations ?? []) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain(rel.id);
    expect((delta.upserts as Record<string, unknown>)['pm_issue_relations__scope']).toEqual([a2.id]);
  });
});

describe('Round L — item 5: parent_issue_id', () => {
  it('self and cycle are refused (400); a valid parent writes `parent` history as ids that detail() resolves; null clears', async () => {
    const a1 = await mkIssue(teamA.id, 'Parent');
    const a2 = await mkIssue(teamA.id, 'Child');
    const a3 = await mkIssue(teamA.id, 'Grandchild');

    await expect(issuesSvc.update(T1, ownerId, a2.id, { parent_issue_id: a2.id })).rejects.toThrow(/own parent/);
    const set = (await issuesSvc.update(T1, ownerId, a2.id, { parent_issue_id: a1.id })).data;
    expect(set.parent_issue_id).toBe(a1.id);
    await issuesSvc.update(T1, ownerId, a3.id, { parent_issue_id: a2.id });
    // a1 → a2 → a3 → a1 would loop.
    await expect(issuesSvc.update(T1, ownerId, a1.id, { parent_issue_id: a3.id })).rejects.toThrow(/cycle/);
    await expect(issuesSvc.update(T1, ownerId, a1.id, { parent_issue_id: a2.id })).rejects.toThrow(BadRequestException);
    const [a1Row] = await dbAdmin.select({ parent: pmIssues.parent_issue_id }).from(pmIssues).where(eq(pmIssues.id, a1.id));
    expect(a1Row!.parent).toBeNull();

    // Unchanged value → no history line; clearing → id → null.
    await issuesSvc.update(T1, ownerId, a2.id, { parent_issue_id: a1.id });
    const cleared = (await issuesSvc.update(T1, ownerId, a2.id, { parent_issue_id: null })).data;
    expect(cleared.parent_issue_id).toBeNull();
    const hist = await historyOf(a2.id, 'parent');
    expect(hist.map((h) => [h.from_value, h.to_value])).toEqual([
      [null, a1.id],
      [a1.id, null],
    ]);
    const resolved = (await issuesSvc.detail(T1, ownerId, a2.id)).data.history.filter((h) => h.field === 'parent');
    expect(resolved.map((h) => [h.from_value, h.to_value])).toEqual([
      [`${teamA.key}-${a1.number}`, null],
      [null, `${teamA.key}-${a1.number}`],
    ]);
    expect(resolved[0]!.from_ref).toEqual({ id: a1.id, key: `${teamA.key}-${a1.number}`, title: 'Parent' });
    // detail() names the parent for the rail.
    await issuesSvc.update(T1, ownerId, a3.id, { parent_issue_id: a1.id });
    const d = (await issuesSvc.detail(T1, ownerId, a3.id)).data;
    expect(d.parent_issue).toEqual({ id: a1.id, number: a1.number, title: 'Parent', team_id: teamA.id, team_key: teamA.key });
    expect((await issuesSvc.detail(T1, ownerId, a1.id)).data.sub_issues.map((s: { id: string }) => s.id)).toEqual([a3.id]);
  });

  it('create honours parent_issue_id (in-tenant + visible) and the sync executor forwards it on update', async () => {
    const a1 = await mkIssue(teamA.id, 'Root');
    const child = await mkIssue(teamA.id, 'Born under', ownerId, { parent_issue_id: a1.id });
    expect(child.parent_issue_id).toBe(a1.id);
    await expect(mkIssue(teamA.id, 'Bad parent', ownerId, { parent_issue_id: crypto.randomUUID() })).rejects.toThrow(NotFoundException);
    // Sub-issues inherit assignee + priority from the parent at create (§5.2) — unchanged.
    await issuesSvc.setPriority(T1, ownerId, a1.id, 2);
    const inherits = await mkIssue(teamA.id, 'Inherits', ownerId, { parent_issue_id: a1.id });
    expect(inherits.priority).toBe(2);

    const other = await mkIssue(teamA.id, 'Executor-parented');
    const res = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'issue.update' as const, id: other.id, fields: { parent_issue_id: a1.id } },
      { clientMutationId: crypto.randomUUID(), op: 'issue.update' as const, id: a1.id, fields: { parent_issue_id: other.id } }, // cycle
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'rejected']);
    expect(res.results[1]!.errorCode).toMatch(/^E400/);
    const [row] = await dbAdmin.select({ parent: pmIssues.parent_issue_id }).from(pmIssues).where(eq(pmIssues.id, other.id));
    expect(row!.parent).toBe(a1.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 7 — detail payload size + the comments page
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — item 7: detail() caps and comments paging', () => {
  let issueId: string;
  const bodies = Array.from({ length: 60 }, (_, i) => `comment #${i + 1}`);

  beforeAll(async () => {
    issueId = (await mkIssue(teamA.id, 'Busy thread')).id;
    const base = Date.now() - 60 * 60_000;
    await dbAdmin.insert(pmIssueComments).values(
      bodies.map((body, i) => ({
        tenant_id: T1,
        issue_id: issueId,
        author_user_id: ownerId,
        body,
        // Pairs share a millisecond (#1/#2, #3/#4, …) so the keyset tiebreak is exercised.
        created_at: new Date(base + Math.floor(i / 2) * 1000 + (i % 2) * 300),
      })),
    );
    // History: 25 priority hops → more than the 20 the page ships.
    for (let i = 0; i < 25; i++) await issuesSvc.setPriority(T1, ownerId, issueId, (i % 4) + 1);
  });

  it('ships the NEWEST 50 comments ascending with comments_total / has_earlier, and at most 20 history rows', async () => {
    const d = (await issuesSvc.detail(T1, ownerId, issueId)).data;
    expect(d.comments).toHaveLength(50);
    expect(d.comments_total).toBe(60);
    expect(d.has_earlier).toBe(true);
    expect(d.comments[49]!.body).toBe('comment #60');
    for (let i = 1; i < d.comments.length; i++) {
      expect(d.comments[i - 1]!.created_at.getTime()).toBeLessThanOrEqual(d.comments[i]!.created_at.getTime());
    }
    expect(d.history).toHaveLength(20);
    expect(d.history[0]!.created_at.getTime()).toBeGreaterThanOrEqual(d.history[19]!.created_at.getTime()); // newest first
  });

  it('GET pm/issues/:id/comments pages back on the (created_at ms, id) keyset without skipping or repeating; limit is clamped 1..100', async () => {
    const d = (await issuesSvc.detail(T1, ownerId, issueId)).data;
    const seen = new Set(d.comments.map((c) => c.id));
    // Walk back in pages of 3 until exhausted; the union must be exactly the 60 rows.
    let cursor = { before: d.comments[0]!.created_at.toISOString(), before_id: d.comments[0]!.id };
    let guard = 0;
    for (;;) {
      const page = (await controller.listComments(jwt(ownerId, T1, 'owner'), issueId, cursor.before, cursor.before_id, '3')).data;
      expect(page.comments.length).toBeLessThanOrEqual(3);
      for (const c of page.comments) {
        expect(seen.has(c.id)).toBe(false); // never repeats
        seen.add(c.id);
      }
      if (!page.has_earlier) {
        expect(page.comments.length).toBeLessThanOrEqual(3);
        break;
      }
      cursor = { before: page.comments[0]!.created_at.toISOString(), before_id: page.comments[0]!.id };
      if (++guard > 30) throw new Error('paging did not terminate');
    }
    expect(seen.size).toBe(60); // never skips (the shared-millisecond pairs included)

    const all = (await issuesSvc.listComments(T1, ownerId, issueId, { limit: 500 })).data;
    expect(all.comments).toHaveLength(60);
    expect(all.has_earlier).toBe(false);
    expect(all.comments.map((c) => c.body)).toEqual(bodies);
    await expect(issuesSvc.listComments(T1, ownerId, issueId, { before: 'not-a-date' })).rejects.toThrow(BadRequestException);
    await expect(issuesSvc.listComments(T1, ownerId, issueId, { before: new Date().toISOString(), before_id: 'nope' })).rejects.toThrow(BadRequestException);
    // Visibility rides the same load: the member sees the public thread, nobody sees a foreign id.
    expect((await issuesSvc.listComments(T1, memberId, issueId, { limit: 5 })).data.comments).toHaveLength(5);
    await expect(issuesSvc.listComments(T1, memberId, crypto.randomUUID(), {})).rejects.toThrow(NotFoundException);
  });

  it('the private-project 404 is unchanged: a non-member reads NotFound from detail() and the comments page; a relation into it stays hidden everywhere', async () => {
    const project = (await projectsSvc.create(T1, ownerId, { name: 'Private room', team_ids: [teamA.id] })).data;
    await dbAdmin.update(pmProjects).set({ is_private: true }).where(eq(pmProjects.id, project.id));
    const hidden = await mkIssue(teamA.id, 'Behind the door', ownerId, { project_id: project.id });
    await expect(issuesSvc.detail(T1, memberId, hidden.id)).rejects.toThrow(NotFoundException);
    await expect(issuesSvc.listComments(T1, memberId, hidden.id, {})).rejects.toThrow(NotFoundException);
    expect((await issuesSvc.detail(T1, ownerId, hidden.id)).data.issue.id).toBe(hidden.id);
    // …and a relation pointing INTO the private project is hidden from them too.
    const open = await mkIssue(teamA.id, 'Outside the door');
    const before = await syncSvc.latestSeq(T1);
    const rel = (await issuesSvc.relate(T1, ownerId, open.id, { related_issue_id: hidden.id, type: 'relates_to' })).data as { id: string };
    expect((await issuesSvc.detail(T1, memberId, open.id)).data.relations).toEqual([]);
    expect((await issuesSvc.detail(T1, ownerId, open.id)).data.relations.map((r) => r.related_issue.id)).toEqual([hidden.id]);
    const lines = (await syncSvc.bootstrap(T1, memberId)).join('\n');
    expect(lines).toContain(open.id);
    expect(lines).not.toContain(rel.id);
    expect(lines).not.toContain(hidden.id);
    const delta = await syncSvc.delta(T1, memberId, before);
    if (!('upserts' in delta)) throw new Error('unexpected re-bootstrap');
    expect(JSON.stringify(delta)).not.toContain(rel.id);
    expect(JSON.stringify(delta)).not.toContain(hidden.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 6 (Phase 2 wiring) — attachments + markdown cleaning
// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — item 6: attachment_ids bind own drafts, bodies are cleaned', () => {
  const fileId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

  it('create with attachment_ids binds the caller’s drafts; another user’s draft fails the whole create (400); detail().files lists them', async () => {
    const mine = await draft(ownerId);
    const theirs = await draft(memberId);
    await expect(
      mkIssue(teamA.id, 'Steals a draft', ownerId, { attachment_ids: [mine.id, theirs.id] }),
    ).rejects.toThrow(BadRequestException);
    const [untouched] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, mine.id));
    expect(untouched!.object_type).toBe('draft'); // the tx rolled back
    const stolen = await dbAdmin.select({ id: pmIssues.id }).from(pmIssues).where(and(eq(pmIssues.tenant_id, T1), eq(pmIssues.title, 'Steals a draft')));
    expect(stolen).toHaveLength(0);

    const issue = await mkIssue(teamA.id, 'With files', ownerId, {
      description: `hello <img src=x onerror=alert(1)> world\n\n![shot](flicks-file://${fileId.toUpperCase()}) [x](javascript:alert(1))`,
      attachment_ids: [mine.id],
    });
    expect(issue.description).toBe(`hello  world\n\n![shot](flicks-file://${fileId}) x`);
    const [bound] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, mine.id));
    expect(bound!.object_type).toBe('issue');
    expect(bound!.object_id).toBe(issue.id);
    const d = (await issuesSvc.detail(T1, ownerId, issue.id)).data;
    expect(d.files.map((f) => f.id)).toEqual([mine.id]);
    expect(d.files[0]).toMatchObject({ object_type: 'issue', object_id: issue.id, kind: 'attachment', mime_type: 'text/csv', uploaded_by: ownerId });
    expect(d.files[0]!.url).toMatch(/^https:\/\/signed\.test\//);

    // update(): clean + bind (the description edit's inline images).
    const inline = await draft(ownerId);
    const upd = (await issuesSvc.update(T1, ownerId, issue.id, {
      description: '<script>alert(1)</script>kept `<b>` ![a](http://evil.test/x.png)',
      attachment_ids: [inline.id],
    })).data;
    expect(upd.description).toBe('kept `<b>` a');
    expect((await issuesSvc.detail(T1, ownerId, issue.id)).data.files.map((f) => f.id).sort()).toEqual([mine.id, inline.id].sort());
    await expect(issuesSvc.update(T1, ownerId, issue.id, { description: 'x'.repeat(50_001) })).rejects.toThrow(/too long/);
    // '' stores as null.
    expect((await issuesSvc.update(T1, ownerId, issue.id, { description: '' })).data.description).toBeNull();
    // The sync executor forwards attachment_ids on create and update (spread fields).
    const viaExec = await draft(ownerId);
    const execId = crypto.randomUUID();
    const res = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'issue.create' as const, id: execId, fields: { team_id: teamA.id, title: 'Exec files', attachment_ids: [viaExec.id] } },
      { clientMutationId: crypto.randomUUID(), op: 'issue.update' as const, id: execId, fields: { attachment_ids: [theirs.id] } },
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'rejected']);
    expect((await issuesSvc.detail(T1, ownerId, execId)).data.files.map((f) => f.id)).toEqual([viaExec.id]);
  });

  it('comments: cleaned body, attachment-only comment accepted (body ""), empty comment with nothing attached rejected, files listed under the issue', async () => {
    const issue = await mkIssue(teamA.id, 'Comment files');
    await expect(issuesSvc.createComment(T1, ownerId, issue.id, { body: '   ' })).rejects.toThrow(BadRequestException);
    await expect(issuesSvc.createComment(T1, ownerId, issue.id, { body: '<img src=x onerror=alert(1)>' })).rejects.toThrow(BadRequestException);

    const attachment = await draft(memberId);
    const only = (await issuesSvc.createComment(T1, memberId, issue.id, { body: '', attachment_ids: [attachment.id] })).data;
    expect(only.body).toBe('');
    const [row] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, attachment.id));
    expect(row!.object_type).toBe('comment');
    expect(row!.object_id).toBe(only.id);

    const cleaned = (await issuesSvc.createComment(T1, ownerId, issue.id, {
      body: `see <script>alert(1)</script>this ![p](flicks-file://${fileId})`,
    })).data;
    expect(cleaned.body).toBe(`see this ![p](flicks-file://${fileId})`);
    await expect(
      issuesSvc.createComment(T1, ownerId, issue.id, { body: 'x'.repeat(10_001) }),
    ).rejects.toThrow(/too long/);
    // Someone else's draft on my comment → 400, nothing written.
    const foreignDraft = await draft(memberId);
    await expect(
      issuesSvc.createComment(T1, ownerId, issue.id, { body: 'mine?', attachment_ids: [foreignDraft.id] }),
    ).rejects.toThrow(BadRequestException);
    const comments = await dbAdmin.select().from(pmIssueComments).where(eq(pmIssueComments.issue_id, issue.id));
    expect(comments).toHaveLength(2);

    const d = (await issuesSvc.detail(T1, ownerId, issue.id)).data;
    expect(d.files.map((f) => f.id)).toEqual([attachment.id]);
    expect(d.files[0]!.object_type).toBe('comment');
    expect(d.comments_total).toBe(2);
    // The executor's comment.create forwards attachment_ids.
    const execDraft = await draft(ownerId);
    const cid = crypto.randomUUID();
    const res = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'comment.create' as const, id: cid, fields: { issue_id: issue.id, body: '', attachment_ids: [execDraft.id] } },
    ]);
    expect(res.results[0]!.status).toBe('applied');
    const [execRow] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, execDraft.id));
    expect(execRow).toMatchObject({ object_type: 'comment', object_id: cid });
  });

  it('deleting an issue soft-deletes its own and its comments’ files in the same tx and removes the objects after commit', async () => {
    const onIssue = await draft(ownerId);
    const onComment = await draft(ownerId);
    const issue = await mkIssue(teamA.id, 'Goes with its files', ownerId, { attachment_ids: [onIssue.id] });
    await issuesSvc.createComment(T1, ownerId, issue.id, { body: 'with a file', attachment_ids: [onComment.id] });
    const untouched = await draft(ownerId); // someone's live draft is not touched
    const spy = jest.spyOn(filesSvc, 'deleteObjectsAfterCommit');
    try {
      const res = await issuesSvc.softDelete(T1, ownerId, issue.id);
      expect(res.data.deleted_at).not.toBeNull();
      const rows = await dbAdmin
        .select({ id: recordFiles.id, deleted_at: recordFiles.deleted_at, storage_key: recordFiles.storage_key })
        .from(recordFiles)
        .where(inArray(recordFiles.id, [onIssue.id, onComment.id, untouched.id]));
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(onIssue.id)!.deleted_at).not.toBeNull();
      expect(byId.get(onComment.id)!.deleted_at).not.toBeNull();
      expect(byId.get(untouched.id)!.deleted_at).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const keys = spy.mock.calls[0]![0];
      expect(keys).toEqual(expect.arrayContaining([byId.get(onIssue.id)!.storage_key, byId.get(onComment.id)!.storage_key]));
      expect(keys).not.toContain(byId.get(untouched.id)!.storage_key);
      // Deleted files fall out of the (owner's) listing; the issue itself is gone from detail.
      await expect(issuesSvc.detail(T1, ownerId, issue.id)).rejects.toThrow(NotFoundException);
      // An issue with no files: the hook is a no-op (never called with an empty list).
      spy.mockClear();
      const bare = await mkIssue(teamA.id, 'No files');
      await issuesSvc.softDelete(T1, ownerId, bare.id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
