/**
 * Founder round N (2026-09-22) — agent B: uploaded photos must reach every
 * CRM + FAM person list.
 *
 * The photo upload writes ONLY `users.avatar_key` (a private R2 key);
 * `users.avatar_url` is the legacy public column kept as a read fallback. Any
 * endpoint that returns an internal user (deal/lead owner, rep, activity
 * assignee, leaderboard rep, goal holder, tenant member, auditor, feedback
 * author) therefore has to join `users`, sign the key and strip it again.
 *
 * Three seeded people pin all three states on every changed endpoint:
 *   K — keyed      (avatar_key set)          → signed url  ('signed:<key>')
 *   L — legacy     (avatar_url only)         → the legacy url verbatim
 *   N — neither    (both columns null)       → null
 * and every response is stringified to prove no raw `*_avatar_key` /
 * `avatarKey` ever leaves the API.
 *
 * Service-level against the real Postgres; MediaService is the usual stub
 * (`servedUrl(k, l) => k ? 'signed:'+k : l`) so signing is deterministic.
 */
import 'dotenv/config';
import 'reflect-metadata';
import * as crypto from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { db, dbAdmin } from '@flicks/db';
import {
  activities,
  deals,
  directoryCompanies,
  feedbackSubmissions,
  leads,
  memberships,
  pipelines,
  pipelineStages,
  salesGoals,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
// §6 pins the guards that make these avatar-bearing reads safe. Controllers are
// imported for their DECORATOR METADATA only — nothing here instantiates them.
import { ROLES_KEY } from '../core/auth/decorators/roles.decorator';
import { FamController } from '../modules/fam/fam.controller';
import { FeedbackController } from '../modules/feedback/feedback.controller';
import { DealsController } from '../modules/crm/deals.controller';
import { LeadsController } from '../modules/crm/leads.controller';
import { ActivitiesController } from '../modules/crm/activities.controller';
import { ReportsController } from '../modules/crm/reports.controller';
import { DealsService } from '../modules/crm/deals.service';
import { LeadsService } from '../modules/crm/leads.service';
import { ActivitiesService } from '../modules/crm/activities.service';
import { ReportsService } from '../modules/crm/reports.service';
import { MergeService } from '../modules/crm/merge.service';
import { FxService } from '../modules/crm/fx.service';
import { FamService } from '../modules/fam/fam.service';
import { FeedbackService } from '../modules/feedback/feedback.service';
import type { MediaService } from '../modules/media/media.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { AnalyticsService } from '../core/analytics/analytics.service';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');

// ─── Wiring ──────────────────────────────────────────────────────────────────

// Every size a service asked for. A person chip must always ask for 64 — the
// 64px variant is a DIFFERENT object key (`…_64.webp`), so a caller that drops
// the size argument silently serves the 256px file (servedUrl's default) and
// burns bandwidth on every row. The stub therefore bakes the size into the url
// it returns, which pins `64` on every endpoint asserted below at once.
const askedSizes: number[] = [];
const media = {
  servedUrl: async (k: string | null, l: string | null, size: 256 | 64 = 256) => {
    askedSizes.push(size);
    return k ? `signed:${size}:${k.replace('_256.webp', `_${size}.webp`)}` : l;
  },
} as unknown as MediaService;

const dbSvc = new DatabaseService();
const audit = { log: async () => {}, logPlatform: async () => {} } as unknown as AuditService;
const analyticsStub = { capture: () => {}, track: () => {} } as unknown as AnalyticsService;
const eventsStub = { publish: jest.fn(async () => 'evt') };
const notifyStub = { createInAppNotification: jest.fn(async () => undefined) };
const presenceStub = { statusOf: jest.fn(async () => 'available') };
const emitter = new EventEmitter2();
const fx = new FxService(dbAdmin as never, { get: () => undefined } as never);

// Every service takes the media service as its LAST, @Optional() ctor arg.
const dealsSvc = new DealsService(dbSvc, audit, eventsStub as never, fx, emitter, {} as never, media);
const leadsSvc = new LeadsService(dbSvc, audit, eventsStub as never, presenceStub as never, dealsSvc, media);
const activitiesSvc = new ActivitiesService(dbSvc, audit, eventsStub as never, notifyStub as never, presenceStub as never, media);
const reportsSvc = new ReportsService(dbSvc, audit, media);
const famSvc = new FamService(dbAdmin as never, audit, {} as never, {} as never, analyticsStub as never, media);
const feedbackSvc = new FeedbackService(dbAdmin as never, dbSvc, analyticsStub, audit, media);

// ─── The RLS-off model (security review, §6) ────────────────────────────────
//
// Round F's production incident was a DATABASE_URL pointed at a BYPASSRLS
// role: every policy silently stopped applying and reads that leaned on RLS
// alone returned EVERY tenant's rows. `withTenant` now re-assumes the app role
// per transaction so the real pool can't regress that way — which is exactly
// why the explicit `eq(<table>.tenant_id, tenantId)` predicates (house rule 1)
// can rot unnoticed: nothing exercises them.
//
// This DatabaseService double runs each callback straight on the service-role
// pool: no `app.tenant_id`, no role drop, no RLS. It is the only thing in the
// suite that can tell "the query is scoped" apart from "the connection is
// scoped" — and Round N put PEOPLE (names + signed photos) on these reads, so
// the difference is now a face leak, not a number leak. Read-only by design;
// never point a write path at it.
const rlsOffDb = {
  withTenant: <T>(_tenantId: string, cb: (tx: never) => Promise<T>) => cb(dbAdmin as never),
} as unknown as DatabaseService;

