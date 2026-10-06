/**
 * Round Q — onboarding approvals that wait over 24 hours (founder
 * 2026-10-06: "if the HR manager is not approving it for 24 hours, then it
 * should go to the higher reporting manager of the HR manager role").
 *
 * Decision: it goes to the reporting manager of each active HR admin when that
 * person can already approve onboarding (an active Owner / HR admin seat);
 * otherwise to the Owners. No new permissions, one escalation per
 * submission, an HR admin's own file goes to the Owners.
 *
 * Service-level against the real Postgres (EmployeesService.
 * escalateStaleOnboarding is what the 15-minute cron calls).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import { tenants, users, memberships, employees } from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const inApp: Array<{ userId: string; type: string; message: string; tenantId: string }> = [];
const emails: Array<{ template: string; to: string; props: Record<string, unknown> }> = [];
const notifications = {
  createInAppNotification: async (userId: string, type: string, message: string, _l: string, tenantId: string) => {
    inApp.push({ userId, type, message, tenantId });
  },
  sendEmail: async (template: string, to: string, props: Record<string, unknown>) => {
    emails.push({ template, to, props });
    return true;
  },
} as unknown as NotificationsService;
const svc = new EmployeesService(
  new DatabaseService(),
  dbAdmin as never,
  { log: async () => undefined } as unknown as AuditService,
  notifications,
  new EventEmitter2(),
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthService,
  { servedUrl: async () => null } as unknown as MediaService,
);

const createdTenants: string[] = [];
const createdUsers: string[] = [];
const HOURS = 60 * 60 * 1000;

async function makeTenant(label: string) {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RQE ${label} ${rid()}`, slug: `rqe-${label}-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  createdTenants.push(t!.id);
  return t!.id;
}

async function person(
  tenantId: string,
  label: string,
  opts: {
    role?: string;
    joiner?: { submittedHoursAgo: number };
    managerId?: string;
  } = {},
) {
  const email = `rqe-${label}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: `RQE ${label}`, status: 'active' })
    .returning();
  createdUsers.push(u!.id);
  const pending = !!opts.joiner;
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `QE-${rid()}`,
      first_name: label,
      last_name: 'Seed',
      work_email: email,
      date_of_joining: '2025-01-01',
      status: pending ? 'inactive' : 'active',
      user_id: u!.id,
      reporting_manager_id: opts.managerId ?? null,
      custom_fields: pending
        ? {
            onboarding_submitted_for_review: true,
            onboarding_submitted_at: new Date(Date.now() - opts.joiner!.submittedHoursAgo * HOURS).toISOString(),
          }
        : {},
    })
    .returning();
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: u!.id,
    role: (opts.role ?? 'employee') as never,
    status: pending ? 'invited' : 'active',
    employee_id: e!.id,
  });
  return { id: e!.id, userId: u!.id, email };
}

const cf = async (id: string) =>
  ((await dbAdmin.select().from(employees).where(eq(employees.id, id)))[0]!.custom_fields ?? {}) as Record<
    string,
    unknown
  >;
const reset = () => {
  inApp.length = 0;
  emails.length = 0;
};
const escalatedTo = (joinerName: string) =>
  inApp
    .filter((n) => n.type === 'onboarding.escalated' && n.message.startsWith(`${joinerName} `))
    .map((n) => n.userId)
    .sort();

afterAll(async () => {
  for (const t of createdTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  for (const u of createdUsers) await dbAdmin.delete(users).where(eq(users.id, u));
});

describe('Round Q — onboarding escalation after 24 hours', () => {
  it("goes to the HR admin's reporting manager when that person is an Owner — and only them", async () => {
    const t = await makeTenant('rm-owner');
    const boss = await person(t, 'boss', { role: 'owner' });
    await person(t, 'otherowner', { role: 'owner' });
    await person(t, 'hr', { role: 'admin', managerId: boss.id });
    const joiner = await person(t, 'joinerA', { joiner: { submittedHoursAgo: 25 } });

    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerA')).toEqual([boss.userId]);
    const mail = emails.find((e) => e.to === boss.email);
    expect(mail).toMatchObject({
      template: 'approval-escalated',
      props: { kindLabel: 'onboarding', levelLabel: "as the HR admin's reporting manager", stillActs: 'HR can still approve it too.' },
    });
    const c = await cf(joiner.id);
    expect(typeof c.onboarding_escalated_at).toBe('string');
    expect(c.onboarding_escalated_to).toEqual([boss.userId]);
  });

  it('an HR admin reporting to another HR admin escalates to that HR admin', async () => {
    const t = await makeTenant('rm-hr');
    await person(t, 'owner', { role: 'owner' });
    const headHr = await person(t, 'headhr', { role: 'admin' });
    await person(t, 'hr', { role: 'admin', managerId: headHr.id });
    await person(t, 'joinerB', { joiner: { submittedHoursAgo: 30 } });
    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerB')).toEqual([headHr.userId]);
  });

  it("an HR admin's manager who is a plain manager → the Owners instead (no new permissions)", async () => {
    const t = await makeTenant('rm-mgr');
    const o1 = await person(t, 'o1', { role: 'owner' });
    const o2 = await person(t, 'o2', { role: 'owner' });
    const mgr = await person(t, 'mgr', { role: 'manager' });
    await person(t, 'hr', { role: 'admin', managerId: mgr.id });
    await person(t, 'joinerC', { joiner: { submittedHoursAgo: 26 } });
    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerC')).toEqual([o1.userId, o2.userId].sort());
    expect(escalatedTo('joinerC')).not.toContain(mgr.userId);
    expect(emails.find((e) => e.to === o1.email)?.props.levelLabel).toBe('as an Owner');
  });

  it('no HR admin at all → the Owners', async () => {
    const t = await makeTenant('no-hr');
    const o = await person(t, 'o', { role: 'owner' });
    await person(t, 'joinerD', { joiner: { submittedHoursAgo: 48 } });
    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerD')).toEqual([o.userId]);
  });

  it("an HR admin's own onboarding goes to the Owners, never to a peer", async () => {
    const t = await makeTenant('hr-joiner');
    const o = await person(t, 'o', { role: 'owner' });
    const peer = await person(t, 'peer', { role: 'admin', managerId: o.id });
    const newHr = await person(t, 'joinerE', { role: 'admin', joiner: { submittedHoursAgo: 25 } });
    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerE')).toEqual([o.userId]);
    expect(escalatedTo('joinerE')).not.toContain(peer.userId);
    expect(escalatedTo('joinerE')).not.toContain(newHr.userId);
  });

  it('under 24 hours nothing happens; a second sweep never re-escalates', async () => {
    const t = await makeTenant('timing');
    const o = await person(t, 'o', { role: 'owner' });
    const fresh = await person(t, 'joinerF', { joiner: { submittedHoursAgo: 23 } });
    const stale = await person(t, 'joinerG', { joiner: { submittedHoursAgo: 25 } });
    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerF')).toEqual([]);
    expect((await cf(fresh.id)).onboarding_escalated_at).toBeUndefined();
    expect(escalatedTo('joinerG')).toEqual([o.userId]);
    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerG')).toEqual([]);
    expect((await cf(stale.id)).onboarding_escalated_to).toEqual([o.userId]);
  });

  it('approved, removed and sent-back files are skipped; a resubmission starts a fresh clock', async () => {
    const t = await makeTenant('skips');
    const o = await person(t, 'o', { role: 'owner' });
    const approved = await person(t, 'joinerH', { joiner: { submittedHoursAgo: 30 } });
    const removed = await person(t, 'joinerI', { joiner: { submittedHoursAgo: 30 } });
    const sentBack = await person(t, 'joinerJ', { joiner: { submittedHoursAgo: 30 } });
    await svc.approveOnboarding(approved.id, o.userId, t);
    await dbAdmin.update(employees).set({ deleted_at: new Date() }).where(eq(employees.id, removed.id));
    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerH')).toEqual([]);
    expect(escalatedTo('joinerI')).toEqual([]);
    expect(escalatedTo('joinerJ')).toEqual([o.userId]);

    // Sent back → the marker is cleared, so the next submission gets its
    // own 24 hours.
    await svc.rejectOnboarding(sentBack.id, 'Fix the address', o.userId, t);
    const c = await cf(sentBack.id);
    expect(c.onboarding_escalated_at).toBeNull();
    expect(c.onboarding_submitted_for_review).toBe(false);
  });

  it("each company's stale files go to that company's people only", async () => {
    const a = await makeTenant('iso-a');
    const b = await makeTenant('iso-b');
    const oa = await person(a, 'oa', { role: 'owner' });
    const ob = await person(b, 'ob', { role: 'owner' });
    await person(a, 'joinerK', { joiner: { submittedHoursAgo: 25 } });
    await person(b, 'joinerL', { joiner: { submittedHoursAgo: 25 } });
    reset();
    await svc.escalateStaleOnboarding(new Date());
    expect(escalatedTo('joinerK')).toEqual([oa.userId]);
    expect(escalatedTo('joinerL')).toEqual([ob.userId]);
    expect(inApp.filter((n) => n.message.startsWith('joinerK ')).every((n) => n.tenantId === a)).toBe(true);
    expect(inApp.filter((n) => n.message.startsWith('joinerL ')).every((n) => n.tenantId === b)).toBe(true);
  });
});
