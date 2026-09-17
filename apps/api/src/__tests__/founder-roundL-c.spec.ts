/**
 * Founder round L (2026-09-17) — item 4 (implementer C): the coupon / trial
 * notices stop living in an always-on banner and reach the people who can
 * act on them.
 *
 *  • redeemCoupon → after the transaction commits, one `billing.coupon_redeemed`
 *    bell row + one `coupon-redeemed` email per ACTIVE Owner/HR Admin seat;
 *    employees, managers, deactivated admins and other tenants get nothing;
 *    the email greets the person, names the workspace, and the template
 *    escapes every user-controlled string.
 *  • trialReminders → an 11-day window banded on IST CALENDAR days (the same
 *    `days_left` GET /billing hands the banner): T-3 / T-1 for everyone,
 *    T-10 only for an EXTENDED trial (coupon or FAM extension) — a stock
 *    7-day trial never hears "ends in 7 days" the morning after signup. Each
 *    band emails Owner/HR Admins AND drops one `billing.trial_ending` bell
 *    row per seat collapsed on `billing.trial:<tenant>`; two markers
 *    (`billing.trial_bell`, `billing.trial_reminder`) make a rerun a no-op
 *    and an email outage retry the mail without touching the bell row.
 *
 * Service-level against the real Postgres (billing.spec harness) with the
 * REAL NotificationsService so the in-app rows land in the notifications
 * table; only the Resend send is stubbed.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  auditLogPlatform,
  couponCodes,
  memberships,
  notifications,
  subscriptions,
  tenants,
  users,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { AnalyticsService } from '../core/analytics/analytics.service';
import { AuditService } from '../modules/audit/audit.service';
import { BillingStateService } from '../core/billing/billing-state.service';
import {
  BillingService,
  daysLeftIST,
  formatDateIST,
} from '../modules/billing/billing.service';
import { BillingJobs } from '../modules/billing/billing.jobs';
import { RazorpayPlatformService } from '../modules/billing/razorpay-platform.service';
import { NotificationsService } from '../modules/notifications/notifications.service';

jest.setTimeout(90_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const DAY = 24 * 60 * 60 * 1000;
const BILLING_URL = `${process.env.APP_URL ?? 'http://localhost:3000'}/settings/billing`;

const dbSvc = new DatabaseService();
const config = { get: (_: string, fb?: unknown) => fb } as never;
const analytics = new AnalyticsService(config, dbAdmin as never);
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const rzp = new RazorpayPlatformService(config);
const billingState = new BillingStateService(dbAdmin as never);
const notificationsService = new NotificationsService(
  db as never,
  dbAdmin as never,
  new ConfigService({ NODE_ENV: 'test' }),
  new EventEmitter2(),
);
// Only the Resend hop is stubbed — in-app rows are real.
const sendEmail = jest.spyOn(notificationsService, 'sendEmail').mockResolvedValue(true);
const billing = new BillingService(
  dbAdmin as never,
  rzp,
  billingState,
  audit,
  analytics,
  notificationsService,
);
const jobs = new BillingJobs(dbAdmin as never, audit, analytics, notificationsService, billing, rzp);

type MailCall = [string, string, Record<string, unknown>, unknown];
const mailCalls = () => sendEmail.mock.calls as unknown as MailCall[];
const renderTemplate = (template: string, props: Record<string, unknown>) =>
  (
    notificationsService as unknown as {
      renderTemplate: (t: string, p: Record<string, unknown>) => { subject: string; html: string };
    }
  ).renderTemplate(template, props);

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Seat = { userId: string; email: string; name: string };
const cleanupTenants: string[] = [];
const cleanupUsers: string[] = [];
const cleanupCoupons: string[] = [];

async function mkTenant(name: string, trialOffsetDays: number): Promise<string> {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name,
      slug: `rlc-${rid()}-${Date.now()}`,
      status: 'trialing',
      trial_ends_at: new Date(Date.now() + trialOffsetDays * DAY),
    })
    .returning();
  cleanupTenants.push(t!.id);
  await billing.ensureRow(t!.id); // the trialing subscription row the jobs read
  return t!.id;
}

/** Make the trial look FAM-extended: the row was created 5 days before today. */
async function markExtended(tenantId: string) {
  await dbAdmin
    .update(subscriptions)
    .set({ created_at: new Date(Date.now() - 5 * DAY) })
    .where(eq(subscriptions.tenant_id, tenantId));
}