const rlsOffDeals = new DealsService(rlsOffDb, audit, eventsStub as never, fx, emitter, {} as never, media);
const rlsOffActivities = new ActivitiesService(rlsOffDb, audit, eventsStub as never, notifyStub as never, presenceStub as never, media);
const rlsOffReports = new ReportsService(rlsOffDb, audit, media);
// The one write path pointed at the double, and only because the assertion is
// that it REFUSES before it writes anything: §19.7 offboarding hands one
// member's whole book of work to another, keyed on two DTO user ids, and a
// user legitimately belongs to several workspaces. If its membership guard
// ever loses its tenant predicate this throws nothing and moves rows instead,
// which is exactly what the test below has to be able to see.
const rlsOffMerge = new MergeService(rlsOffDb, audit, eventsStub as never);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LEGACY_URL = 'https://legacy.example.test/avatars/legacy-person.png';

let T1: string; // the workspace under test
let T2: string; // a second workspace, used only for the auditor registry
let pipelineId: string;
let openStageId: string;
let wonStageId: string;
let companyId: string;

let K: string; // keyed    → signed url
let L: string; // legacy   → legacy url
let N: string; // neither  → null
const userIds: string[] = [];

const dealOf: Record<'K' | 'L' | 'N', string> = { K: '', L: '', N: '' };

/** The expected `*_avatar_url` for each seeded person, given the media stub. */
let expected: Record<string, string | null>;

const thisMonth = new Date().toISOString().slice(0, 7);
const closeDate = `${thisMonth}-15`;
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

