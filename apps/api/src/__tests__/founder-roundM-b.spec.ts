/**
 * Founder round M (2026-09-17) — agent B: the project rail's Insights card
 * + Progress graph ("a graphical representation like ClickUp or Linear when
 * someone opens a project").
 *
 *  - GET  pm/projects/:id/insights          → live issues × states × labels ×
 *    milestones × users, the weekly scope/started/done series and the
 *    predicted completion; same read gate (and status codes) as detail().
 *  - POST pm/projects/:id/insights-default  → saves {measure, slice, segment}
 *    on the project (lead, or manager and above); ships through the usual
 *    pm.project.updated + pm_projects sync ref.
 *  - `@flicks/shared/pm` math (pivotInsights / buildProgressSeries /
 *    predictCompletion) — pure, unit-tested here without the DB.
 *
 * Service-level against the real Postgres (pm-sync harness).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmWorkflowStates,
  pmLabels,
  pmIssues,
  pmProjects,
  pmProjectMembers,
  domainEvents,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ForbiddenException, HttpException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  PM_INSIGHTS_DEFAULT,
  buildProgressSeries,
  pivotInsights,
  predictCompletion,
  weekMondayISO,
  weekMondayUTC,
  type PmInsightIssue,
  type PmInsightLookups,
  type PmInsightsConfig,
  type PmProgressPoint,
} from '@flicks/shared/pm';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { InsightsService, PM_INSIGHTS_ISSUE_CAP } from '../modules/pm/insights.service';
import { PmController, SetInsightsDefaultDto } from '../modules/pm/pm.controller';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const media = { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never;

const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, media);
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, new ConfigService(), emitter);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility, media);
const insightsSvc = new InsightsService(dbSvc, visibility, projectsSvc, teamsSvc, domainEventsSvc);

/** Security review — the cap, exercised at 5 rows instead of seeding 5 001. */
class CappedInsightsService extends InsightsService {
  protected override readonly issueCap: number = 5;
}
const cappedSvc = new CappedInsightsService(dbSvc, visibility, projectsSvc, teamsSvc, domainEventsSvc);

/** HTTP status a rejected call would answer with (or 'resolved' when it does not throw). */
async function statusOf(p: Promise<unknown>): Promise<number | 'resolved'> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    if (e instanceof HttpException) return e.getStatus();
    throw e;
  }
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date | number, n: number) => new Date((typeof d === 'number' ? d : d.getTime()) + n * DAY);

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string;
let T2: string;
let ownerId: string;
let leadId: string; // employee seat, lead of `project`
let memberId: string; // employee seat, not lead, not a member of the private project
let guestId: string; // guest seat, invited to `project` only (security review)
let t2OwnerId: string;
let teamId: string;
let project: string;
let milestoneId: string;
let labelA: string;
let labelB: string;
let stateOf: Record<string, string>; // category → state id (the default state of that category)
const userIds: string[] = [];

// Week anchors (UTC Mondays): W0 = this week, W1 = last week, W2 = two weeks ago.
const NOW = new Date();
const W0 = weekMondayUTC(NOW);
const W1 = addDays(W0, -7);
const W2 = addDays(W0, -14);
/** An instant inside the current week that is safely in the past. */
const w0Event = new Date(Math.max(W0.getTime() + 1000, NOW.getTime() - 60_000));