async function mkSeat(
  tenantId: string,
  role: 'owner' | 'admin' | 'manager' | 'employee',
  status: 'active' | 'deactivated' = 'active',
): Promise<Seat> {
  const email = `rlc-${role}-${rid()}@t.test`;
  const name = `${role} Tester`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: name, status: 'active' })
    .returning();
  cleanupUsers.push(u!.id);
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u!.id, role, status });
  return { userId: u!.id, email, name };
}

const inAppRows = (userId: string, type: string) =>
  dbAdmin
    .select()
    .from(notifications)
    .where(and(eq(notifications.user_id, userId), eq(notifications.type, type)));

/** Every row carrying a tenant's group key — whoever it went to. */
const rowsByGroup = (groupKey: string) =>
  dbAdmin.select().from(notifications).where(eq(notifications.group_key, groupKey));

const markers = (action: 'billing.trial_reminder' | 'billing.trial_bell', tenantId: string, band: string) =>
  dbAdmin
    .select()
    .from(auditLogPlatform)
    .where(
      and(
        eq(auditLogPlatform.action, action),
        eq(auditLogPlatform.target_tenant_id, tenantId),
        sql`${auditLogPlatform.metadata}->>'band' = ${band}`,
      ),
    );

const trialMailsTo = (emails: string[]) =>
  mailCalls().filter((m) => m[0] === 'trial-ending-soon' && emails.includes(m[1]));

/** Round-trip the fixture's trial end the way the job will read it. */
async function subTrialEndsAt(tenantId: string): Promise<Date> {
  const [row] = await dbAdmin
    .select({ t: subscriptions.trial_ends_at })
    .from(subscriptions)
    .where(eq(subscriptions.tenant_id, tenantId));
  return new Date(row!.t!);
}

// A sibling workspace that exists BEFORE anything fires — it must never hear
// about the other tenant's coupon or trial. 60 days out → outside every band.
let TSib: string;
let oSib: Seat;

beforeAll(async () => {
  TSib = await mkTenant(`RLc sibling ${rid()}`, 60);
  oSib = await mkSeat(TSib, 'owner');
});