async function mkUser(
  label: string,
  role: 'owner' | 'manager' | 'employee',
  avatar: { key?: string; url?: string },
): Promise<string> {
  const [u] = await dbAdmin
    .insert(users)
    .values({
      email: `rn-${label}-${rid()}@t.test`,
      full_name: `${label} Person`,
      status: 'active',
      avatar_key: avatar.key ?? null,
      avatar_url: avatar.url ?? null,
    })
    .returning();
  await dbAdmin.insert(memberships).values({ tenant_id: T1, user_id: u!.id, role, status: 'active' });
  userIds.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  const mkTenant = async (name: string) => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `${name} ${rid()}`, slug: `rn-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
      .returning();
    return t!.id;
  };
  T1 = await mkTenant('RN Avatars');
  T2 = await mkTenant('RN Auditee');

  // Roles: none of them is an auditor/guest in T1, so all three land on the
  // CRM reports leaderboard as well as in reps / FAM members.
  K = await mkUser('keyed', 'owner', { key: `users/keyed-${rid()}/avatar/${rid()}_256.webp` });
  L = await mkUser('legacy', 'manager', { url: LEGACY_URL });
  N = await mkUser('none', 'employee', {});

  const [keyed] = await dbAdmin.select({ k: users.avatar_key }).from(users).where(eq(users.id, K));
  // Matches the stub above: a person chip is the 64px variant, so the expected
  // url names size 64 AND the `_64.webp` object — an endpoint that forgot the
  // size argument would serve the 256px key and fail here.
  expected = { [K]: `signed:64:${keyed!.k!.replace('_256.webp', '_64.webp')}`, [L]: LEGACY_URL, [N]: null };

  // The FAM console is driven by a platform admin.
  await dbAdmin.update(users).set({ is_platform_admin: true }).where(eq(users.id, K));

  // Pipeline + stages (mirrors the migration seed).
  const [pl] = await dbAdmin.insert(pipelines).values({ tenant_id: T1, name: 'Sales', is_default: true }).returning();
  pipelineId = pl!.id;
  const stageRows = await dbAdmin
    .insert(pipelineStages)
    .values([
      { tenant_id: T1, pipeline_id: pipelineId, name: 'Qualified', display_order: 0, win_probability: 80, stage_type: 'open' },
      { tenant_id: T1, pipeline_id: pipelineId, name: 'Won', display_order: 1, win_probability: 100, stage_type: 'won' },
      { tenant_id: T1, pipeline_id: pipelineId, name: 'Lost', display_order: 2, win_probability: 0, stage_type: 'lost' },
    ])
    .returning();
  openStageId = stageRows.find((s) => s.stage_type === 'open')!.id;
  wonStageId = stageRows.find((s) => s.stage_type === 'won')!.id;

  const [co] = await dbAdmin
    .insert(directoryCompanies)
    .values({ tenant_id: T1, name: `Avatar Co ${rid()}`, created_by: K })
    .returning();
  companyId = co!.id;

  // One open deal per person, all on the same company so listForCompany
  // (the shared listForRef projection) returns all three.
  for (const [tag, owner] of [['K', K], ['L', L], ['N', N]] as const) {
    const res = await dealsSvc.create(T1, K, {
      title: `${tag} deal`,
      pipeline_id: pipelineId,
      stage_id: openStageId,
      company_id: companyId,
      owner_user_id: owner,
      value_amount: 100000,
      currency: 'INR',
      expected_close_date: closeDate,
    });
    dealOf[tag] = res.data.id;
  }

  // One lead per person (an owned lead is born "working").
  for (const owner of [K, L, N]) {
    await leadsSvc.create(T1, K, { first_name: `Lead-${rid()}`, email: `lead-${rid()}@t.test`, owner_user_id: owner });
  }

  // Activities: one open on K, plus two of other people's tasks COMPLETED by K
  // (the completed bucket carries teammates' rows — that is what surfaces L/N).
  await activitiesSvc.create(T1, K, { type: 'task', subject: 'K own task', due_at: tomorrow(), deal_id: dealOf.K });
  for (const assignee of [L, N]) {
    const a = await activitiesSvc.create(T1, K, {
      type: 'task',
      subject: `task for ${assignee}`,
      due_at: tomorrow(),
      assignee_user_id: assignee,
    });
    await activitiesSvc.complete(T1, K, a.data.id);
  }

  // Goals: one per person this month + a team row (user_id null).
  await dbAdmin.insert(salesGoals).values([
    { tenant_id: T1, user_id: K, period: thisMonth, target_base: '500000.00', created_by: K },
    { tenant_id: T1, user_id: L, period: thisMonth, target_base: '400000.00', created_by: K },
    { tenant_id: T1, user_id: N, period: thisMonth, target_base: '300000.00', created_by: K },
    { tenant_id: T1, user_id: null, period: thisMonth, target_base: '900000.00', created_by: K },
  ]);

  // Auditor registry: the same three people audit T2.
  await dbAdmin.insert(memberships).values(
    [K, L, N].map((u) => ({
      tenant_id: T2,
      user_id: u,
      role: 'auditor' as const,
      status: 'active' as const,
      is_external: true,
    })),
  );

  // FAM feedback inbox: one submission per person.
  await dbAdmin.insert(feedbackSubmissions).values(
    [K, L, N].map((u) => ({ tenant_id: T1, user_id: u, category: 'idea', message: `note from ${u}`, contact_ok: true })),
  );
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(inArray(tenants.id, [T1, T2]));
  if (userIds.length) await dbAdmin.delete(users).where(inArray(users.id, userIds));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** No raw storage key — under any of its spellings — may reach a response. */
function noKeysLeak(payload: unknown) {
  const json = JSON.stringify(payload);
  // A stored key is a private R2 object path — it must never appear under ANY
  // of its spellings. `avatarUrlLegacy` is here too: it is the raw fallback
  // column FAM selects alongside the key, and the mapper drops both, so if it
  // ever shows up the strip-and-sign step was skipped on that branch.
  for (const forbidden of [
    'owner_avatar_key',
    'user_avatar_key',
    'assignee_avatar_key',
    'avatar_key',
    'avatarKey',
    'avatarUrlLegacy',
  ]) {
    expect(json).not.toContain(forbidden);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. CRM — deals
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — CRM deals carry owner_avatar_url', () => {
  it('board cards: keyed → signed, legacy → legacy url, neither → null', async () => {
    const res = await dealsSvc.board(T1, pipelineId);
    const cards = res.data.columns.flatMap((c) => c.cards);
    for (const [tag, owner] of [['K', K], ['L', L], ['N', N]] as const) {
      const card = cards.find((c) => c.id === dealOf[tag])!;
      expect(card.owner_avatar_url).toBe(expected[owner]);
    }
    noKeysLeak(res);
  });

  it('list() — the open/closed deals table — carries owner_name + owner_avatar_url', async () => {
    const res = await dealsSvc.list(T1, { status: 'open', pipeline_id: pipelineId });
    expect(res.data).toHaveLength(3);
    for (const [tag, owner] of [['K', K], ['L', L], ['N', N]] as const) {
      const row = res.data.find((r) => r.id === dealOf[tag])!;
      expect(row.owner_name).toBeTruthy();
      expect(row.owner_avatar_url).toBe(expected[owner]);
    }
    noKeysLeak(res);
  });

  it('the CLOSED view keeps the pair after a deal is won', async () => {
    await dealsSvc.moveStage(T1, K, dealOf.L, { stage_id: wonStageId });
    const res = await dealsSvc.list(T1, { status: 'closed', pipeline_id: pipelineId });
    const row = res.data.find((r) => r.id === dealOf.L)!;
    expect(row.status).toBe('won');
    expect(row.owner_avatar_url).toBe(expected[L]);
    noKeysLeak(res);
    // Put it back so the forecast/board assertions below still see 3 open deals.
    await dealsSvc.moveStage(T1, K, dealOf.L, { stage_id: openStageId });
  });

  it('listForCompany (the shared listForRef projection) carries the pair', async () => {
    const res = await dealsSvc.listForCompany(T1, companyId);
    expect(res.data).toHaveLength(3);
    for (const [tag, owner] of [['K', K], ['L', L], ['N', N]] as const) {
      expect(res.data.find((r) => r.id === dealOf[tag])!.owner_avatar_url).toBe(expected[owner]);
    }
    noKeysLeak(res);
  });

  it('the deal detail page carries the pair for each owner', async () => {
    for (const [tag, owner] of [['K', K], ['L', L], ['N', N]] as const) {
      const res = await dealsSvc.get(T1, dealOf[tag]);
      expect(res.data.owner_avatar_url).toBe(expected[owner]);
      noKeysLeak(res);
    }
  });

  it('reps() — the owner picker — returns avatar_url and never avatar_key', async () => {
    const res = await dealsSvc.reps(T1);
    expect(res.data).toHaveLength(3);
    for (const u of [K, L, N]) {
      expect(res.data.find((r) => r.user_id === u)!.avatar_url).toBe(expected[u]);
    }
    noKeysLeak(res);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. CRM — leads
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — the leads inbox carries owner_avatar_url', () => {
  it('every owned lead row has owner_name + owner_avatar_url', async () => {
    const res = await leadsSvc.list(T1, 'working');
    expect(res.data).toHaveLength(3);
    for (const u of [K, L, N]) {
      const row = res.data.find((r) => r.owner_user_id === u)!;
      expect(row.owner_name).toBeTruthy();
      expect(row.owner_avatar_url).toBe(expected[u]);
    }
    noKeysLeak(res);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. CRM — activities (My Activities, the primary list projection)
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — My Activities carries assignee_avatar_url', () => {
  it('open + completed buckets resolve the assignee face; the key never leaves', async () => {
    const res = await activitiesSvc.mine(T1, K);
    const all = [...res.data.overdue, ...res.data.today, ...res.data.upcoming, ...res.data.completed];
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const u of [K, L, N]) {
      const row = all.find((r) => r.assignee_user_id === u)!;
      expect(row).toBeDefined();
      expect(row.assignee_name).toBeTruthy();
      expect(row.assignee_avatar_url).toBe(expected[u]);
    }
    noKeysLeak(res);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. CRM — reports (leaderboard, forecast drill-down, goals)
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — CRM reports carry the person avatar', () => {
  it('the activity leaderboard rows carry avatar_url; the aggregates are untouched', async () => {
    const res = await reportsSvc.overview(T1, { pipeline_id: pipelineId });
    const lb = res.data!.leaderboard;
    expect(lb).toHaveLength(3);
    for (const u of [K, L, N]) {
      const row = lb.find((r) => r.user_id === u)!;
      expect(row.avatar_url).toBe(expected[u]);
      // Additive only — the counters/goal fields still answer as before.
      expect(typeof row.calls).toBe('number');
      expect(typeof row.meetings).toBe('number');
      expect(typeof row.tasks).toBe('number');
      expect(row.goal_target).toBeGreaterThan(0);
    }
    // A leaderboard row is not a deal and not a goal — it IS the person, so the
    // field is the bare `avatar_url`. The web chip reads exactly that one name
    // (it used to hedge across `user_avatar_url ?? owner_avatar_url` and so
    // rendered initials forever), which makes the spelling a contract now.
    for (const row of lb) {
      expect(Object.keys(row)).toContain('avatar_url');
      expect(Object.keys(row)).not.toContain('user_avatar_url');
      expect(Object.keys(row)).not.toContain('owner_avatar_url');
    }
    // win/loss stays a name-keyed aggregate (no per-face rows there).
    expect(res.data!.win_loss.by_owner.every((r) => typeof r.key === 'string')).toBe(true);
    noKeysLeak(res);
  });

  it('the forecast drill-down deals carry owner_avatar_url', async () => {
    const res = await reportsSvc.forecast(T1, { months: 2 });
    const month = res.data.find((r) => r.period === thisMonth)!;
    expect(month.deals.length).toBeGreaterThanOrEqual(3);
    for (const [tag, owner] of [['K', K], ['L', L], ['N', N]] as const) {
      const row = month.deals.find((d) => d.id === dealOf[tag])!;
      expect(row.owner_avatar_url).toBe(expected[owner]);
    }
    noKeysLeak(res);
  });

  it('the goals table carries user_avatar_url; the team row stays null on both', async () => {
    const res = await reportsSvc.listGoals(T1, thisMonth);
    expect(res.data).toHaveLength(4);
    for (const u of [K, L, N]) {
      const row = res.data.find((r) => r.user_id === u)!;
      expect(row.user_name).toBeTruthy();
      expect(row.user_avatar_url).toBe(expected[u]);
    }
    const team = res.data.find((r) => r.user_id === null)!;
    expect(team.user_name).toBeNull();
    expect(team.user_avatar_url).toBeNull();
    // Same contract note as the leaderboard: a goal row is user-shaped, so the
    // one spelling the web may read is `user_avatar_url`.
    for (const row of res.data) expect(Object.keys(row)).not.toContain('owner_avatar_url');
    noKeysLeak(res);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. FAM — tenant members, auditor registry, feedback inbox
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — the FAM console carries faces', () => {
  it('listTenantMembers resolves avatarUrl per member and never leaks avatarKey', async () => {
    const res = await famSvc.listTenantMembers(T1);
    expect(res.data).toHaveLength(3);
    for (const u of [K, L, N]) {
      const row = res.data.find((r) => r.userId === u)!;
      expect(row.fullName).toBeTruthy();
      expect(row.avatarUrl).toBe(expected[u]);
    }
    noKeysLeak(res);
  });

  it('the auditor registry resolves avatarUrl once per auditor', async () => {
    const res = await famSvc.getAuditorRegistry();
    for (const u of [K, L, N]) {
      const row = res.data.find((r) => r.userId === u)!;
      expect(row).toBeDefined();
      expect(row.companies.map((c) => c.tenantId)).toContain(T2);
      expect(row.avatarUrl).toBe(expected[u]);
    }
    noKeysLeak(res.data.filter((r) => [K, L, N].includes(r.userId)));
  });

  it('the feedback inbox carries user_avatar_url for the author', async () => {
    const res = await feedbackSvc.famList({ tenantId: T1 });
    expect(res.data).toHaveLength(3);
    for (const u of [K, L, N]) {
      const row = res.data.find((r) => r.user_id === u)!;
      expect(row.user_name).toBeTruthy();
      expect(row.user_avatar_url).toBe(expected[u]);
    }
    noKeysLeak(res);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. SECURITY REVIEW — the `users` join is the new risk surface
//
// `users` is a PLATFORM-GLOBAL table joined by id from tenant-scoped rows, so
// every one of Round N's joins is only as isolated as the predicate on the row
// it hangs off. Three things are pinned here:
//
//   a) the face never outruns the name — a deal owned by someone who is not a
//      member of this workspace resolves BOTH to null, never a photo alone
//      (a photo proves a person exists; that is the same disclosure the name
//      is, so the two must always travel together);
//   b) nothing from another workspace reaches a T1 response, including for a
//      user who legitimately belongs to BOTH workspaces (K audits T2);
//   c) the explicit tenant predicates — not RLS — are what does (b), proven by
//      re-running the same reads on the RLS-off double above.
//
// Fixtures live in this describe's own beforeAll so the per-endpoint counts
// asserted by sections 1-5 (which run first) stay exactly as they were.
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N security — the avatar joins stay anchored to the tenant', () => {
  let F: string; // foreign: a member of T2 ONLY, with a photo
  let t2Pipeline: string;
  let t2Deal: string;
  let t2DealTitle: string;
  let fName: string;
  let fKey: string;
  let orphanDeal: string; // a T1 deal whose owner is no longer a T1 member

  beforeAll(async () => {
    const [f] = await dbAdmin
      .insert(users)
      .values({
        email: `rn-foreign-${rid()}@t.test`,
        full_name: `Foreign Person ${rid()}`,
        status: 'active',
        avatar_key: `users/foreign-${rid()}/avatar/${rid()}_256.webp`,
      })
      .returning();
    F = f!.id;
    fName = f!.full_name;
    fKey = f!.avatar_key!;
    userIds.push(F);
    await dbAdmin.insert(memberships).values({ tenant_id: T2, user_id: F, role: 'owner', status: 'active' });

    // T2's own CRM: a pipeline, an open stage, a deal owned by the foreign
    // person, and an activity assigned to F that K (an auditor in T2, i.e. a
    // user who belongs to BOTH workspaces) completed.
    const [t2pl] = await dbAdmin.insert(pipelines).values({ tenant_id: T2, name: 'T2 Sales', is_default: true }).returning();
    t2Pipeline = t2pl!.id;
    const [t2stage] = await dbAdmin
      .insert(pipelineStages)
      .values({ tenant_id: T2, pipeline_id: t2Pipeline, name: 'T2 Qualified', display_order: 0, win_probability: 50, stage_type: 'open' })
      .returning();
    t2DealTitle = `T2 secret deal ${rid()}`;
    const [d2] = await dbAdmin
      .insert(deals)
      .values({
        tenant_id: T2,
        pipeline_id: t2Pipeline,
        stage_id: t2stage!.id,
        title: t2DealTitle,
        owner_user_id: F,
        currency: 'INR',
        value_amount: '777000.00',
        value_base_amount: '777000.00',
        expected_close_date: closeDate,
        created_by: F,
      })
      .returning();
    t2Deal = d2!.id;
    await dbAdmin.insert(activities).values({
      tenant_id: T2,
      type: 'task',
      subject: `T2 secret task ${rid()}`,
      assignee_user_id: F,
      completed_by: K, // K works in both workspaces
      completed_at: new Date(),
      created_by: F,
    });

    // The offboarded-owner case: a T1 deal still pointing at F, who has no T1
    // membership at all (ownership set before a transfer, or the member was
    // removed). Inserted with dbAdmin because assertRefsInTenant correctly
    // refuses to CREATE such a deal — the point is that old rows exist.
    const [orphan] = await dbAdmin
      .insert(deals)
      .values({
        tenant_id: T1,
        pipeline_id: pipelineId,
        stage_id: openStageId,
        title: `Orphaned owner deal ${rid()}`,
        owner_user_id: F,
        currency: 'INR',
        value_amount: '10000.00',
        value_base_amount: '10000.00',
        expected_close_date: closeDate,
        created_by: K,
      })
      .returning();
    orphanDeal = orphan!.id;
  });

  afterAll(async () => {
    // Leave T1 as sections 1-5 found it; T2's rows go with the tenant.
    await dbAdmin.delete(deals).where(eq(deals.id, orphanDeal));
  });

  /** No row belonging to the other workspace may appear. */
  const noForeignWorkspace = (payload: unknown) => {
    const json = JSON.stringify(payload);
    expect(json).not.toContain(t2Deal);
    expect(json).not.toContain(t2DealTitle);
    expect(json).not.toContain(T2);
  };

  /**
   * …and no trace of the person who is not a member here — name OR photo.
   * These are deliberately separate: which ROWS a response contains is the
   * query's tenant predicate, while which PEOPLE it can name off those rows is
   * the `users` RLS policy (members of app.tenant_id only). The RLS-off block
   * below can only hold the first line, which is exactly the point of it.
   */
  const noForeignPerson = (payload: unknown) => {
    const json = JSON.stringify(payload);
    expect(json).not.toContain(fName);
    expect(json).not.toContain(fKey);
    // Both spellings: a person chip is signed at 64, which rewrites the key to
    // `…_64.webp`, so the stored `_256` key alone would no longer catch a
    // foreign face that was signed and served.
    expect(json).not.toContain(fKey.replace('_256.webp', '_64.webp'));
  };

  const noForeignLeak = (payload: unknown) => {
    noForeignWorkspace(payload);
    noForeignPerson(payload);
  };

  // ── a) the photo never outruns the name ───────────────────────────────────

  it('a deal owned by a non-member resolves name AND photo to null — never a photo alone', async () => {
    const detail = await dealsSvc.get(T1, orphanDeal);
    expect(detail.data.owner_user_id).toBe(F);
    expect(detail.data.owner_name).toBeNull();
    expect(detail.data.owner_avatar_url).toBeNull();
    noKeysLeak(detail);

    const card = (await dealsSvc.board(T1, pipelineId)).data.columns
      .flatMap((c) => c.cards)
      .find((c) => c.id === orphanDeal)!;
    expect(card.owner_name).toBeNull();
    expect(card.owner_avatar_url).toBeNull();

    const row = (await dealsSvc.list(T1, { status: 'open', pipeline_id: pipelineId })).data
      .find((r) => r.id === orphanDeal)!;
    expect(row.owner_name).toBeNull();
    expect(row.owner_avatar_url).toBeNull();

    const drill = (await reportsSvc.forecast(T1, { months: 2 })).data
      .find((m) => m.period === thisMonth)!.deals
      .find((d) => d.id === orphanDeal)!;
    expect(drill.owner_name).toBeNull();
    expect(drill.owner_avatar_url).toBeNull();
  });

  // ── b) no foreign person or workspace on any changed read ─────────────────

  it('every changed CRM read is free of the other workspace, even for a user who is in both', async () => {
    noForeignLeak(await dealsSvc.board(T1, pipelineId));
    noForeignLeak(await dealsSvc.list(T1, { status: 'open', pipeline_id: pipelineId }));
    noForeignLeak(await dealsSvc.listForCompany(T1, companyId));
    noForeignLeak(await dealsSvc.reps(T1));
    noForeignLeak(await leadsSvc.list(T1, 'working'));
    // K is an auditor in T2 and completed a T2 task there; My Activities in T1
    // must still be T1-only — it filters on a USER id, which spans workspaces.
    noForeignLeak(await activitiesSvc.mine(T1, K));
    noForeignLeak(await reportsSvc.overview(T1, { pipeline_id: pipelineId }));
    noForeignLeak(await reportsSvc.forecast(T1, { months: 2 }));
    noForeignLeak(await reportsSvc.listGoals(T1, thisMonth));
  });

  it('a pipeline_id naming another workspace reads as empty, not as that workspace', async () => {
    const res = await reportsSvc.overview(T1, { pipeline_id: t2Pipeline });
    expect(res.data).toBeNull();
    noForeignLeak(res);
  });

  it('a deal id from another workspace is Not Found, not a deal with a face on it', async () => {
    await expect(dealsSvc.get(T1, t2Deal)).rejects.toThrow(/not found/i);
  });

  // ── c) the predicates, not the connection, are doing the work ─────────────

  describe('with RLS not binding the connection (the round-F posture)', () => {
    it('My Activities stays in this workspace although the filter is a user id', async () => {
      const res = await rlsOffActivities.mine(T1, K);
      noForeignLeak(res);
    });

    it('the forecast drill-down stays in this workspace', async () => {
      const res = await rlsOffReports.forecast(T1, { months: 2 });
      const ids = res.data.flatMap((m) => m.deals.map((d) => d.id));
      expect(ids).toContain(orphanDeal);
      expect(ids).not.toContain(t2Deal);
      noForeignWorkspace(res);
      // The orphan's owner IS named here — with RLS off, `users` no longer
      // hides a non-member, and that is the policy's job, not this query's.
      // What still has to hold is that the photo never travels without the
      // name: the two come off the same row, both or neither.
      const orphan = res.data.flatMap((m) => m.deals).find((d) => d.id === orphanDeal)!;
      expect(typeof orphan.owner_name === 'string').toBe(orphan.owner_avatar_url !== null);
    });

    it('the report still refuses a pipeline_id from another workspace', async () => {
      const res = await rlsOffReports.overview(T1, { pipeline_id: t2Pipeline });
      expect(res.data).toBeNull();
      noForeignLeak(res);
    });

    it('the deal detail page still refuses a deal id from another workspace', async () => {
      await expect(rlsOffDeals.get(T1, t2Deal)).rejects.toThrow(/not found/i);
    });

    it('offboarding refuses to hand this workspace’s book of work to another workspace’s member', async () => {
      // F is an ACTIVE, non-auditor OWNER — of T2. Nothing about him qualifies
      // him to receive T1's open deals, activities and leads, and the only
      // thing that can say so is the guard's own tenant predicate.
      await expect(rlsOffMerge.reassign(T1, K, K, F)).rejects.toThrow(/active/i);
      // …and it refused BEFORE the bulk update, so K still owns his deals.
      const [stillK] = await dbAdmin
        .select({ owner: deals.owner_user_id })
        .from(deals)
        .where(eq(deals.id, dealOf.K))
        .limit(1);
      expect(stillK!.owner).toBe(K);
    });
  });

  // ── d) the platform-admin gate on the FAM-only avatar surfaces ────────────

  it('the cross-tenant avatar surfaces are still platform-admin only', () => {
    // getAuditorRegistry spans every workspace by design and listTenantMembers
    // takes a tenant id straight off the path — both are safe ONLY because
    // nothing but a platform admin can reach them. famList is the same deal.
    // `fam` is the top of the role hierarchy, so no tenant role satisfies it.
    expect(Reflect.getMetadata(ROLES_KEY, FamController.prototype.listTenantMembers)).toEqual(['fam']);
    expect(Reflect.getMetadata(ROLES_KEY, FamController.prototype.getAuditorRegistry)).toEqual(['fam']);
    expect(Reflect.getMetadata(ROLES_KEY, FeedbackController.prototype.famList)).toEqual(['fam']);
  });

  it('the CRM reads that gained a face are still behind the CRM grant guard', () => {
    // Round N only added fields; no guard may have moved while doing it.
    for (const controller of [DealsController, LeadsController, ActivitiesController, ReportsController]) {
      const guards = (Reflect.getMetadata('__guards__', controller) ?? []) as Array<{ name: string }>;
      expect(guards.map((g) => g.name)).toContain('CrmGrantGuard');
    }
  });

  // ── e) signing is best-effort: no signer must never fail a read ───────────

  it('without MediaService the same reads answer on the legacy column instead of throwing', async () => {
    const noMediaDeals = new DealsService(dbSvc, audit, eventsStub as never, fx, emitter, {} as never);
    const noMediaReports = new ReportsService(dbSvc, audit);
    const noMediaActivities = new ActivitiesService(dbSvc, audit, eventsStub as never, notifyStub as never, presenceStub as never);

    const reps = await noMediaDeals.reps(T1);
    expect(reps.data.find((r) => r.user_id === L)!.avatar_url).toBe(LEGACY_URL);
    expect(reps.data.find((r) => r.user_id === K)!.avatar_url).toBeNull(); // key unsigned → no url, not a raw key
    noKeysLeak(reps);

    const goals = await noMediaReports.listGoals(T1, thisMonth);
    expect(goals.data.find((r) => r.user_id === K)!.user_avatar_url).toBeNull();
    noKeysLeak(goals);

    const mine = await noMediaActivities.mine(T1, K);
    noKeysLeak(mine);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. IDENTITY — the "sign once per person" maps must be keyed by USER ID
//
// Round N traded per-row signing for a Map on the hot reads (the board's
// ownerAvatar, the leaderboard's repAvatar, My Activities' signedByAssignee,
// the auditor registry's byUser). A map keyed by anything but the user id — a
// display name being the obvious slip — collides for two people who share a
// name and hands one of them the OTHER person's photo. A face is an identity
// claim, so that is a disclosure bug, not a cosmetic one, and nothing else in
// this suite can see it: K/L/N all have distinct names.
//
// Also pinned here: the null-owner branch of the mapper (leads.owner_user_id
// is nullable), and that every signature this file triggered asked for 64px.
//
// Fixtures live in this describe's own beforeAll and are removed in its
// afterAll, so the per-endpoint counts asserted by sections 1-6 are untouched.
// ═════════════════════════════════════════════════════════════════════════════

describe('Round N — one signature per PERSON, never per name', () => {
  // The same display name for two different people, as a workspace with two
  // Priya Sharmas really has.
  const sharedName = `Same Name ${rid()}`;
  let A1: string;
  let A2: string;
  let urlA1: string;
  let urlA2: string;
  let dealA1: string;
  let dealA2: string;
  const actIds: string[] = [];
  let unownedLead: string;

  beforeAll(async () => {
    const mkTwin = async (tag: string) => {
      const key = `users/twin-${tag}-${rid()}/avatar/${rid()}_256.webp`;
      const [u] = await dbAdmin
        .insert(users)
        .values({
          email: `rn-twin-${tag}-${rid()}@t.test`,
          full_name: sharedName,
          status: 'active',
          avatar_key: key,
        })
        .returning();
      userIds.push(u!.id);
      // A member of T1 (so they reach reps / the leaderboard / FAM members) and
      // an auditor of T2 (so they reach the registry's per-auditor map).
      await dbAdmin.insert(memberships).values([
        { tenant_id: T1, user_id: u!.id, role: 'employee' as const, status: 'active' as const },
        { tenant_id: T2, user_id: u!.id, role: 'auditor' as const, status: 'active' as const, is_external: true },
      ]);
      return { id: u!.id, url: `signed:64:${key.replace('_256.webp', '_64.webp')}` };
    };
    const twinA = await mkTwin('a');
    const twinB = await mkTwin('b');
    A1 = twinA.id;
    urlA1 = twinA.url;
    A2 = twinB.id;
    urlA2 = twinB.url;
    // Distinct photos is the whole point — a collision would be invisible
    // otherwise.
    expect(urlA1).not.toBe(urlA2);

    for (const owner of [A1, A2]) {
      const d = await dealsSvc.create(T1, K, {
        title: `Twin deal ${rid()}`,
        pipeline_id: pipelineId,
        stage_id: openStageId,
        company_id: companyId,
        owner_user_id: owner,
        value_amount: 5000,
        currency: 'INR',
        expected_close_date: closeDate,
      });
      if (owner === A1) dealA1 = d.data.id;
      else dealA2 = d.data.id;

      // Completed by K, so both twins land in K's My Activities at once.
      const act = await activitiesSvc.create(T1, K, {
        type: 'task',
        subject: `Twin task ${rid()}`,
        due_at: tomorrow(),
        assignee_user_id: owner,
      });
      await activitiesSvc.complete(T1, K, act.data.id);
      actIds.push(act.data.id);
    }

    // leads.owner_user_id is nullable and every lead seeded above is owned, so
    // nothing yet exercises the mapper's null-owner branch. Inserted directly:
    // leadsSvc.create defaults an omitted owner to the acting user.
    const [lead] = await dbAdmin
      .insert(leads)
      .values({
        tenant_id: T1,
        first_name: `Unowned ${rid()}`,
        email: `rn-unowned-${rid()}@t.test`,
        status: 'new',
        owner_user_id: null,
      })
      .returning();
    unownedLead = lead!.id;
  });

  afterAll(async () => {
    if (actIds.length) await dbAdmin.delete(activities).where(inArray(activities.id, actIds));
    await dbAdmin.delete(deals).where(inArray(deals.id, [dealA1, dealA2]));
    await dbAdmin.delete(leads).where(eq(leads.id, unownedLead));
    await dbAdmin.delete(memberships).where(inArray(memberships.user_id, [A1, A2]));
  });

  it('two people with the SAME name each keep their own photo on every deduped read', async () => {
    // a) the board — ownerAvatar, one signature per unique owner
    const cards = (await dealsSvc.board(T1, pipelineId)).data.columns.flatMap((c) => c.cards);
    const cardA1 = cards.find((c) => c.id === dealA1)!;
    const cardA2 = cards.find((c) => c.id === dealA2)!;
    expect(cardA1.owner_name).toBe(cardA2.owner_name); // the collision is real…
    expect(cardA1.owner_avatar_url).toBe(urlA1); // …and the map survives it
    expect(cardA2.owner_avatar_url).toBe(urlA2);

    // b) the reports leaderboard — repAvatar
    const lb = (await reportsSvc.overview(T1, { pipeline_id: pipelineId })).data!.leaderboard;
    expect(lb.find((r) => r.user_id === A1)!.avatar_url).toBe(urlA1);
    expect(lb.find((r) => r.user_id === A2)!.avatar_url).toBe(urlA2);

    // c) My Activities — signedByAssignee
    const mine = await activitiesSvc.mine(T1, K);
    const all = [...mine.data.overdue, ...mine.data.today, ...mine.data.upcoming, ...mine.data.completed];
    expect(all.find((r) => r.assignee_user_id === A1)!.assignee_avatar_url).toBe(urlA1);
    expect(all.find((r) => r.assignee_user_id === A2)!.assignee_avatar_url).toBe(urlA2);

    // d) the FAM auditor registry — byUser, one signature per auditor
    const registry = (await famSvc.getAuditorRegistry()).data;
    expect(registry.find((r) => r.userId === A1)!.avatarUrl).toBe(urlA1);
    expect(registry.find((r) => r.userId === A2)!.avatarUrl).toBe(urlA2);

    // e) the per-row mappers on the same two people, for completeness
    const reps = (await dealsSvc.reps(T1)).data;
    expect(reps.find((r) => r.user_id === A1)!.avatar_url).toBe(urlA1);
    expect(reps.find((r) => r.user_id === A2)!.avatar_url).toBe(urlA2);
    const members = (await famSvc.listTenantMembers(T1)).data;
    expect(members.find((m) => m.userId === A1)!.avatarUrl).toBe(urlA1);
    expect(members.find((m) => m.userId === A2)!.avatarUrl).toBe(urlA2);

    for (const payload of [cards, lb, mine, registry, reps, members]) noKeysLeak(payload);
  });

  it('a lead with no owner answers null on both fields — the field is present, not dropped', async () => {
    const res = await leadsSvc.list(T1, 'new');
    const row = res.data.find((r) => r.id === unownedLead)!;
    expect(row).toBeDefined();
    expect(row.owner_user_id).toBeNull();
    expect(row.owner_name).toBeNull();
    // Present and null — an absent key would serialize as `undefined`, which
    // the web reads as "not loaded yet" rather than "no owner".
    expect(Object.prototype.hasOwnProperty.call(row, 'owner_avatar_url')).toBe(true);
    expect(row.owner_avatar_url).toBeNull();
    noKeysLeak(res);
  });

  it('every avatar this suite signed was asked for at 64px, never the 256 default', () => {
    // servedUrl's third argument defaults to 256; a person chip that forgets it
    // serves a 16x heavier file on every row of every list above.
    expect(askedSizes.length).toBeGreaterThan(0);
    expect([...new Set(askedSizes)]).toEqual([64]);
  });
});
