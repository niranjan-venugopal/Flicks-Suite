/**
 * Founder round M (2026-09-17) — agent C: project priority, Linear-style
 * project updates (snapshot at write, diff at read) and the update bell.
 *
 *  Priority — pm_projects.priority on the issue scale (0 none · 1 urgent · 2
 *           high · 3 medium · 4 low): the DTOs reject 7 / -1, the service
 *           re-checks the sync door, PATCH persists it, list() and the sync
 *           bootstrap projection carry it, the executor's project.create /
 *           project.update forward it.
 *  Updates — postUpdate stores a PmUpdateSnapshot (progress, issues_done,
 *           props, per-milestone scope/done/pct/completed_at) in the same tx;
 *           detail() attaches `diff` per update (props that changed, milestones
 *           whose pct moved, issues completed since) against the next-older
 *           snapshotted update, or the project baseline for the first one;
 *           legacy rows (snapshot null) get diff null and are skipped as
 *           "previous"; the REST response keeps `data` and adds `update` +
 *           `project`; the executor acks with both rows so the optimistic
 *           client row is replaced immediately.
 *  Bell    — members ∪ lead (never the author) get ONE grouped
 *           `pm.project.update_posted` inbox row per project; a second update
 *           bumps it; the `pm_project_update` in-app preference silences it;
 *           the `pm.project.update_posted` domain event rides alongside
 *           `pm.project.health_updated`.
 *
 * Service-level against the real Postgres (pm-sync harness; media stubbed).
 */
import 'dotenv/config';
import 'reflect-metadata';
import * as crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmWorkflowStates,
  pmIssues,
  pmProjects,
  pmProjectMembers,
  pmProjectUpdates,
  domainEvents,
  notifications,
  notificationPreferences,
} from '@flicks/db/schema';
import { DOMAIN_EVENTS } from '@flicks/shared/constants';
import { diffProjectUpdate, type PmUpdateSnapshot } from '@flicks/shared/pm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, HttpException } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmMutationExecutor } from '../modules/pm/sync/mutation-executor.service';
import { CreateProjectDto, PostUpdateDto, UpdateProjectDto } from '../modules/pm/pm.controller';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const media = { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never;

const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, media);
// REAL NotificationsService — the bell is asserted on actual inbox rows.
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, new ConfigService(), emitter);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
// Round M — the notifications service is the LAST, optional constructor arg.
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility, media, notificationsSvc);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc, media);
const executor = new PmMutationExecutor(dbSvc, issuesSvc, projectsSvc, syncSvc, { emitSeq: jest.fn() } as never);