afterAll(async () => {
  if (cleanupTenants.length) {
    await dbAdmin
      .delete(auditLogPlatform)
      .where(inArray(auditLogPlatform.target_tenant_id, cleanupTenants));
  }
  for (const id of cleanupTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, id));
  for (const id of cleanupUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  for (const id of cleanupCoupons) await dbAdmin.delete(couponCodes).where(eq(couponCodes.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════

describe('Round L — item 4: coupon activation reaches Owner/HR Admin, not the floor', () => {
  const tenantName = `RLc <b>Co</b> ${rid()}`;
  let T: string;
  let owner: Seat;
  let admin: Seat;
  let goneAdmin: Seat;
  let manager: Seat;
  let employee: Seat;

  beforeAll(async () => {
    T = await mkTenant(tenantName, 2);
    owner = await mkSeat(T, 'owner');
    admin = await mkSeat(T, 'admin');
    goneAdmin = await mkSeat(T, 'admin', 'deactivated');
    manager = await mkSeat(T, 'manager');
    employee = await mkSeat(T, 'employee');
  });

  it('ownerEmails() carries userId + name for the bell/greeting and lists ACTIVE owner/admin seats only', async () => {
    const seats = await billing.ownerEmails(T);
    expect(seats.map((s) => s.userId).sort()).toEqual([owner.userId, admin.userId].sort());
    for (const s of seats) {
      const who = s.userId === owner.userId ? owner : admin;
      expect(s).toEqual({ userId: who.userId, email: who.email, name: who.name });
    }
    expect(seats.some((s) => s.userId === goneAdmin.userId)).toBe(false);
    expect(seats.some((s) => s.userId === manager.userId)).toBe(false);
    expect(seats.some((s) => s.userId === employee.userId)).toBe(false);
    expect(seats.some((s) => s.userId === oSib.userId)).toBe(false);
  });

  it('redeem → one bell row + one email for the owner and the admin, nothing for anyone else (incl. the sibling tenant), raw props escaped by the template', async () => {
    sendEmail.mockClear();
    const [coupon] = await dbAdmin
      .insert(couponCodes)
      .values({ code: `RLC-${rid().toUpperCase()}`, campaign: 'roundL', months: 3 })
      .returning();
    cleanupCoupons.push(coupon!.id);

    const res = await billing.redeemCoupon(T, owner.userId, coupon!.code);
    expect(res.data.months).toBe(3);
    expect(res.data.trial_ends_at).not.toBeNull();
    const when = formatDateIST(res.data.trial_ends_at);
    // "12 Oct 2026" shape, IST.
    expect(when).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
    expect(when).toBe(
      new Date(res.data.trial_ends_at!).toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    );
    const message = `Coupon ${coupon!.code} applied — 3 free months. Your trial now ends on ${when}.`;

    // The redeem awaits the notice: rows are there when it returns.
    for (const seat of [owner, admin]) {
      const rows = await inAppRows(seat.userId, 'billing.coupon_redeemed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: T,
        message,
        link_url: '/settings/billing',
        group_key: `billing.coupon:${T}`,
        group_count: 1,
        read_at: null,
      });
    }
    for (const seat of [goneAdmin, manager, employee, oSib]) {
      expect(await inAppRows(seat.userId, 'billing.coupon_redeemed')).toHaveLength(0);
    }
    // Every row carrying this tenant's coupon key went to its owner/admin — nobody else.
    const grouped = await rowsByGroup(`billing.coupon:${T}`);
    expect(grouped.map((r) => r.user_id).sort()).toEqual([owner.userId, admin.userId].sort());
    // Nothing of any billing type reached the floor or the sibling workspace.
    const floorRows = await dbAdmin
      .select({ type: notifications.type })
      .from(notifications)
      .where(
        and(
          inArray(notifications.user_id, [
            goneAdmin.userId,
            manager.userId,
            employee.userId,
            oSib.userId,
          ]),
          sql`${notifications.type} LIKE 'billing.%'`,
        ),
      );
    expect(floorRows).toEqual([]);

    const mails = mailCalls().filter((m) => m[0] === 'coupon-redeemed');
    expect(mails.map((m) => m[1]).sort()).toEqual([owner.email, admin.email].sort());
    expect(mails.some((m) => m[1] === oSib.email)).toBe(false);
    for (const m of mails) {
      const who = m[1] === owner.email ? owner : admin;
      expect(m[2]).toEqual({
        tenantName, // raw — the template escapes
        recipientName: who.name,
        code: coupon!.code,
        months: 3,
        trialEndsAt: when,
        billingUrl: BILLING_URL,
      });
    }

    // Rendered through the real template: the PERSON is greeted, the
    // workspace is named in the body (markup escaped), code + date present,
    // the CTA is our URL.
    const ownerMail = mails.find((m) => m[1] === owner.email)!;
    const out = renderTemplate('coupon-redeemed', ownerMail[2]);
    expect(out.subject).toBe(`Coupon ${coupon!.code} applied — 3 free months`);
    expect(out.html).toContain(`<p>Hi ${owner.name},</p>`);
    expect(out.html).not.toContain(`Hi ${tenantName}`);
    expect(out.html).not.toContain('<b>Co</b>');
    expect(out.html).toContain('&lt;b&gt;Co&lt;/b&gt;');
    expect(out.html).toContain(`<strong>${coupon!.code}</strong>`);
    expect(out.html).toContain(`Your trial now ends on <strong>${when}</strong>`);
    expect(out.html).toContain(`href="${BILLING_URL}"`);

    // A hostile code / name / URL never reaches the mail unescaped; a
    // missing recipient name greets "there".
    const hostile = renderTemplate('coupon-redeemed', {
      tenantName: 'X',
      recipientName: '<i>Eve</i>',
      code: '<script>alert(1)</script>',
      months: 1,
      trialEndsAt: '1 Jan 2027',
      billingUrl: 'https://app.test/settings/billing?a=1&b=2',
    });
    expect(hostile.html.toLowerCase()).not.toContain('<script');
    expect(hostile.html.toLowerCase()).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(hostile.html).not.toContain('<i>Eve</i>');
    expect(hostile.html).toContain('Hi &lt;i&gt;Eve&lt;/i&gt;,');
    expect(hostile.html).toContain('href="https://app.test/settings/billing?a=1&amp;b=2"');
    expect(hostile.subject).toContain('1 free month');
    expect(hostile.subject).not.toContain('months');
    const anonymous = renderTemplate('coupon-redeemed', {
      tenantName: 'X',
      recipientName: '   ',
      code: 'C',
      months: 2,
      trialEndsAt: '1 Jan 2027',
      billingUrl: BILLING_URL,
    });
    expect(anonymous.html).toContain('<p>Hi there,</p>');
  });

  it('an unknown trial end drops the "ends on" sentence instead of printing "—"', () => {
    for (const trialEndsAt of [null, undefined, '', '—']) {
      const out = renderTemplate('coupon-redeemed', {
        tenantName: 'X',
        recipientName: 'Owner',
        code: 'C',
        months: 2,
        trialEndsAt,
        billingUrl: BILLING_URL,
      });
      expect(out.html).not.toContain('Your trial now ends on');
      expect(out.html).not.toContain('—</strong>');
      expect(out.html).toContain('Nothing is charged while the trial runs.');
    }
  });

  it('the notice is best-effort: a broken notifier never fails the redeem', async () => {
    const T2 = await mkTenant(`RLc quiet ${rid()}`, 2);
    const o2 = await mkSeat(T2, 'owner');
    const [coupon] = await dbAdmin
      .insert(couponCodes)
      .values({ code: `RLC2-${rid().toUpperCase()}`, campaign: 'roundL', months: 1 })
      .returning();
    cleanupCoupons.push(coupon!.id);
    const spy = jest
      .spyOn(billing, 'ownerEmails')
      .mockRejectedValueOnce(new Error('boom — simulated notifier failure'));
    try {
      const res = await billing.redeemCoupon(T2, o2.userId, coupon!.code);
      expect(res.data.months).toBe(1);
      const [sub] = await dbAdmin
        .select({ c: subscriptions.applied_coupon_id })
        .from(subscriptions)
        .where(eq(subscriptions.tenant_id, T2));
      expect(sub!.c).toBe(coupon!.id);
      expect(await inAppRows(o2.userId, 'billing.coupon_redeemed')).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Round L — item 4: trial reminders at T-10 (extended trials) / T-3 / T-1 land in the bell of Owner/HR Admin only', () => {
  let T10: string; // extended trial, 10 days out
  let T10p: string; // PLAIN 10-day trial (not extended) — no T-10
  let T7: string; // stock 7-day trial — no T-10
  let T3: string;
  let T1: string;
  let T30: string;
  let o10: Seat;
  let a10: Seat;
  let e10: Seat;
  let o10p: Seat;
  let o7: Seat;
  let o3: Seat;
  let o1: Seat;
  let o30: Seat;

  beforeAll(async () => {
    T10 = await mkTenant(`RLc ten ${rid()}`, 10);
    await markExtended(T10);
    T10p = await mkTenant(`RLc ten-plain ${rid()}`, 10);
    T7 = await mkTenant(`RLc seven ${rid()}`, 7);
    T3 = await mkTenant(`RLc three ${rid()}`, 3);
    T1 = await mkTenant(`RLc one ${rid()}`, 1);
    T30 = await mkTenant(`RLc thirty ${rid()}`, 30);
    o10 = await mkSeat(T10, 'owner');
    a10 = await mkSeat(T10, 'admin');
    e10 = await mkSeat(T10, 'employee');
    o10p = await mkSeat(T10p, 'owner');
    o7 = await mkSeat(T7, 'owner');
    o3 = await mkSeat(T3, 'owner');
    o1 = await mkSeat(T1, 'owner');
    o30 = await mkSeat(T30, 'owner');
  });

  it('GET /billing days_left is the IST calendar count the bell will quote', async () => {
    expect((await billing.state(T10)).data.days_left).toBe(10);
    expect((await billing.state(T7)).data.days_left).toBe(7);
    expect((await billing.state(T1)).data.days_left).toBe(1);
    expect((await billing.state(TSib)).data.days_left).toBe(60);
  });

  it('T-10 (extended trial): exactly one bell row per owner/admin (group_key billing.trial:<tenant>), one email each, both markers; employee + other tenants nothing', async () => {
    sendEmail.mockClear();
    await jobs.trialReminders();

    const endsAt = await subTrialEndsAt(T10);
    const when = formatDateIST(endsAt);
    const message = `Free trial ends in 10 days (${when}). Subscribe to keep your workspace open.`;
    for (const seat of [o10, a10]) {
      const rows = await inAppRows(seat.userId, 'billing.trial_ending');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: T10,
        message,
        link_url: '/settings/billing',
        group_key: `billing.trial:${T10}`,
        group_count: 1,
        read_at: null,
      });
    }
    expect(await inAppRows(e10.userId, 'billing.trial_ending')).toHaveLength(0);
    // Cross-tenant: every row carrying T10's key belongs to T10's owner/admin,
    // and nobody outside the tenant got a trial row for it.
    const grouped = await rowsByGroup(`billing.trial:${T10}`);
    expect(grouped.map((r) => r.user_id).sort()).toEqual([o10.userId, a10.userId].sort());
    for (const seat of [oSib, o30, o7, o10p]) {
      expect(await inAppRows(seat.userId, 'billing.trial_ending')).toHaveLength(0);
    }

    const mails = trialMailsTo([o10.email, a10.email, e10.email, oSib.email]);
    expect(mails.map((m) => m[1]).sort()).toEqual([o10.email, a10.email].sort());
    for (const m of mails) {
      expect(m[2]).toEqual({
        tenantName: expect.stringContaining('RLc ten '),
        trialEndsAt: when, // unified on formatDateIST — the same date the bell shows
        upgradeUrl: BILLING_URL,
      });
    }

    for (const action of ['billing.trial_reminder', 'billing.trial_bell'] as const) {
      const rows = await markers(action, T10, 'T-10');
      expect({ action, n: rows.length }).toEqual({ action, n: 1 });
      expect((rows[0]!.metadata as { marker: string }).marker).toBe(
        `${T10}:T-10:${endsAt.toISOString().slice(0, 10)}`,
      );
    }
  });

  it('a stock 7-day trial and a plain (unextended) 10-day trial get NO T-10 — no rows, no mail, no markers', async () => {
    for (const [tenant, seat] of [
      [T7, o7],
      [T10p, o10p],
    ] as const) {
      expect(await inAppRows(seat.userId, 'billing.trial_ending')).toHaveLength(0);
      expect(trialMailsTo([seat.email])).toHaveLength(0);
      for (const action of ['billing.trial_reminder', 'billing.trial_bell'] as const) {
        for (const band of ['T-10', 'T-3', 'T-1']) {
          expect(await markers(action, tenant, band)).toHaveLength(0);
        }
      }
    }
  });

  it('T-3 and T-1 still fire from the same sweep for everyone; 30 days out gets nothing at all', async () => {
    for (const [tenant, seat, band, n] of [
      [T3, o3, 'T-3', 3],
      [T1, o1, 'T-1', 1],
    ] as const) {
      const rows = await inAppRows(seat.userId, 'billing.trial_ending');
      expect({ band, rows: rows.length }).toEqual({ band, rows: 1 });
      expect(rows[0]!.message).toBe(
        `Free trial ends in ${n} day${n === 1 ? '' : 's'} (${formatDateIST(await subTrialEndsAt(tenant))}). Subscribe to keep your workspace open.`,
      );
      expect(rows[0]!.group_key).toBe(`billing.trial:${tenant}`);
      expect(trialMailsTo([seat.email])).toHaveLength(1);
      expect(await markers('billing.trial_reminder', tenant, band)).toHaveLength(1);
      expect(await markers('billing.trial_bell', tenant, band)).toHaveLength(1);
    }
    expect(await inAppRows(o30.userId, 'billing.trial_ending')).toHaveLength(0);
    expect(trialMailsTo([o30.email])).toHaveLength(0);
    for (const band of ['T-10', 'T-3', 'T-1']) {
      expect(await markers('billing.trial_reminder', T30, band)).toHaveLength(0);
      expect(await markers('billing.trial_bell', T30, band)).toHaveLength(0);
    }
  });

  it('a rerun is a no-op: no new rows, no bump, no email, no second marker', async () => {
    sendEmail.mockClear();
    await jobs.trialReminders();
    for (const [tenant, seat, band] of [
      [T10, o10, 'T-10'],
      [T10, a10, 'T-10'],
      [T3, o3, 'T-3'],
      [T1, o1, 'T-1'],
    ] as const) {
      const rows = await inAppRows(seat.userId, 'billing.trial_ending');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.group_count).toBe(1);
      expect(await markers('billing.trial_reminder', tenant, band)).toHaveLength(1);
      expect(await markers('billing.trial_bell', tenant, band)).toHaveLength(1);
    }
    expect(
      trialMailsTo([o10.email, a10.email, o3.email, o1.email, e10.email, o7.email, o10p.email, oSib.email]),
    ).toHaveLength(0);
    expect(await inAppRows(e10.userId, 'billing.trial_ending')).toHaveLength(0);
  });

  it('a later band bumps the SAME bell row (group_key collapse) instead of stacking a second one', async () => {
    sendEmail.mockClear();
    const [before] = await inAppRows(o10.userId, 'billing.trial_ending');
    // Time passes: the T-10 tenant is now inside the T-3 band.
    const newEnd = new Date(Date.now() + 3 * DAY);
    await dbAdmin
      .update(subscriptions)
      .set({ trial_ends_at: newEnd })
      .where(eq(subscriptions.tenant_id, T10));
    await jobs.trialReminders();

    for (const seat of [o10, a10]) {
      const rows = await inAppRows(seat.userId, 'billing.trial_ending');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.group_count).toBe(2);
      expect(rows[0]!.message).toBe(
        `Free trial ends in 3 days (${formatDateIST(newEnd)}). Subscribe to keep your workspace open.`,
      );
      expect(rows[0]!.link_url).toBe('/settings/billing');
    }
    const [after] = await inAppRows(o10.userId, 'billing.trial_ending');
    expect(after!.id).toBe(before!.id);
    expect(after!.created_at.getTime()).toBeGreaterThanOrEqual(before!.created_at.getTime());
    expect(trialMailsTo([o10.email, a10.email]).map((m) => m[1]).sort()).toEqual(
      [o10.email, a10.email].sort(),
    );
    expect(await markers('billing.trial_reminder', T10, 'T-3')).toHaveLength(1);
    expect(await markers('billing.trial_bell', T10, 'T-3')).toHaveLength(1);
    expect(await markers('billing.trial_reminder', T10, 'T-10')).toHaveLength(1);
    expect(await inAppRows(e10.userId, 'billing.trial_ending')).toHaveLength(0);
  });

  it('an email outage still rings the bell once; the retry re-sends the mail only — a READ bell row is neither bumped nor duplicated', async () => {
    const TOut = await mkTenant(`RLc outage ${rid()}`, 2);
    const oOut = await mkSeat(TOut, 'owner');
    sendEmail.mockClear();
    sendEmail.mockImplementation(async (_t, to) => to !== oOut.email);
    try {
      await jobs.trialReminders();
      let rows = await inAppRows(oOut.userId, 'billing.trial_ending');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.group_count).toBe(1);
      expect(await markers('billing.trial_bell', TOut, 'T-3')).toHaveLength(1);
      expect(await markers('billing.trial_reminder', TOut, 'T-3')).toHaveLength(0);
      expect(trialMailsTo([oOut.email])).toHaveLength(1); // attempted, failed

      // The owner reads the row before Resend recovers — the retry must not
      // resurrect it as a fresh unread row.
      await dbAdmin
        .update(notifications)
        .set({ read_at: new Date() })
        .where(eq(notifications.id, rows[0]!.id));

      sendEmail.mockImplementation(async () => true);
      sendEmail.mockClear();
      await jobs.trialReminders();
      rows = await inAppRows(oOut.userId, 'billing.trial_ending');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.group_count).toBe(1);
      expect(rows[0]!.read_at).not.toBeNull();
      expect(trialMailsTo([oOut.email])).toHaveLength(1);
      expect(await markers('billing.trial_reminder', TOut, 'T-3')).toHaveLength(1);
      expect(await markers('billing.trial_bell', TOut, 'T-3')).toHaveLength(1);

      // Fully done → a third run touches nothing.
      sendEmail.mockClear();
      await jobs.trialReminders();
      expect(await inAppRows(oOut.userId, 'billing.trial_ending')).toHaveLength(1);
      expect(trialMailsTo([oOut.email])).toHaveLength(0);
    } finally {
      sendEmail.mockImplementation(async () => true);
    }
  });
});