async function mkUser(label: string, tenantId: string, role: 'owner' | 'employee' | 'guest') {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rm-b-${label}-${rid()}@t.test`, full_name: `${label} Tester`, status: 'active' })
    .returning();
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' });
  userIds.push(u!.id);
  return u!.id;
}

interface Seed {
  title: string;
  category: string;
  priority: number;
  estimate?: number;
  assignee?: string;
  milestone?: boolean;
  labels?: string[];
  created: Date;
  started?: Date;
  completed?: Date;
  canceled?: Date;
}

async function seedIssue(s: Seed) {
  const created = (
    await issuesSvc.create(T1, ownerId, {
      team_id: teamId,
      title: s.title,
      project_id: project,
      priority: s.priority,
      estimate: s.estimate ?? null,
      assignee_user_id: s.assignee,
      milestone_id: s.milestone ? milestoneId : undefined,
      label_ids: s.labels,
    })
  ).data;
  await dbAdmin
    .update(pmIssues)
    .set({
      state_id: stateOf[s.category]!,
      created_at: s.created,
      started_at: s.started ?? null,
      completed_at: s.completed ?? null,
      canceled_at: s.canceled ?? null,
    })
    .where(eq(pmIssues.id, created.id));
  return created.id;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RM Insights ${rid()}`, slug: `rmb-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T1 = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `RM Other ${rid()}`, slug: `rmb2-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T2 = t2!.id;
  ownerId = await mkUser('owner', T1, 'owner');
  leadId = await mkUser('lead', T1, 'employee');
  memberId = await mkUser('member', T1, 'employee');
  guestId = await mkUser('guest', T1, 'guest');
  t2OwnerId = await mkUser('zed', T2, 'owner');

  // The team-creation path self-heals the default workflow states.
  await teamsSvc.ensureWorkspace(T1, ownerId);
  teamId = (await dbAdmin.select({ id: pmTeams.id }).from(pmTeams).where(eq(pmTeams.tenant_id, T1)))[0]!.id;
  const states = await dbAdmin
    .select({ id: pmWorkflowStates.id, category: pmWorkflowStates.category, def: pmWorkflowStates.is_default_for_category })
    .from(pmWorkflowStates)
    .where(and(eq(pmWorkflowStates.tenant_id, T1), eq(pmWorkflowStates.team_id, teamId)));
  stateOf = {};
  for (const s of states) if (s.def) stateOf[s.category] = s.id;
  await teamsSvc.ensureWorkspace(T2, t2OwnerId);

  project = (await projectsSvc.create(T1, ownerId, { name: 'Rail project', team_ids: [teamId], lead_user_id: leadId, target_date: isoDay(addDays(W0, 28)) })).data.id;
  milestoneId = (await projectsSvc.createMilestone(T1, ownerId, { project_id: project, name: 'Beta' })).data.id;
  // The guest seat's whole world is this one project (pm_project_members row).
  await dbAdmin.insert(pmProjectMembers).values({ tenant_id: T1, project_id: project, user_id: guestId });
  const [la] = await dbAdmin.insert(pmLabels).values({ tenant_id: T1, team_id: null, name: `bug-${rid()}`, color: '#F8786B' }).returning();
  const [lb] = await dbAdmin.insert(pmLabels).values({ tenant_id: T1, team_id: null, name: `ux-${rid()}`, color: '#9B7BFA' }).returning();
  labelA = la!.id;
  labelB = lb!.id;

  // 12 issues across 3 weeks; 2 canceled (one by stamp + state, one by state + stamp this week).
  const seeds: Seed[] = [
    { title: 'Done in W2 a', category: 'completed', priority: 1, estimate: 3, assignee: ownerId, created: addDays(W2, 1), started: addDays(W2, 2), completed: addDays(W2, 3) },
    { title: 'Done in W2 b', category: 'completed', priority: 2, estimate: 2, created: addDays(W2, 1), started: addDays(W2, 2), completed: addDays(W2, 4) },
    { title: 'Done in W1 a', category: 'completed', priority: 1, created: addDays(W2, 1), started: W1, completed: addDays(W1, 1) },
    { title: 'Done in W1 b', category: 'completed', priority: 3, created: addDays(W2, 2), started: addDays(W1, 1), completed: addDays(W1, 2) },
    { title: 'In progress since W1', category: 'started', priority: 2, milestone: true, created: addDays(W2, 2), started: addDays(W1, 1) },
    { title: 'In progress since W0', category: 'started', priority: 0, labels: [labelA], created: addDays(W2, 3), started: w0Event },
    { title: 'Done in W0', category: 'completed', priority: 3, created: addDays(W1, 1), started: w0Event, completed: w0Event },
    { title: 'Todo, two labels', category: 'unstarted', priority: 4, estimate: 5, labels: [labelA, labelB], created: addDays(W1, 2) },
    { title: 'Backlog for member', category: 'backlog', priority: 3, assignee: memberId, created: addDays(W1, 3) },
    { title: 'Todo fresh', category: 'unstarted', priority: 2, created: w0Event },
    { title: 'Canceled in W1', category: 'canceled', priority: 1, estimate: 8, created: addDays(W2, 1), canceled: addDays(W1, 1) },
    { title: 'Canceled in W0', category: 'canceled', priority: 2, created: addDays(W1, 1), canceled: w0Event },
  ];
  for (const s of seeds) await seedIssue(s);
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
// Routes
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M/B — routes', () => {
  it('GET pm/projects/:id/insights and POST pm/projects/:id/insights-default are registered on the controller', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PmController.prototype.projectInsights)).toBe('projects/:id/insights');
    expect(Reflect.getMetadata(METHOD_METADATA, PmController.prototype.projectInsights)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, PmController.prototype.setProjectInsightsDefault)).toBe('projects/:id/insights-default');
    expect(Reflect.getMetadata(METHOD_METADATA, PmController.prototype.setProjectInsightsDefault)).toBe(RequestMethod.POST);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET insights — payload, pivot, series, prediction
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M/B — InsightsService.get', () => {
  it('ships the live issues with lifecycle stamps, the lookups, the weekly series and the prediction', async () => {
    const d = (await insightsSvc.get(T1, ownerId, project)).data;
    expect(d.issues).toHaveLength(12); // canceled rows ride along — the math excludes them
    for (const i of d.issues) {
      expect(typeof i.created_at).toBe('string');
      expect(Array.isArray(i.label_ids)).toBe(true);
    }
    expect(d.states.map((s) => s.category)).toEqual(expect.arrayContaining(['backlog', 'unstarted', 'started', 'completed', 'canceled']));
    expect(Object.keys(d.labels).sort()).toEqual([labelA, labelB].sort());
    expect(d.milestones[milestoneId]).toBe('Beta');
    expect(d.users[ownerId]).toBe('owner Tester');
    expect(d.users[memberId]).toBe('member Tester');
    expect(d.target_date).toBe(isoDay(addDays(W0, 28)));
    expect(d.insights_default).toBeNull();
    expect(typeof d.generated_at).toBe('string');

    // Series: three weekly points, state at the END of each week.
    expect(d.series.length).toBeGreaterThanOrEqual(3);
    const [w2, w1, w0] = d.series.slice(-3);
    expect(w2).toEqual({ week: isoDay(W2), scope: 7, started: 2, done: 2 });
    expect(w1).toEqual({ week: isoDay(W1), scope: 10, started: 5, done: 4 });
    expect(w0).toEqual({ week: isoDay(W0), scope: 10, started: 7, done: 5 });
    // Last point's done = the completed count (5 of 10 live).
    const completed = d.issues.filter((i) => i.completed_at && !i.canceled_at).length;
    expect(w0!.done).toBe(completed);

    // Prediction: velocity = mean(done deltas over the 2 complete weeks) = (2 + 2) / 2;
    // remaining 5 → ceil(5 / 2) = 3 weeks from today (UTC).
    expect(d.prediction.velocity_per_week).toBe(2);
    const today = new Date(d.generated_at);
    const expected = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 21));
    expect(d.prediction.predicted_completion).toBe(isoDay(expected));
  });

  it('pivot: counts by status and by priority exclude canceled; points use estimate ?? 1; label slice counts once per label', async () => {
    const d = (await insightsSvc.get(T1, ownerId, project)).data;
    const lookups: PmInsightLookups = { states: d.states, users: d.users, milestones: d.milestones, labels: d.labels };
    const byKey = (rows: Array<{ key: string; total: number }>) => Object.fromEntries(rows.map((r) => [r.key, r.total]));

    const status = pivotInsights(d.issues, lookups, { measure: 'count', slice: 'status', segment: 'none' });
    expect(status.total).toBe(10);
    expect(byKey(status.rows)).toEqual({
      [stateOf.backlog!]: 1,
      [stateOf.unstarted!]: 2,
      [stateOf.started!]: 2,
      [stateOf.completed!]: 5,
    });
    expect(status.rows.some((r) => r.key === stateOf.canceled)).toBe(false);
    // Ordered by category: backlog → unstarted → started → completed.
    expect(status.rows.map((r) => r.label)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done']);
    expect(status.segments).toEqual([{ key: 'total', label: 'Total' }]);

    const prio = pivotInsights(d.issues, lookups, { measure: 'count', slice: 'priority', segment: 'none' });
    expect(byKey(prio.rows)).toEqual({ '0': 1, '1': 2, '2': 3, '3': 3, '4': 1 });
    expect(prio.rows.map((r) => r.label)).toEqual(['No priority', 'Urgent', 'High', 'Medium', 'Low']);

    const points = pivotInsights(d.issues, lookups, { measure: 'points', slice: 'status', segment: 'none' });
    expect(points.total).toBe(17); // 3+2+1+1+1+1+1+5+1+1; the canceled 8-pointer is out
    expect(byKey(points.rows)).toEqual({
      [stateOf.backlog!]: 1,
      [stateOf.unstarted!]: 6,
      [stateOf.started!]: 2,
      [stateOf.completed!]: 8,
    });

    const assignee = pivotInsights(d.issues, lookups, { measure: 'count', slice: 'assignee', segment: 'none' });
    expect(byKey(assignee.rows)).toEqual({ [ownerId]: 1, [memberId]: 1, unassigned: 8 });
    expect(assignee.rows[assignee.rows.length - 1]!.label).toBe('Unassigned'); // "none" bucket last
    expect(assignee.rows.find((r) => r.key === ownerId)!.label).toBe('owner Tester');

    const ms = pivotInsights(d.issues, lookups, { measure: 'count', slice: 'milestone', segment: 'none' });
    expect(byKey(ms.rows)).toEqual({ [milestoneId]: 1, none: 9 });
    expect(ms.rows[0]!.label).toBe('Beta');

    const label = pivotInsights(d.issues, lookups, { measure: 'count', slice: 'label', segment: 'none' });
    expect(byKey(label.rows)).toEqual({ [labelA]: 2, [labelB]: 1, none: 8 });
    expect(label.rows.reduce((a, r) => a + r.total, 0)).toBe(11); // once per label
    expect(label.total).toBe(10); // once per issue
    expect(label.rows.find((r) => r.key === labelA)!.color).toBe('#F8786B');

    // Segmented: status × priority — Done splits 2 urgent / 1 high / 2 medium.
    const seg = pivotInsights(d.issues, lookups, { measure: 'count', slice: 'status', segment: 'priority' });
    expect(seg.segments.map((s) => s.key)).toEqual(['0', '1', '2', '3', '4']);
    const done = seg.rows.find((r) => r.key === stateOf.completed)!;
    expect(done.total).toBe(5);
    expect(Object.fromEntries(done.cells.map((c) => [c.key, c.value]))).toEqual({ '0': 0, '1': 2, '2': 1, '3': 2, '4': 0 });
    // Every row carries a cell per segment, in segment order.
    for (const r of seg.rows) expect(r.cells.map((c) => c.key)).toEqual(seg.segments.map((s) => s.key));
  });

  it('answers with the SAME status as detail() for a foreign-tenant caller, an unknown id, and a non-member of a private project', async () => {
    // Another tenant's owner with this project id.
    expect(await statusOf(insightsSvc.get(T2, t2OwnerId, project))).toBe(await statusOf(projectsSvc.detail(T2, t2OwnerId, project)));
    expect(await statusOf(insightsSvc.get(T2, t2OwnerId, project))).not.toBe('resolved');
    // An unknown id in the right tenant.
    const bogus = crypto.randomUUID();
    expect(await statusOf(insightsSvc.get(T1, ownerId, bogus))).toBe(await statusOf(projectsSvc.detail(T1, ownerId, bogus)));
    // A private project the employee is neither lead nor member of.
    const priv = (await projectsSvc.create(T1, ownerId, { name: 'Members only', team_ids: [teamId] })).data.id;
    await dbAdmin.update(pmProjects).set({ is_private: true }).where(eq(pmProjects.id, priv));
    const mine = await statusOf(insightsSvc.get(T1, memberId, priv));
    expect(mine).toBe(await statusOf(projectsSvc.detail(T1, memberId, priv)));
    expect(mine).toBe(403);
    // …and the owner still reads it (empty project → empty series, null prediction).
    const d = (await insightsSvc.get(T1, ownerId, priv)).data;
    expect(d.issues).toEqual([]);
    expect(d.series).toEqual([]);
    expect(d.prediction).toEqual({ velocity_per_week: null, predicted_completion: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST insights-default
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M/B — InsightsService.setDefault', () => {
  const cfg: PmInsightsConfig = { measure: 'points', slice: 'assignee', segment: 'status' };

  it('a plain employee who is not the lead is refused (403); an invalid config is a 400', async () => {
    await expect(insightsSvc.setDefault(T1, memberId, 'employee', project, cfg)).rejects.toThrow(ForbiddenException);
    await expect(insightsSvc.setDefault(T1, leadId, 'employee', project, { ...cfg, slice: 'nope' } as never)).rejects.toThrow(BadRequestException);
    const [row] = await dbAdmin.select({ v: pmProjects.insights_default }).from(pmProjects).where(eq(pmProjects.id, project));
    expect(row!.v).toBeNull();
  });

  it('the lead (an employee seat) stores it; get() returns it; a pm.project.updated event carries the pm_projects sync ref', async () => {
    const before = Date.now();
    const res = await insightsSvc.setDefault(T1, leadId, 'employee', project, cfg);
    expect(res.data).toEqual({ project_id: project, insights_default: cfg });
    const [row] = await dbAdmin.select({ v: pmProjects.insights_default, updated_at: pmProjects.updated_at }).from(pmProjects).where(eq(pmProjects.id, project));
    expect(row!.v).toEqual(cfg);
    expect(row!.updated_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await insightsSvc.get(T1, memberId, project)).data.insights_default).toEqual(cfg);
    const [ev] = await dbAdmin
      .select({ name: domainEvents.event_name, payload: domainEvents.payload })
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, T1), eq(domainEvents.event_name, 'pm.project.updated')))
      .orderBy(desc(domainEvents.occurred_at))
      .limit(1);
    expect(ev!.payload).toMatchObject({ project_id: project, insights_default: cfg, sync: [{ t: 'pm_projects', id: project }] });

    // Manager-and-above without the lead role also may; the owner overwrites.
    const owner = await insightsSvc.setDefault(T1, ownerId, 'owner', project, PM_INSIGHTS_DEFAULT);
    expect(owner.data.insights_default).toEqual(PM_INSIGHTS_DEFAULT);
    // Foreign tenant: same status as detail (never a write).
    expect(await statusOf(insightsSvc.setDefault(T2, t2OwnerId, 'owner', project, cfg))).toBe(await statusOf(projectsSvc.detail(T2, t2OwnerId, project)));
    const [still] = await dbAdmin.select({ v: pmProjects.insights_default }).from(pmProjects).where(eq(pmProjects.id, project));
    expect(still!.v).toEqual(PM_INSIGHTS_DEFAULT);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Security review (round M) — payload scope, guest scope, the cap, the DTO
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M/B — security review', () => {
  const cfg: PmInsightsConfig = { measure: 'count', slice: 'label', segment: 'priority' };
  /** The states the 12 seeds actually reference (no seed sits in Triage). */
  const SEEDED_STATE_IDS: string[] = [];
  beforeAll(() => {
    for (const c of ['backlog', 'unstarted', 'started', 'completed', 'canceled']) SEEDED_STATE_IDS.push(stateOf[c]!);
  });

  it('lookups are keyed to what the returned issues reference: only referenced states (the team has more), only assignees as users', async () => {
    const d = (await insightsSvc.get(T1, ownerId, project)).data;
    // The default workflow has 8 states (6 of them per-category defaults, triage
    // included); the 12 seeded issues sit in exactly 5 of them.
    const teamStates = await dbAdmin
      .select({ id: pmWorkflowStates.id })
      .from(pmWorkflowStates)
      .where(and(eq(pmWorkflowStates.tenant_id, T1), eq(pmWorkflowStates.team_id, teamId)));
    expect(teamStates.length).toBeGreaterThan(SEEDED_STATE_IDS.length);
    expect(d.states.map((s) => s.id).sort()).toEqual([...SEEDED_STATE_IDS].sort());
    expect(d.states.some((s) => s.id === stateOf.triage)).toBe(false);
    // users = the assignees of the returned issues, not the workspace roster:
    // the lead is an active member but assigned nothing → absent.
    expect(Object.keys(d.users).sort()).toEqual([ownerId, memberId].sort());
    expect(d.users[leadId]).toBeUndefined();
    expect(d.truncated).toBe(false);
    expect(d.issue_cap).toBe(PM_INSIGHTS_ISSUE_CAP);
    expect(PM_INSIGHTS_ISSUE_CAP).toBe(5000);
  });

  it('a guest invited to the project reads it (assignee names only); an uninvited project answers like detail(); the default is never theirs to set — even with a forged elevated JWT role', async () => {
    const d = (await insightsSvc.get(T1, guestId, project)).data;
    expect(d.issues).toHaveLength(12);
    expect(d.states.map((s) => s.id).sort()).toEqual([...SEEDED_STATE_IDS].sort());
    expect(Object.keys(d.users).sort()).toEqual([ownerId, memberId].sort());
    expect(d.users[leadId]).toBeUndefined();
    expect(d.users[guestId]).toBeUndefined();

    // A project the guest was not invited to — public to members, invisible to the guest.
    const other = (await projectsSvc.create(T1, ownerId, { name: 'Not for guests', team_ids: [teamId] })).data.id;
    const mine = await statusOf(insightsSvc.get(T1, guestId, other));
    expect(mine).toBe(await statusOf(projectsSvc.detail(T1, guestId, other)));
    expect(mine).toBe(403);

    // Writes: the DB role decides, not the JWT claim the controller forwards.
    const [before] = await dbAdmin.select({ v: pmProjects.insights_default }).from(pmProjects).where(eq(pmProjects.id, project));
    await expect(insightsSvc.setDefault(T1, guestId, 'guest', project, cfg)).rejects.toThrow(ForbiddenException);
    await expect(insightsSvc.setDefault(T1, guestId, 'owner', project, cfg)).rejects.toThrow(ForbiddenException);
    const [after] = await dbAdmin.select({ v: pmProjects.insights_default }).from(pmProjects).where(eq(pmProjects.id, project));
    expect(after!.v).toEqual(before!.v);
  });

  it('the issue cap keeps the most recent N (oldest-first on the wire) and says so; below the cap nothing changes', async () => {
    const capProject = (await projectsSvc.create(T1, ownerId, { name: 'Cap project', team_ids: [teamId] })).data.id;
    const ids: string[] = [];
    for (let k = 0; k < 7; k++) {
      const id = (await issuesSvc.create(T1, ownerId, { team_id: teamId, title: `cap ${k}`, project_id: capProject, priority: 0 })).data.id;
      await dbAdmin.update(pmIssues).set({ created_at: addDays(W2, k) }).where(eq(pmIssues.id, id));
      ids.push(id);
    }
    const capped = (await cappedSvc.get(T1, ownerId, capProject)).data;
    expect(capped.issue_cap).toBe(5);
    expect(capped.truncated).toBe(true);
    expect(capped.issues).toHaveLength(5);
    // The 5 newest (k = 2..6), ascending by created_at like the uncapped payload.
    expect(capped.issues.map((i) => i.id)).toEqual(ids.slice(2));
    for (let i = 1; i < capped.issues.length; i++) {
      expect(capped.issues[i]!.created_at >= capped.issues[i - 1]!.created_at).toBe(true);
    }
    expect(capped.series.length).toBeGreaterThanOrEqual(1);

    const full = (await insightsSvc.get(T1, ownerId, capProject)).data;
    expect(full.truncated).toBe(false);
    expect(full.issues.map((i) => i.id)).toEqual(ids);
  });

  it('SetInsightsDefaultDto under the real ValidationPipe: enum values only, no extra keys, nothing optional', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } });
    const meta = { type: 'body' as const, metatype: SetInsightsDefaultDto };
    const ok = (await pipe.transform({ measure: 'points', slice: 'assignee', segment: 'status' }, meta)) as SetInsightsDefaultDto;
    expect({ ...ok }).toEqual({ measure: 'points', slice: 'assignee', segment: 'status' });
    await expect(pipe.transform({ measure: 'points', slice: 'nope', segment: 'status' }, meta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ measure: 'points', slice: 'assignee', segment: 'status', project_id: crypto.randomUUID() }, meta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ measure: 'points', slice: 'assignee' }, meta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ measure: { $gt: '' }, slice: 'assignee', segment: 'status' }, meta)).rejects.toThrow(BadRequestException);
  });

  it('POST insights-default answers like detail() for an unknown id and for a private project the caller cannot see — and writes nothing', async () => {
    const bogus = crypto.randomUUID();
    expect(await statusOf(insightsSvc.setDefault(T1, ownerId, 'owner', bogus, cfg))).toBe(await statusOf(projectsSvc.detail(T1, ownerId, bogus)));

    const priv = (await projectsSvc.create(T1, ownerId, { name: 'Private default', team_ids: [teamId] })).data.id;
    await dbAdmin.update(pmProjects).set({ is_private: true }).where(eq(pmProjects.id, priv));
    // memberId: employee, not lead, not a member — cannot see it, so the
    // authority question is never reached and no probe signal leaks.
    const mine = await statusOf(insightsSvc.setDefault(T1, memberId, 'employee', priv, cfg));
    expect(mine).toBe(await statusOf(projectsSvc.detail(T1, memberId, priv)));
    expect(mine).toBe(403);
    // A forged 'manager' claim changes nothing: visibility comes first.
    expect(await statusOf(insightsSvc.setDefault(T1, memberId, 'manager', priv, cfg))).toBe(403);
    const [row] = await dbAdmin.select({ v: pmProjects.insights_default }).from(pmProjects).where(eq(pmProjects.id, priv));
    expect(row!.v).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Pure math — no DB
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M/B — shared math (pure)', () => {
  const S = {
    todo: { id: 's-todo', name: 'Todo', category: 'unstarted', color: '#A8B0C2' },
    doing: { id: 's-doing', name: 'In Progress', category: 'started', color: '#FED800' },
    done: { id: 's-done', name: 'Done', category: 'completed', color: '#27D280' },
    dead: { id: 's-dead', name: 'Canceled', category: 'canceled', color: '#5C6477' },
  };
  const lookups: PmInsightLookups = {
    states: Object.values(S),
    users: { u1: 'Asha', u2: 'Bo' },
    milestones: { m1: 'Alpha' },
    labels: { l1: { name: 'bug', color: '#F00' }, l2: { name: 'ux' } },
  };
  const issue = (over: Partial<PmInsightIssue> & { id: string }): PmInsightIssue => ({
    state_id: S.todo.id,
    priority: 0,
    estimate: null,
    assignee_user_id: null,
    milestone_id: null,
    label_ids: [],
    created_at: '2026-08-03T10:00:00.000Z',
    started_at: null,
    completed_at: null,
    canceled_at: null,
    ...over,
  });

  it('pivotInsights: drops canceled (by stamp OR by state category), drops empty segments, colours flow from lookups', () => {
    const issues = [
      issue({ id: 'a', state_id: S.done.id, priority: 1, estimate: 3, assignee_user_id: 'u1' }),
      issue({ id: 'b', state_id: S.doing.id, priority: 2, estimate: 2, assignee_user_id: 'u2', label_ids: ['l1', 'l2'] }),
      issue({ id: 'c', state_id: S.todo.id, priority: 2, label_ids: ['l1', 'l1'] }), // duplicate label id counts once
      issue({ id: 'x', state_id: S.dead.id, priority: 1 }), // canceled by category, no stamp
      issue({ id: 'y', state_id: S.todo.id, priority: 1, canceled_at: '2026-08-05T00:00:00.000Z' }), // canceled by stamp, state not canceled
    ];
    const p = pivotInsights(issues, lookups, { measure: 'count', slice: 'status', segment: 'priority' });
    expect(p.total).toBe(3);
    expect(p.rows.map((r) => [r.key, r.label, r.color, r.total])).toEqual([
      ['s-todo', 'Todo', '#A8B0C2', 1],
      ['s-doing', 'In Progress', '#FED800', 1],
      ['s-done', 'Done', '#27D280', 1],
    ]);
    // Only priorities 1 and 2 appear — 0/3/4 are empty and dropped.
    expect(p.segments.map((s) => s.key)).toEqual(['1', '2']);
    expect(p.rows[2]!.cells).toEqual([
      { key: '1', label: 'Urgent', value: 1 },
      { key: '2', label: 'High', value: 0 },
    ]);

    const pts = pivotInsights(issues, lookups, { measure: 'points', slice: 'assignee', segment: 'status' });
    expect(pts.total).toBe(6); // 3 + 2 + 1
    expect(pts.rows.map((r) => [r.label, r.total])).toEqual([['Asha', 3], ['Bo', 2], ['Unassigned', 1]]);
    expect(pts.segments.map((s) => [s.key, s.color])).toEqual([['s-todo', '#A8B0C2'], ['s-doing', '#FED800'], ['s-done', '#27D280']]);

    const lab = pivotInsights(issues, lookups, { measure: 'count', slice: 'label', segment: 'none' });
    expect(lab.rows.map((r) => [r.key, r.label, r.total])).toEqual([['l1', 'bug', 2], ['l2', 'ux', 1], ['none', 'No label', 1]]);
    expect(lab.rows[0]!.color).toBe('#F00');
    expect(lab.rows[1]!.color).toBeNull();

    // Unknown ids degrade to a label, never a crash.
    const unk = pivotInsights([issue({ id: 'q', state_id: 'ghost', assignee_user_id: 'nobody', milestone_id: 'gone' })], lookups, { measure: 'count', slice: 'assignee', segment: 'none' });
    expect(unk.rows).toEqual([{ key: 'nobody', label: 'Unknown member', total: 1, cells: [{ key: 'total', label: 'Total', value: 1 }] }]);
    expect(pivotInsights([], lookups, PM_INSIGHTS_DEFAULT)).toEqual({ rows: [], segments: [], total: 0 });
  });

  it('buildProgressSeries: Monday-anchored UTC weeks, end-of-week state, canceled leaves scope from its week, ≥1 point, 104-week cap, `from`', () => {
    expect(buildProgressSeries([], { to: '2026-09-17T00:00:00Z' })).toEqual([]);
    // Thursday 2026-09-17 → this week's Monday is 2026-09-14.
    expect(weekMondayISO('2026-09-17T23:00:00Z')).toBe('2026-09-14');
    expect(weekMondayISO('2026-09-13T23:59:59Z')).toBe('2026-09-07'); // Sunday belongs to the week before
    expect(weekMondayISO('2026-09-14T00:00:00Z')).toBe('2026-09-14');

    const issues = [
      issue({ id: 'a', created_at: '2026-08-25T09:00:00Z', started_at: '2026-08-26T09:00:00Z', completed_at: '2026-09-02T09:00:00Z' }), // wk Aug 24: started · wk Aug 31: done
      issue({ id: 'b', created_at: '2026-09-01T09:00:00Z' }), // wk Aug 31: scope only
      issue({ id: 'c', created_at: '2026-08-25T09:00:00Z', canceled_at: '2026-09-08T09:00:00Z' }), // in scope for two weeks, gone from wk Sep 7
      issue({ id: 'd', created_at: '2026-09-15T09:00:00Z', completed_at: '2026-09-15T10:00:00Z' }), // done without a started stamp still counts as started
      issue({ id: 'e', created_at: '2026-08-25T09:00:00Z', state_id: S.dead.id }), // canceled by category, no stamp → never in scope (with states)
    ];
    const to = '2026-09-17T12:00:00Z';
    expect(buildProgressSeries(issues, { to, states: lookups.states })).toEqual([
      { week: '2026-08-24', scope: 2, started: 1, done: 0 },
      { week: '2026-08-31', scope: 3, started: 1, done: 1 },
      { week: '2026-09-07', scope: 2, started: 1, done: 1 },
      { week: '2026-09-14', scope: 3, started: 2, done: 2 },
    ]);
    // Without states, `e` is a plain live issue.
    expect(buildProgressSeries(issues, { to })[0]).toEqual({ week: '2026-08-24', scope: 3, started: 1, done: 0 });
    // `from` narrows the left edge; the current week alone is one point.
    expect(buildProgressSeries(issues, { from: '2026-09-10T00:00:00Z', to }).map((p) => p.week)).toEqual(['2026-09-07', '2026-09-14']);
    expect(buildProgressSeries([issue({ id: 'z', created_at: to })], { to })).toEqual([{ week: '2026-09-14', scope: 1, started: 0, done: 0 }]);
    // An issue created after `to` (clock skew) still yields the current week, at zero.
    expect(buildProgressSeries([issue({ id: 'f', created_at: '2026-10-01T00:00:00Z' })], { to })).toEqual([{ week: '2026-09-14', scope: 0, started: 0, done: 0 }]);
    // Cap: 3 years of history → the most recent 104 weeks only, ending this week.
    const old = buildProgressSeries([issue({ id: 'o', created_at: '2023-01-02T00:00:00Z' })], { to });
    expect(old).toHaveLength(104);
    expect(old[old.length - 1]!.week).toBe('2026-09-14');
    expect(old[0]!.week).toBe(isoDay(addDays(new Date('2026-09-14T00:00:00Z'), -103 * 7)));
  });

  it('predictCompletion: null under 2 complete weeks; mean of the last 4 complete-week deltas; null at zero velocity or nothing left; 52-week cap', () => {
    const today = '2026-09-17T12:00:00Z'; // this week = 2026-09-14
    const pt = (week: string, scope: number, done: number): PmProgressPoint => ({ week, scope, started: done, done });
    expect(predictCompletion([], today)).toEqual({ velocity_per_week: null, predicted_completion: null });
    // One complete week + the current one → not enough history.
    expect(predictCompletion([pt('2026-09-07', 10, 2), pt('2026-09-14', 10, 3)], today)).toEqual({ velocity_per_week: null, predicted_completion: null });
    // Two complete weeks: deltas 2 (from nothing) and 2 → velocity 2; remaining 6 → 3 weeks → Oct 8.
    expect(predictCompletion([pt('2026-08-31', 10, 2), pt('2026-09-07', 10, 4), pt('2026-09-14', 10, 4)], today)).toEqual({
      velocity_per_week: 2,
      predicted_completion: '2026-10-08',
    });
    // Only the last 4 complete weeks count: a fast start six weeks ago is ignored.
    const series = [
      pt('2026-08-03', 40, 20), // ignored (older than the window)
      pt('2026-08-10', 40, 21),
      pt('2026-08-17', 40, 22),
      pt('2026-08-24', 40, 23),
      pt('2026-08-31', 40, 24),
      pt('2026-09-07', 40, 25), // window = Aug 17 · Aug 24 · Aug 31 · Sep 7 → deltas 1,1,1,1
      pt('2026-09-14', 40, 25), // current week — not complete, not counted
    ];
    const r = predictCompletion(series, today);
    expect(r.velocity_per_week).toBe(1);
    expect(r.predicted_completion).toBe('2026-12-31'); // 15 left / 1 per week → 15 weeks
    // Zero velocity → no date, velocity reported.
    expect(predictCompletion([pt('2026-08-31', 5, 0), pt('2026-09-07', 5, 0), pt('2026-09-14', 5, 1)], today)).toEqual({ velocity_per_week: 0, predicted_completion: null });
    // Nothing left → no date.
    expect(predictCompletion([pt('2026-08-31', 4, 2), pt('2026-09-07', 4, 4), pt('2026-09-14', 4, 4)], today)).toEqual({ velocity_per_week: 2, predicted_completion: null });
    // Cap at 52 weeks out.
    const slow = predictCompletion([pt('2026-08-31', 1000, 1), pt('2026-09-07', 1000, 2), pt('2026-09-14', 1000, 2)], today);
    expect(slow.velocity_per_week).toBe(1);
    expect(slow.predicted_completion).toBe('2027-09-16');
  });

  it('pivotInsights: rows with the same label keep a stable order (key tiebreak) — two "Asha"s, two unknown members', () => {
    const twins: PmInsightLookups = { ...lookups, users: { 'u-b': 'Asha', 'u-a': 'Asha' } };
    const issues = [
      issue({ id: '1', assignee_user_id: 'u-b' }),
      issue({ id: '2', assignee_user_id: 'u-a' }),
      issue({ id: '3', assignee_user_id: 'ghost-z' }),
      issue({ id: '4', assignee_user_id: 'ghost-a' }),
    ];
    const keys = (rows: PmInsightIssue[]) => pivotInsights(rows, twins, { measure: 'count', slice: 'assignee', segment: 'none' }).rows.map((r) => r.key);
    // Same result whatever order the issues arrive in.
    expect(keys(issues)).toEqual(['u-a', 'u-b', 'ghost-a', 'ghost-z']);
    expect(keys([...issues].reverse())).toEqual(['u-a', 'u-b', 'ghost-a', 'ghost-z']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Review additions — the payload cap
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M/B — InsightsService.get payload cap', () => {
  // Cap 3 (not the module-level cappedSvc's 5): tight enough that the newest
  // three are unambiguous in the fixture (W1+2 · W1+3 · w0Event).
  class ReviewCappedInsightsService extends InsightsService {
    protected override readonly issueCap: number = 3;
  }

  it('ships at most `issue_cap` issues — the most recent by created_at, oldest-first on the wire — and flags `truncated`', async () => {
    const full = (await insightsSvc.get(T1, ownerId, project)).data;
    expect(full.truncated).toBe(false);
    expect(full.issue_cap).toBe(PM_INSIGHTS_ISSUE_CAP);
    expect(full.issues).toHaveLength(12);
    // Ascending by created_at on the wire (the series builder and the client both assume it).
    const stamps = full.issues.map((i) => i.created_at);
    expect([...stamps].sort()).toEqual(stamps);

    const capped = new ReviewCappedInsightsService(dbSvc, visibility, projectsSvc, teamsSvc, domainEventsSvc);
    const d = (await capped.get(T1, ownerId, project)).data;
    expect(d.truncated).toBe(true);
    expect(d.issue_cap).toBe(3);
    expect(d.issues).toHaveLength(3);
    // The three newest: created W1+2 ("Todo, two labels"), W1+3 ("Backlog for member"), w0Event ("Todo fresh").
    expect(d.issues.map((i) => i.created_at)).toEqual(stamps.slice(-3));
    expect(new Date(d.issues[2]!.created_at).getTime()).toBe(w0Event.getTime());
    // Lookups follow the shipped rows: only the states / assignees they reference.
    expect(d.states.map((s) => s.category).sort()).toEqual(['backlog', 'unstarted']);
    expect(Object.keys(d.users)).toEqual([memberId]);
    // The series is built from the shipped rows too — the card labels it "most recent N".
    expect(d.series[d.series.length - 1]).toEqual({ week: isoDay(W0), scope: 3, started: 0, done: 0 });
  });
});