/** The bell fan-out is detached post-commit (house rule 6) — poll for it. */
async function settle(pred: () => Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('settle timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsFor = (userId: string, type = 'pm.project.update_posted') =>
  dbAdmin.select().from(notifications).where(and(eq(notifications.user_id, userId), eq(notifications.type, type)));

const validate = <T extends object>(cls: new () => T, plain: Record<string, unknown>) =>
  validateSync(plainToInstance(cls, plain));

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string;
let ownerId: string; // the author of every update
let leadId: string;
let memberId: string;
let quietId: string; // member with pm_project_update in-app OFF
let teamId: string;
let completedStateId: string;
let canceledStateId: string;
const userIds: string[] = [];

async function mkUser(label: string, role: 'owner' | 'employee' | 'guest', tenantId = T1) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rm-${label}-${rid()}@t.test`, full_name: `${label} Tester`, status: 'active' })
    .returning();
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' });
  userIds.push(u!.id);
  return u!.id;
}

/** Assert a rejected service call is a clean Nest HttpException with the given status and message. */
async function expectHttp(p: Promise<unknown>, status: number, message: string | RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  expect((err as HttpException).getStatus()).toBe(status);
  if (typeof message === 'string') expect((err as HttpException).message).toBe(message);
  else expect((err as HttpException).message).toMatch(message);
}

const mkIssue = (title: string, extra: Record<string, unknown> = {}) =>
  issuesSvc.create(T1, ownerId, { team_id: teamId, title, ...extra }).then((r) => r.data);

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RM Updates ${rid()}`, slug: `rm-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T1 = t!.id;
  ownerId = await mkUser('owner', 'owner');
  leadId = await mkUser('lead', 'employee');
  memberId = await mkUser('member', 'employee');
  quietId = await mkUser('quiet', 'employee');

  await teamsSvc.ensureWorkspace(T1, ownerId);
  const [team] = await dbAdmin.select({ id: pmTeams.id }).from(pmTeams).where(eq(pmTeams.tenant_id, T1));
  teamId = team!.id;
  const states = await dbAdmin.select().from(pmWorkflowStates).where(eq(pmWorkflowStates.team_id, teamId));
  completedStateId = states.find((s) => s.category === 'completed')!.id;
  canceledStateId = states.find((s) => s.category === 'canceled')!.id;
});

afterAll(async () => {
  if (userIds.length) {
    await dbAdmin.delete(notifications).where(inArray(notifications.user_id, userIds));
    await dbAdmin.delete(notificationPreferences).where(inArray(notificationPreferences.user_id, userIds));
  }
  await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, T1));
  await dbAdmin.delete(tenants).where(eq(tenants.id, T1));
  if (userIds.length) await dbAdmin.delete(users).where(inArray(users.id, userIds));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Priority
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M — project priority (issue scale 0..4)', () => {
  it('the DTOs reject 7 and -1, accept 0..4 (coercing numeric strings); PostUpdateDto body_md allows 20 000 chars', () => {
    for (const bad of [7, -1, 1.5, 'urgent']) {
      expect(validate(CreateProjectDto, { name: 'x', priority: bad }).map((e) => e.property)).toEqual(['priority']);
      expect(validate(UpdateProjectDto, { priority: bad }).map((e) => e.property)).toEqual(['priority']);
    }
    for (const ok of [0, 1, 2, 3, 4, '3']) {
      expect(validate(CreateProjectDto, { name: 'x', priority: ok })).toHaveLength(0);
      expect(validate(UpdateProjectDto, { priority: ok })).toHaveLength(0);
    }
    expect(validate(CreateProjectDto, { name: 'x' })).toHaveLength(0); // optional
    const coerced = plainToInstance(UpdateProjectDto, { priority: '2' });
    expect(coerced.priority).toBe(2);
    expect(validate(PostUpdateDto, { health: 'on_track', body_md: 'x'.repeat(20_000) })).toHaveLength(0);
    expect(validate(PostUpdateDto, { health: 'on_track', body_md: 'x'.repeat(20_001) }).map((e) => e.property)).toEqual(['body_md']);
  });

  it('create defaults to 0 and honours an explicit value; PATCH persists it; list() and the sync projection carry it', async () => {
    const plain = (await projectsSvc.create(T1, ownerId, { name: 'No priority', team_ids: [teamId] })).data;
    expect(plain.priority).toBe(0);
    const urgent = (await projectsSvc.create(T1, ownerId, { name: 'Urgent one', team_ids: [teamId], priority: 1 })).data;
    expect(urgent.priority).toBe(1);

    const patched = (await projectsSvc.update(T1, ownerId, plain.id, { priority: 3 })).data;
    expect(patched.priority).toBe(3);
    const [row] = await dbAdmin.select({ priority: pmProjects.priority }).from(pmProjects).where(eq(pmProjects.id, plain.id));
    expect(row!.priority).toBe(3);

    const listed = (await projectsSvc.list(T1, ownerId)).data.projects.find((p) => p.id === plain.id)!;
    expect(listed.priority).toBe(3);
    const detail = (await projectsSvc.detail(T1, ownerId, plain.id)).data;
    expect(detail.project.priority).toBe(3);

    const lines = await syncSvc.bootstrap(T1, ownerId);
    const projected = lines
      .map((l) => JSON.parse(l) as { model?: string; rows?: Array<{ id: string; priority?: number }> })
      .filter((o) => o.model === 'pm_projects')
      .flatMap((o) => o.rows ?? [])
      .find((r) => r.id === plain.id)!;
    expect(projected.priority).toBe(3);
  });

  it('the sync door re-validates: executor project.create / project.update forward priority, out-of-range is rejected (E400)', async () => {
    const projId = crypto.randomUUID();
    const res = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'project.create' as const, id: projId, fields: { name: 'Exec low', team_ids: [teamId], priority: 4 } },
      { clientMutationId: crypto.randomUUID(), op: 'project.update' as const, id: projId, fields: { priority: 2 } },
      { clientMutationId: crypto.randomUUID(), op: 'project.update' as const, id: projId, fields: { priority: -1 } },
      { clientMutationId: crypto.randomUUID(), op: 'project.update' as const, id: projId, fields: { priority: 1.5 } },
    ], 'owner');
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'applied', 'rejected', 'rejected']);
    expect((res.results[0]!.rows!.pm_projects![0] as { priority: number }).priority).toBe(4);
    expect((res.results[1]!.rows!.pm_projects![0] as { priority: number }).priority).toBe(2);
    expect(res.results[2]!.errorCode).toMatch(/^E400/);
    const [row] = await dbAdmin.select({ priority: pmProjects.priority }).from(pmProjects).where(eq(pmProjects.id, projId));
    expect(row!.priority).toBe(2); // the rejected items rolled back alone

    await expect(projectsSvc.update(T1, ownerId, projId, { priority: 9 })).rejects.toThrow(BadRequestException);
    await expect(projectsSvc.create(T1, ownerId, { name: 'Bad', team_ids: [teamId], priority: 5 })).rejects.toThrow(BadRequestException);
    // `priority: null` — the DTO's @IsOptional lets null through (so this is
    // the service's call): the column is NOT NULL, so a PATCH to null is a
    // clear 400 rather than a silent skip or a 500 from the constraint, and
    // a create with null simply takes the default (0, "No priority").
    expect(validate(UpdateProjectDto, { priority: null })).toHaveLength(0);
    await expect(projectsSvc.update(T1, ownerId, projId, { priority: null })).rejects.toThrow(/priority must be an integer/);
    expect((await projectsSvc.create(T1, ownerId, { name: 'Null prio', team_ids: [teamId], priority: null as unknown as number })).data.priority).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 + 3. Snapshot at write, diff at read
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M — update snapshots + read-time diffs', () => {
  let projectId: string;
  let projectCreatedAt: Date;
  let milestoneId: string;
  let legacyId: string;
  let first: Awaited<ReturnType<PmProjectsService['postUpdate']>>;

  beforeAll(async () => {
    const p = (await projectsSvc.create(T1, ownerId, { name: 'Diffed project', team_ids: [teamId] })).data;
    projectId = p.id;
    projectCreatedAt = p.created_at;
    // A pre-0064 row: no snapshot, older than everything posted below.
    const [legacy] = await dbAdmin
      .insert(pmProjectUpdates)
      .values({
        tenant_id: T1, project_id: projectId, health: 'on_track', body_md: 'legacy', author_user_id: ownerId,
        created_at: new Date(Date.now() - 60 * 60_000),
      })
      .returning();
    legacyId = legacy!.id;

    await projectsSvc.update(T1, ownerId, projectId, { priority: 1, lead_user_id: leadId, target_date: '2026-10-30' });
    milestoneId = (await projectsSvc.createMilestone(T1, ownerId, { project_id: projectId, name: 'Beta' })).data.id;
    const m1 = await mkIssue('MS one', { project_id: projectId, milestone_id: milestoneId });
    const m2 = await mkIssue('MS two', { project_id: projectId, milestone_id: milestoneId });
    const m3 = await mkIssue('MS canceled', { project_id: projectId, milestone_id: milestoneId });
    const loose = await mkIssue('Loose done', { project_id: projectId });
    await mkIssue('Loose open', { project_id: projectId });
    for (const i of [m1, m2, loose]) await issuesSvc.moveState(T1, ownerId, i.id, completedStateId);
    await issuesSvc.moveState(T1, ownerId, m3.id, canceledStateId);
  });

  it('postUpdate stores the snapshot in the same tx and returns {data, update, project}', async () => {
    first = await projectsSvc.postUpdate(T1, ownerId, projectId, { health: 'at_risk', body_md: 'First real update' });
    expect(first.update).toBe(first.data);
    expect(first.update.id).toBe(first.data.id);
    const snap = first.data.snapshot as PmUpdateSnapshot;
    expect(snap).toMatchObject({
      v: 1,
      at: first.data.created_at.toISOString(),
      progress: { scope: 4, started: 0, done: 3 }, // the canceled issue is out of scope
      issues_done: 3,
      props: { status: 'planned', priority: 1, lead_user_id: leadId, start_date: null, target_date: '2026-10-30', health: 'at_risk' },
    });
    expect(snap.milestones).toHaveLength(1);
    expect(snap.milestones[0]).toMatchObject({ id: milestoneId, name: 'Beta', target_date: null, scope: 2, done: 2, pct: 1 });
    expect(snap.milestones[0]!.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The project row rides along (health denormalized, logo signed — never the raw key).
    expect(first.project).toMatchObject({ id: projectId, health: 'at_risk', priority: 1, logo_url: null });
    expect(first.project).not.toHaveProperty('logo_key');
    const [stored] = await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.id, first.data.id));
    expect(stored!.snapshot).toEqual(snap);
  });

  it('legacy data: a Done-state issue with NO completed_at still counts — issues_done and milestone pct follow the state category, a stale stamp on a reopened issue does not (founder, Round M follow-up)', async () => {
    const pid = (await projectsSvc.create(T1, ownerId, { name: 'Legacy stamps', team_ids: [teamId] })).data.id;
    const mid = (await projectsSvc.createMilestone(T1, ownerId, { project_id: pid, name: 'Shipped' })).data.id;
    const a = await mkIssue('finished before the stamps existed', { project_id: pid, milestone_id: mid });
    const b = await mkIssue('reopened on an old build, stamp kept', { project_id: pid });
    await dbAdmin.update(pmIssues).set({ state_id: completedStateId, completed_at: null }).where(eq(pmIssues.id, a.id));
    await dbAdmin.update(pmIssues).set({ completed_at: new Date('2026-09-01T00:00:00Z') }).where(eq(pmIssues.id, b.id));
    const res = await projectsSvc.postUpdate(T1, ownerId, pid, { health: 'on_track', body_md: 'closing out' });
    const snap = res.data.snapshot as PmUpdateSnapshot;
    expect(snap.issues_done).toBe(1); // a counts by category; b's stale stamp is ignored
    expect(snap.milestones.find((m) => m.id === mid)).toMatchObject({ scope: 1, done: 1, pct: 1, completed_at: null }); // 100 %, no date to show
  });

  it('the first snapshotted update diffs against the baseline (legacy null-snapshot rows are skipped and get diff null)', async () => {
    const d = (await projectsSvc.detail(T1, ownerId, projectId)).data;
    expect(d.updates.map((u) => u.id)).toEqual([first.data.id, legacyId]); // newest first
    expect(d.updates[1]!.diff).toBeNull();
    const diff = d.updates[0]!.diff!;
    expect(diff.since).toBe(projectCreatedAt.toISOString());
    expect(diff.props).toEqual([
      { key: 'priority', from: 0, to: 1 },
      { key: 'lead_user_id', from: null, to: leadId },
      { key: 'target_date', from: null, to: '2026-10-30' },
    ]);
    expect(diff.milestones).toHaveLength(1);
    expect(diff.milestones[0]).toMatchObject({ id: milestoneId, name: 'Beta', from_pct: 0, to_pct: 1 });
    expect(diff.milestones[0]!.completed_at).toBe((first.data.snapshot as PmUpdateSnapshot).milestones[0]!.completed_at);
    expect(diff.issues_done_delta).toBe(3);
  });

  it('a second update after only a target-date change diffs to exactly that prop, no milestones, no completions', async () => {
    await projectsSvc.update(T1, ownerId, projectId, { target_date: '2026-11-15' });
    const second = await projectsSvc.postUpdate(T1, ownerId, projectId, { health: 'on_track', body_md: 'Slipped two weeks' });
    const d = (await projectsSvc.detail(T1, ownerId, projectId)).data;
    expect(d.updates[0]!.id).toBe(second.data.id);
    expect(d.updates[0]!.diff).toEqual({
      since: (first.data.snapshot as PmUpdateSnapshot).at,
      props: [{ key: 'target_date', from: '2026-10-30', to: '2026-11-15' }],
      milestones: [],
      issues_done_delta: 0,
    });
    // The older update's diff is unchanged (still against the baseline).
    expect(d.updates[1]!.id).toBe(first.data.id);
    expect(d.updates[1]!.diff!.props).toHaveLength(3);
    expect(d.updates[2]!.diff).toBeNull();
    // The shared helper is what both transports use — same answer client-side.
    expect(diffProjectUpdate(second.data.snapshot as PmUpdateSnapshot, first.data.snapshot as PmUpdateSnapshot, { created_at: projectCreatedAt.toISOString() }))
      .toEqual(d.updates[0]!.diff);
  });

  it('a milestone that regresses shows the drop; a new issue completed shows in the delta', async () => {
    await mkIssue('MS reopened', { project_id: projectId, milestone_id: milestoneId }); // 2/3 → 66.67 %
    const extra = await mkIssue('Another done', { project_id: projectId });
    await issuesSvc.moveState(T1, ownerId, extra.id, completedStateId);
    const third = await projectsSvc.postUpdate(T1, ownerId, projectId, { health: 'on_track', body_md: 'One more in, one reopened' });
    const d = (await projectsSvc.detail(T1, ownerId, projectId)).data;
    expect(d.updates[0]!.id).toBe(third.data.id);
    const diff = d.updates[0]!.diff!;
    expect(diff.props).toEqual([]);
    expect(diff.milestones).toEqual([{ id: milestoneId, name: 'Beta', from_pct: 1, to_pct: 0.6667, completed_at: null }]);
    expect(diff.issues_done_delta).toBe(1);
  });

  it('a REOPENED issue leaves done (completed_at is cleared with the category — same rule as computeProgress); a milestone created after the previous update diffs from 0 %', async () => {
    // Reopen m1: completed → a non-completed, non-canceled state.
    const states = await dbAdmin.select().from(pmWorkflowStates).where(eq(pmWorkflowStates.team_id, teamId));
    const openState = states.find((s) => s.category === 'started') ?? states.find((s) => s.category === 'unstarted') ?? states.find((s) => s.category === 'backlog');
    expect(openState).toBeDefined();
    const [m1] = await dbAdmin
      .select({ id: pmIssues.id })
      .from(pmIssues)
      .where(and(eq(pmIssues.project_id, projectId), eq(pmIssues.title, 'MS one')));
    await issuesSvc.moveState(T1, ownerId, m1!.id, openState!.id);
    const [reopened] = await dbAdmin.select({ completed_at: pmIssues.completed_at }).from(pmIssues).where(eq(pmIssues.id, m1!.id));
    expect(reopened!.completed_at).toBeNull();
    // A milestone the previous snapshot never saw, with one completed issue on it.
    const gaId = (await projectsSvc.createMilestone(T1, ownerId, { project_id: projectId, name: 'GA' })).data.id;
    const ga1 = await mkIssue('GA one', { project_id: projectId, milestone_id: gaId });
    await issuesSvc.moveState(T1, ownerId, ga1.id, completedStateId);

    const fourth = await projectsSvc.postUpdate(T1, ownerId, projectId, { health: 'on_track', body_md: 'One reopened, GA started' });
    const snap = fourth.data.snapshot as PmUpdateSnapshot;
    // Live, non-canceled: m1, m2, reopened, loose done, loose open, another done, GA one = 7; done: m2, loose, another, GA one = 4.
    expect(snap.progress).toMatchObject({ scope: 7, done: 4 });
    expect(snap.issues_done).toBe(4);
    expect(snap.milestones.map((m) => ({ id: m.id, scope: m.scope, done: m.done, pct: m.pct }))).toEqual([
      { id: milestoneId, scope: 3, done: 1, pct: 0.3333 },
      { id: gaId, scope: 1, done: 1, pct: 1 },
    ]);
    const d = (await projectsSvc.detail(T1, ownerId, projectId)).data;
    expect(d.updates[0]!.id).toBe(fourth.data.id);
    const diff = d.updates[0]!.diff!;
    expect(diff.props).toEqual([]);
    expect(diff.milestones).toEqual([
      { id: milestoneId, name: 'Beta', from_pct: 0.6667, to_pct: 0.3333, completed_at: null },
      { id: gaId, name: 'GA', from_pct: 0, to_pct: 1, completed_at: snap.milestones[1]!.completed_at },
    ]);
    expect(snap.milestones[1]!.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(diff.issues_done_delta).toBe(0); // −1 reopened, +1 GA one
  });

  it('the body is cleaned like issue descriptions: HTML stripped, unsafe links neutralised, HTML-only ⇒ 400, over 20 000 ⇒ 400', async () => {
    const posted = await projectsSvc.postUpdate(T1, ownerId, projectId, {
      health: 'on_track',
      body_md: 'shipped <img src=x onerror=alert(1)> the **thing** [x](javascript:alert(1))',
    });
    expect(posted.data.body_md).toBe('shipped  the **thing** x');
    await expect(
      projectsSvc.postUpdate(T1, ownerId, projectId, { health: 'on_track', body_md: '<script>alert(1)</script>' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      projectsSvc.postUpdate(T1, ownerId, projectId, { health: 'on_track', body_md: 'x'.repeat(20_001) }),
    ).rejects.toThrow(/too long/);
  });

  it('the executor project.post_update path stores the snapshot on the client-minted id and acks with both rows; a replay is a duplicate no-op', async () => {
    const updateId = crypto.randomUUID();
    const item = { clientMutationId: crypto.randomUUID(), op: 'project.post_update' as const, id: projectId, fields: { update_id: updateId, health: 'off_track', body_md: 'Exec update' } };
    const res = await executor.execute(T1, ownerId, [item], 'owner');
    expect(res.results[0]!.status).toBe('applied');
    // The same clientMutationId again (offline retry, second tab): the ledger
    // answers 'duplicate' before the insert — no unique violation, one row.
    const replay = await executor.execute(T1, ownerId, [item], 'owner');
    expect(replay.results[0]!.status).toBe('duplicate');
    expect(await dbAdmin.select({ id: pmProjectUpdates.id }).from(pmProjectUpdates).where(eq(pmProjectUpdates.id, updateId))).toHaveLength(1);
    const rows = res.results[0]!.rows!;
    expect(rows.pm_project_updates).toHaveLength(1);
    expect(rows.pm_project_updates![0]).toMatchObject({ id: updateId, project_id: projectId, health: 'off_track', body_md: 'Exec update', author_user_id: ownerId });
    expect((rows.pm_project_updates![0] as { snapshot: PmUpdateSnapshot }).snapshot).toMatchObject({ v: 1, props: { health: 'off_track' } });
    expect(rows.pm_projects).toHaveLength(1);
    expect(rows.pm_projects![0]).toMatchObject({ id: projectId, health: 'off_track' });
    expect(rows.pm_projects![0]).not.toHaveProperty('logo_key');
    const [stored] = await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.id, updateId));
    expect(stored).toBeDefined();
    expect((stored!.snapshot as PmUpdateSnapshot).v).toBe(1);
    // Bootstrap ships the snapshot with the row.
    const lines = await syncSvc.bootstrap(T1, ownerId);
    const shipped = lines
      .map((l) => JSON.parse(l) as { model?: string; rows?: Array<{ id: string; snapshot?: unknown }> })
      .filter((o) => o.model === 'pm_project_updates')
      .flatMap((o) => o.rows ?? [])
      .find((r) => r.id === updateId)!;
    expect((shipped.snapshot as PmUpdateSnapshot).v).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Bell — members ∪ lead, never the author, grouped per project, preference-gated
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M — pm.project.update_posted inbox rows', () => {
  let projectId: string;
  let projectName: string;

  beforeAll(async () => {
    await dbAdmin.delete(notifications).where(inArray(notifications.user_id, userIds));
    await dbAdmin.delete(notificationPreferences).where(inArray(notificationPreferences.user_id, userIds));
    projectName = `Bell project ${rid()}`;
    projectId = (await projectsSvc.create(T1, ownerId, { name: projectName, team_ids: [teamId], lead_user_id: leadId })).data.id;
    // Members: the author too (must be excluded), the lead too (must dedupe),
    // a plain member, and one who switched the event off.
    await dbAdmin.insert(pmProjectMembers).values(
      [ownerId, leadId, memberId, quietId].map((uid) => ({ tenant_id: T1, project_id: projectId, user_id: uid })),
    );
    await notificationsSvc.setPreference(quietId, 'pm_project_update', 'in_app', false);
  });

  it('DOMAIN_EVENTS names the new event and postUpdate publishes it next to health_updated', async () => {
    expect(DOMAIN_EVENTS).toContain('pm.project.update_posted');
    const res = await projectsSvc.postUpdate(T1, ownerId, projectId, { health: 'at_risk', body_md: 'Heads up' });
    const events = await dbAdmin
      .select({ name: domainEvents.event_name, payload: domainEvents.payload })
      .from(domainEvents)
      .where(eq(domainEvents.tenant_id, T1));
    const mine = events.filter((e) => (e.payload as { update_id?: string }).update_id === res.data.id);
    expect(mine.map((e) => e.name).sort()).toEqual(['pm.project.health_updated', 'pm.project.update_posted']);
    for (const e of mine) {
      expect(e.payload).toMatchObject({
        project_id: projectId,
        health: 'at_risk',
        sync: [{ t: 'pm_project_updates', id: res.data.id }, { t: 'pm_projects', id: projectId }],
      });
    }
  });

  it('members + lead each get one row (lead-who-is-member once); the author and the opted-out member get none', async () => {
    await settle(async () => (await rowsFor(leadId)).length >= 1 && (await rowsFor(memberId)).length >= 1);
    await sleep(300); // give any stray fan-out time to land before asserting the negatives
    const lead = await rowsFor(leadId);
    expect(lead).toHaveLength(1);
    expect(lead[0]).toMatchObject({
      type: 'pm.project.update_posted',
      message: `owner Tester posted an update on ${projectName} — At risk`,
      link_url: `/pm/projects/${projectId}`,
      group_key: `pm.project:${projectId}`,
      group_count: 1,
      tenant_id: T1,
      read_at: null,
    });
    expect(await rowsFor(memberId)).toHaveLength(1);
    expect(await rowsFor(ownerId)).toHaveLength(0);
    expect(await rowsFor(quietId)).toHaveLength(0);
    // No email flavour: the preference default is in-app only.
    expect((await notificationsSvc.getPreferences(quietId)).events.find((e) => e.event === 'pm_project_update')).toMatchObject({ inApp: false, email: false });
    expect((await notificationsSvc.getPreferences(leadId)).events.find((e) => e.event === 'pm_project_update')).toMatchObject({ inApp: true, email: false });
  });

  it('a second update bumps the grouped row (count 2, newest health in the copy) instead of adding one', async () => {
    const [before] = await rowsFor(leadId);
    await projectsSvc.postUpdate(T1, ownerId, projectId, { health: 'on_track', body_md: 'Back on track' });
    await settle(async () => (await rowsFor(leadId)).some((r) => r.group_count >= 2));
    const lead = await rowsFor(leadId);
    expect(lead).toHaveLength(1);
    expect(lead[0]!.id).toBe(before!.id);
    expect(lead[0]!.group_count).toBe(2);
    expect(lead[0]!.message).toBe(`owner Tester posted an update on ${projectName} — On track`);
    await sleep(200);
    expect(await rowsFor(memberId)).toHaveLength(1);
    expect((await rowsFor(memberId))[0]!.group_count).toBe(2);
    expect(await rowsFor(ownerId)).toHaveLength(0);
    expect(await rowsFor(quietId)).toHaveLength(0);
  });

  it('a project with no members rings only the lead; a lead posting their own update rings nobody', async () => {
    const solo = (await projectsSvc.create(T1, ownerId, { name: `Solo ${rid()}`, team_ids: [teamId], lead_user_id: memberId })).data;
    const memberBefore = (await rowsFor(memberId)).length;
    await projectsSvc.postUpdate(T1, ownerId, solo.id, { health: 'on_track', body_md: 'Lead only' });
    await settle(async () => (await rowsFor(memberId)).length > memberBefore);
    const fresh = (await rowsFor(memberId)).find((r) => r.group_key === `pm.project:${solo.id}`)!;
    expect(fresh).toBeDefined();
    // The lead posts: they are the author, and there is nobody else.
    const leadBefore = (await rowsFor(leadId)).length;
    await projectsSvc.postUpdate(T1, memberId, solo.id, { health: 'on_track', body_md: 'From the lead' });
    await sleep(300);
    expect((await rowsFor(memberId)).find((r) => r.group_key === `pm.project:${solo.id}`)!.group_count).toBe(1);
    expect((await rowsFor(leadId)).length).toBe(leadBefore);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Security review of the agent-C surface — tenant isolation, who may post,
// client-minted ids, error hygiene, bell hygiene, event-payload parity
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M — security review: project updates + priority', () => {
  let T2: string;
  let owner2Id: string;
  let foreignProjectId: string;
  let foreignUpdateId: string;
  let guestId: string;
  let outsiderId: string; // T1 employee: sees public projects, member of no private one
  let publicProjectId: string;
  let privateProjectId: string;

  beforeAll(async () => {
    const [t2] = await dbAdmin
      .insert(tenants)
      .values({ name: `RM Foreign ${rid()}`, slug: `rmf-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
      .returning();
    T2 = t2!.id;
    owner2Id = await mkUser('owner2', 'owner', T2);
    await teamsSvc.ensureWorkspace(T2, owner2Id);
    const [team2] = await dbAdmin.select({ id: pmTeams.id }).from(pmTeams).where(eq(pmTeams.tenant_id, T2));
    foreignProjectId = (await projectsSvc.create(T2, owner2Id, { name: 'Foreign project', team_ids: [team2!.id] })).data.id;
    foreignUpdateId = (await projectsSvc.postUpdate(T2, owner2Id, foreignProjectId, { health: 'on_track', body_md: 'Foreign body' })).data.id;

    guestId = await mkUser('guest', 'guest');
    outsiderId = await mkUser('outsider', 'employee');
    publicProjectId = (await projectsSvc.create(T1, ownerId, { name: `Public ${rid()}`, team_ids: [teamId] })).data.id;
    privateProjectId = (await projectsSvc.create(T1, ownerId, { name: `Private ${rid()}`, team_ids: [teamId] })).data.id;
    await dbAdmin.update(pmProjects).set({ is_private: true }).where(eq(pmProjects.id, privateProjectId));
    // The guest is invited to the public project only.
    await dbAdmin.insert(pmProjectMembers).values({ tenant_id: T1, project_id: publicProjectId, user_id: guestId });
  });

  afterAll(async () => {
    await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, T2));
    await dbAdmin.delete(tenants).where(eq(tenants.id, T2)); // cascades T2's memberships/projects/updates
  });

  it('cross-tenant: a T1 owner cannot post to, patch or read a T2 project — 403, the same answer as for an unknown id, nothing written (REST + sync doors)', async () => {
    await expectHttp(projectsSvc.postUpdate(T1, ownerId, foreignProjectId, { health: 'off_track', body_md: 'hijack' }), 403, 'Project not visible to you');
    await expectHttp(projectsSvc.update(T1, ownerId, foreignProjectId, { priority: 1 }), 403, 'Project not visible to you');
    await expectHttp(projectsSvc.detail(T1, ownerId, foreignProjectId), 403, 'Project not visible to you');
    await expectHttp(projectsSvc.postUpdate(T1, ownerId, crypto.randomUUID(), { health: 'off_track', body_md: 'x' }), 403, 'Project not visible to you');
    const res = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'project.post_update' as const, id: foreignProjectId, fields: { health: 'off_track', body_md: 'hijack' } },
      { clientMutationId: crypto.randomUUID(), op: 'project.update' as const, id: foreignProjectId, fields: { priority: 1 } },
    ], 'owner');
    expect(res.results.map((r) => r.errorCode)).toEqual(['E403:Project not visible to you', 'E403:Project not visible to you']);
    expect(await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.project_id, foreignProjectId))).toHaveLength(1);
    const [fp] = await dbAdmin.select({ health: pmProjects.health, priority: pmProjects.priority }).from(pmProjects).where(eq(pmProjects.id, foreignProjectId));
    expect(fp).toEqual({ health: 'on_track', priority: 0 });
  });

  it('guest: reads the public project they are invited to, but may neither post an update nor change priority — REST and sync doors', async () => {
    expect((await projectsSvc.detail(T1, guestId, publicProjectId)).data.project.id).toBe(publicProjectId);
    await expectHttp(projectsSvc.postUpdate(T1, guestId, publicProjectId, { health: 'on_track', body_md: 'guest post' }), 403, /Guest seats are project-scoped/);
    await expectHttp(projectsSvc.update(T1, guestId, publicProjectId, { priority: 1 }), 403, /Guest seats are project-scoped/);
    const res = await executor.execute(T1, guestId, [
      { clientMutationId: crypto.randomUUID(), op: 'project.post_update' as const, id: publicProjectId, fields: { health: 'on_track', body_md: 'guest post' } },
      { clientMutationId: crypto.randomUUID(), op: 'project.update' as const, id: publicProjectId, fields: { priority: 1 } },
    ], 'guest');
    expect(res.results.map((r) => r.errorCode)).toEqual(['E403:guest seats are project-scoped', 'E403:guest seats are project-scoped']);
    expect(await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.project_id, publicProjectId))).toHaveLength(0);
  });

  it('private project: a non-member employee gets 403 on detail AND postUpdate, and its updates never reach them via the sync bootstrap; the same employee may post to a public project they can see (the standing rule: any non-guest viewer)', async () => {
    await expectHttp(projectsSvc.detail(T1, outsiderId, privateProjectId), 403, 'Project not visible to you');
    await expectHttp(projectsSvc.postUpdate(T1, outsiderId, privateProjectId, { health: 'off_track', body_md: 'peek' }), 403, 'Project not visible to you');
    const secret = `PRIVATE-${rid()}`;
    await projectsSvc.postUpdate(T1, ownerId, privateProjectId, { health: 'at_risk', body_md: secret });
    const lines = await syncSvc.bootstrap(T1, outsiderId);
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(privateProjectId);
    const posted = await projectsSvc.postUpdate(T1, outsiderId, publicProjectId, { health: 'on_track', body_md: 'an employee who can see a public project may post to it' });
    expect(posted.data.author_user_id).toBe(outsiderId);
  });

  it('client-minted update id: must be a uuid (400); reusing an existing id — own tenant or foreign — is one identical 409; no raw Postgres text; nothing overwritten', async () => {
    const own = await projectsSvc.postUpdate(T1, ownerId, publicProjectId, { health: 'on_track', body_md: 'own row' });
    const [foreignBefore] = await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.id, foreignUpdateId));
    const [privBefore] = await dbAdmin.select({ health: pmProjects.health }).from(pmProjects).where(eq(pmProjects.id, privateProjectId));
    const privUpdatesBefore = (await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.project_id, privateProjectId))).length;

    await expectHttp(projectsSvc.postUpdate(T1, ownerId, privateProjectId, { id: 'nope', health: 'off_track', body_md: 'x' }), 400, 'update id must be a uuid');
    await expectHttp(projectsSvc.postUpdate(T1, ownerId, privateProjectId, { id: {} as never, health: 'off_track', body_md: 'x' }), 400, 'update id must be a uuid');
    await expectHttp(projectsSvc.postUpdate(T1, ownerId, privateProjectId, { id: own.data.id, health: 'off_track', body_md: 'overwrite?' }), 409, 'An update with this id already exists');
    await expectHttp(projectsSvc.postUpdate(T1, ownerId, privateProjectId, { id: foreignUpdateId, health: 'off_track', body_md: 'overwrite?' }), 409, 'An update with this id already exists');

    const [ownAfter] = await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.id, own.data.id));
    expect(ownAfter).toMatchObject({ project_id: publicProjectId, tenant_id: T1, health: 'on_track', body_md: 'own row' });
    const [foreignAfter] = await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.id, foreignUpdateId));
    expect(foreignAfter).toEqual(foreignBefore);
    expect((await dbAdmin.select().from(pmProjectUpdates).where(eq(pmProjectUpdates.project_id, privateProjectId))).length).toBe(privUpdatesBefore);
    const [privAfter] = await dbAdmin.select({ health: pmProjects.health }).from(pmProjects).where(eq(pmProjects.id, privateProjectId));
    expect(privAfter).toEqual(privBefore); // the failed posts never denormalised their health

    // Sync door: the same clean codes; the per-item errorCode carries no driver text.
    const res = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'project.post_update' as const, id: privateProjectId, fields: { update_id: 'nope', health: 'on_track', body_md: 'x' } },
      { clientMutationId: crypto.randomUUID(), op: 'project.post_update' as const, id: privateProjectId, fields: { update_id: foreignUpdateId, health: 'on_track', body_md: 'x' } },
      { clientMutationId: crypto.randomUUID(), op: 'project.post_update' as const, id: privateProjectId, fields: { update_id: crypto.randomUUID(), health: 'on_track', body_md: 123 } },
      { clientMutationId: crypto.randomUUID(), op: 'project.create' as const, id: crypto.randomUUID(), fields: { name: 'Nine', team_ids: [teamId], priority: 9 } },
    ], 'owner');
    expect(res.results.map((r) => r.errorCode)).toEqual([
      'E400:update id must be a uuid',
      'E409:An update with this id already exists',
      'E400:Update body must be a string',
      'E400:priority must be an integer between 0 and 4',
    ]);
    for (const r of res.results) expect(r.errorCode).not.toMatch(/duplicate key|violates|constraint|invalid input syntax|E500/);
    expect(await dbAdmin.select({ id: pmProjects.id }).from(pmProjects).where(and(eq(pmProjects.tenant_id, T1), eq(pmProjects.name, 'Nine')))).toHaveLength(0);
  });

  it('bell hygiene: a deactivated workspace member whose project-member row lingers gets no row; the copy carries author + project + health, never the body; the domain event carries neither body nor snapshot', async () => {
    const activeId = await mkUser('active', 'employee');
    const staleId = await mkUser('stale', 'employee');
    const project = (await projectsSvc.create(T1, ownerId, { name: `Hygiene ${rid()}`, team_ids: [teamId] })).data;
    await dbAdmin.insert(pmProjectMembers).values([activeId, staleId].map((uid) => ({ tenant_id: T1, project_id: project.id, user_id: uid })));
    await dbAdmin.update(memberships).set({ status: 'deactivated' }).where(and(eq(memberships.tenant_id, T1), eq(memberships.user_id, staleId)));

    const secret = `SECRET-${rid()}`;
    const res = await projectsSvc.postUpdate(T1, ownerId, project.id, { health: 'at_risk', body_md: `Body ${secret}` });
    await settle(async () => (await rowsFor(activeId)).length >= 1);
    await sleep(300);
    const [row] = await rowsFor(activeId);
    expect(row).toMatchObject({ message: `owner Tester posted an update on ${project.name} — At risk`, tenant_id: T1, link_url: `/pm/projects/${project.id}` });
    expect(row!.message).not.toContain(secret);
    expect(await rowsFor(staleId)).toHaveLength(0);

    const events = await dbAdmin
      .select({ name: domainEvents.event_name, payload: domainEvents.payload })
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, T1), inArray(domainEvents.event_name, ['pm.project.update_posted', 'pm.project.health_updated'])));
    const mine = events.filter((e) => (e.payload as { update_id?: string }).update_id === res.data.id);
    expect(mine).toHaveLength(2);
    for (const e of mine) {
      expect(Object.keys(e.payload as object).sort()).toEqual(['deal_id', 'health', 'project_id', 'sync', 'update_id']);
      expect(JSON.stringify(e.payload)).not.toContain(secret);
    }
  });
});