describe('Round L — item 4: IST date helpers', () => {
  it('formatDateIST renders "12 Oct 2026" in IST and never "Invalid Date"', () => {
    expect(formatDateIST(new Date('2026-10-12T10:00:00Z'))).toBe('12 Oct 2026');
    // 20:00 UTC on the 11th is 01:30 IST on the 12th.
    expect(formatDateIST('2026-10-11T20:00:00Z')).toBe('12 Oct 2026');
    expect(formatDateIST(null)).toBe('—');
    expect(formatDateIST(undefined)).toBe('—');
    expect(formatDateIST('not a date')).toBe('—');
  });

  it('daysLeftIST counts IST calendar days, not 24h instants', () => {
    const now = new Date('2026-10-01T12:00:00Z'); // 1 Oct 17:30 IST
    expect(daysLeftIST(now, now)).toBe(0);
    // 11 Oct 20:00 UTC = 12 Oct 01:30 IST → 11 calendar days, though only 10.3 × 24h.
    expect(daysLeftIST('2026-10-11T20:00:00Z', now)).toBe(11);
    // 2 Oct 00:10 IST is "tomorrow" even though it is 6h40m away.
    expect(daysLeftIST('2026-10-01T18:40:00Z', now)).toBe(1);
    // Yesterday, IST.
    expect(daysLeftIST('2026-09-30T18:00:00Z', now)).toBe(-1); // 30 Sep 23:30 IST
    // Exactly N × 24h at the same wall-clock time is N days.
    expect(daysLeftIST(new Date(now.getTime() + 10 * DAY), now)).toBe(10);
    expect(daysLeftIST(new Date(now.getTime() + 7 * DAY), now)).toBe(7);
  });
});
