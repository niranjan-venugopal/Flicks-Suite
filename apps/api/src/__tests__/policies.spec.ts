/**
 * Round P R3 — company policies (migration 0067, module `policies`).
 *
 * Service-level against the real Postgres (RLS-bound tenant pool), stubs for
 * audit / notifications / R2 / module access, mirroring
 * founder-roundP-r1-invites.spec. Covers: draft invisibility, publish fan-out
 * and role targeting, acknowledge idempotency + stale version 409,
 * re-acknowledgement bumps, the HR roster + CSV (formula-safe), the 1/hour
 * reminder throttle (reset by a version bump), archive, cross-tenant 404s,
 * PATCH never moving the version and never leaving a PUBLISHED policy
 * unreadable, empty-policy 400, cleanMarkdown, DTO hygiene through the real
 * ValidationPipe, the PDF upload (magic bytes, size cap, R2 put/replace),
 * seat liveness (deactivated / expired access) and the controller's grant
 * placement (reflection).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  companyPolicies,
  policyAcknowledgements,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import type { R2Service } from '../core/storage/r2.service';
import type { ModuleAccessService } from '../core/auth/module-access.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import { PoliciesService, policyAppliesToRole } from '../modules/policies/policies.service';
import { PoliciesController } from '../modules/policies/policies.controller';
import { PoliciesPublicService } from '../modules/policies/public';
import { AcknowledgePolicyDto, CreatePolicyDto, UpdatePolicyDto } from '../modules/policies/policies.dto';
import { REQUIRE_GRANT_KEY, type GrantRequirement } from '../core/auth/decorators/require-grant.decorator';
import { ROLES_KEY } from '../core/auth/decorators/roles.decorator';
import { cleanMarkdown } from '../modules/pm/public';

const rid = () => crypto.randomBytes(4).toString('hex');

// ─── Stubs ──────────────────────────────────────────────────────────────────
const auditLog = jest.fn(async (_dto: unknown) => undefined);
const audit = { log: auditLog } as unknown as AuditService;
const sendEmail = jest.fn(async (_tpl: unknown, _to: unknown, _props: unknown, _opts?: unknown) => true);
const createInAppNotification = jest.fn(async (..._args: unknown[]) => undefined);
const notifications = { sendEmail, createInAppNotification } as unknown as NotificationsService;
const putObject = jest.fn(async (_key: string, _body: Buffer, _ct: string, _cc?: string) => undefined);
const deleteObjects = jest.fn(async (_keys: string[]) => undefined);
const signedGetUrl = jest.fn(async (key: string, _ttl?: number) => `https://signed.test/${key}`);
let r2Configured = true;
const r2 = {
  isConfigured: () => r2Configured,
  putObject,
  deleteObjects,
  signedGetUrl,
} as unknown as R2Service;
// Module access: owner/admin hold the module by role, everyone else is 'none'
// unless the test flips `grantedUsers` (the Settings → Access path).
const grantedUsers = new Map<string, 'view' | 'edit'>();
const access = {
  resolve: jest.fn(async (_t: string, _m: string | undefined, role: UserRole, _mod: string, userId?: string) => {
    const level = role === 'owner' || role === 'admin' ? 'edit' : (grantedUsers.get(userId ?? '') ?? 'none');
    return { level, capabilities: {}, source: 'role', moduleEnabled: true, membershipActive: true };
  }),
} as unknown as ModuleAccessService;
const config = new ConfigService({ JWT_SECRET: 'policies-spec-secret', APP_URL: 'http://localhost:3000' });
const service = new PoliciesService(new DatabaseService(), r2, notifications, audit, access, config);
const pub = new PoliciesPublicService(service);

// ─── Fixtures ───────────────────────────────────────────────────────────────
let tenantA: string;
let tenantB: string;
let ownerA: string;
let hrA: string;
let employeeA: string;
let employeeAEmp: string;
let managerA: string;
let financeA: string;
let guestA: string;
let auditorA: string;
let invitedA: string;
let ownerB: string;
let employeeB: string;
const trackedTenants: string[] = [];
const trackedUsers: string[] = [];

async function seedUser(label: string, fullName: string) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `pol-${label}-${rid()}@t.test`, full_name: fullName, status: 'active' })
    .returning();
  trackedUsers.push(u!.id);
  return u!.id;
}

async function mkTenant(label: string) {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `Policies ${label} ${rid()}`, slug: `pol-${label}-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  trackedTenants.push(t!.id);
  return t!.id;
}

async function seat(
  tenantId: string,
  userId: string,
  role: UserRole,
  status: 'invited' | 'active' | 'deactivated' = 'active',
  employeeId: string | null = null,
) {
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: userId,
    role,
    status,
    employee_id: employeeId,
    accepted_at: status === 'active' ? new Date() : null,
  });
}

const actor = (tenantId: string, userId: string, role: UserRole) => ({
  tenantId,
  userId,
  membershipId: undefined,
  role,
});

const pendingIds = async (tenantId: string, userId: string) =>
  (await service.pendingForUser(tenantId, userId)).data.map((p) => p.id);

const createRichText = (tenantId: string, by: string, extra: Partial<CreatePolicyDto> = {}) =>
  service.create(tenantId, by, {
    title: `Leave policy ${rid()}`,
    kind: 'rich_text',
    body_md: '# Leave\n\nTake it when you need it.',
    ...extra,
  });

const row = async (id: string) => {
  const [r] = await dbAdmin.select().from(companyPolicies).where(eq(companyPolicies.id, id));
  return r ?? null;
};
const ackRows = (policyId: string) =>
  dbAdmin.select().from(policyAcknowledgements).where(eq(policyAcknowledgements.policy_id, policyId));

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0),
]);

beforeAll(async () => {
  tenantA = await mkTenant('a');
  tenantB = await mkTenant('b');
  ownerA = await seedUser('owner', 'Olivia Owner');
  hrA = await seedUser('hr', 'Harry HR');
  employeeA = await seedUser('emp', 'Eve Employee');
  managerA = await seedUser('mgr', 'Manny Manager');
  financeA = await seedUser('fin', 'Fiona Finance');
  guestA = await seedUser('guest', 'Gus Guest');
  auditorA = await seedUser('aud', 'Audrey Auditor');
  invitedA = await seedUser('inv', 'Ivan Invited');
  ownerB = await seedUser('ownerb', 'Beatrice Owner');
  employeeB = await seedUser('empb', 'Bob Employee');

  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantA,
      user_id: employeeA,
      employee_code: `POL-${rid()}`,
      first_name: 'Eve',
      last_name: 'Employee',
      work_email: `pol-emp-work-${rid()}@t.test`,
      date_of_joining: '2026-01-01',
      status: 'active',
    })
    .returning();
  employeeAEmp = emp!.id;

  await seat(tenantA, ownerA, 'owner');
  await seat(tenantA, hrA, 'admin');
  await seat(tenantA, employeeA, 'employee', 'active', employeeAEmp);
  await seat(tenantA, managerA, 'manager');
  await seat(tenantA, financeA, 'finance');
  await seat(tenantA, guestA, 'guest');
  await seat(tenantA, auditorA, 'auditor');
  await seat(tenantA, invitedA, 'employee', 'invited');
  await seat(tenantB, ownerB, 'owner');
  await seat(tenantB, employeeB, 'employee');
});

afterAll(async () => {
  for (const t of trackedTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.().catch(() => {});
});

beforeEach(() => {
  auditLog.mockClear();
  sendEmail.mockClear();
  createInAppNotification.mockClear();
  putObject.mockClear();
  deleteObjects.mockClear();
  signedGetUrl.mockClear();
  grantedUsers.clear();
  r2Configured = true;
});

const auditActions = () => auditLog.mock.calls.map((c) => (c[0] as { action: string }).action);
const emailTemplates = () => sendEmail.mock.calls.map((c) => c[0]);
const emailRecipients = () => sendEmail.mock.calls.map((c) => c[1]);
const inAppUsers = () => createInAppNotification.mock.calls.map((c) => c[0]);

// ─── Lifecycle: draft → publish → acknowledge → re-acknowledge ──────────────

describe('publish + pending + acknowledge', () => {
  it('a draft is invisible in /pending and the list shows 0/0', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    expect(draft.status).toBe('draft');
    expect(draft.version).toBe(1);
    expect(draft.signed_count).toBe(0);
    expect(draft.pending_count).toBe(0);
    expect(await pendingIds(tenantA, employeeA)).not.toContain(draft.id);
    expect(auditActions()).toContain('policy.created');
    await service.archive(tenantA, hrA, draft.id);
  });

  it('publish → pending for employee, manager and finance; not for guest / auditor / an invited seat; fan-out skips the publisher', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    const res = await service.publish(tenantA, hrA, draft.id, {});
    expect(res.data.status).toBe('published');
    expect(res.data.version).toBe(1);
    expect(res.data.published_at).toBeTruthy();
    // owner, employee, manager, finance — HR (publisher) excluded; guest/auditor/invited never.
    expect(res.notified).toBe(4);
    const notifiedUsers = new Set(inAppUsers());
    expect(notifiedUsers).toEqual(new Set([ownerA, employeeA, managerA, financeA]));
    expect(notifiedUsers.has(hrA)).toBe(false);
    expect(createInAppNotification.mock.calls[0]![1]).toBe('policy.published');
    // Round R: links carry the company so a person with several companies
    // lands in the right one (TenantSync switches on ?company=).
    expect(createInAppNotification.mock.calls[0]![3]).toBe(`/policies?company=${tenantA}`);
    expect(new Set(emailTemplates())).toEqual(new Set(['policy-published']));
    expect(emailRecipients()).toHaveLength(4);
    const props = sendEmail.mock.calls[0]![2] as Record<string, unknown>;
    expect(props.policyTitle).toBe(draft.title);
    expect(String(props.link)).toBe(`http://localhost:3000/policies?company=${tenantA}`);
    expect(typeof props.companyName).toBe('string');
    expect(auditActions()).toContain('policy.published');

    expect(await pendingIds(tenantA, employeeA)).toContain(draft.id);
    expect(await pendingIds(tenantA, managerA)).toContain(draft.id);
    expect(await pendingIds(tenantA, financeA)).toContain(draft.id);
    expect(await pendingIds(tenantA, ownerA)).toContain(draft.id);
    expect(await pendingIds(tenantA, guestA)).toEqual([]);
    expect(await pendingIds(tenantA, auditorA)).toEqual([]);
    expect(await pendingIds(tenantA, invitedA)).toEqual([]);

    const pending = (await service.pendingForUser(tenantA, employeeA)).data.find((p) => p.id === draft.id)!;
    expect(pending).toMatchObject({ title: draft.title, kind: 'rich_text', version: 1, file_url: null });
    expect(pending.body_md).toContain('Take it when you need it');

    // counts: 5 applicable active members (owner, hr, employee, manager, finance), nobody signed yet
    const listed = (await service.list(tenantA)).data.find((p) => p.id === draft.id)!;
    expect(listed.signed_count).toBe(0);
    expect(listed.pending_count).toBe(5);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('acknowledge → gone from pending, idempotent on repeat, stale version → 409 POLICY_VERSION_STALE', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    auditLog.mockClear();

    const first = await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 }, { ip: '10.0.0.1', userAgent: 'x'.repeat(500) });
    expect(first.data).toMatchObject({ policy_id: draft.id, version: 1 });
    expect(first.data.acknowledged_at).toBeTruthy();
    expect(await pendingIds(tenantA, employeeA)).not.toContain(draft.id);
    expect(auditActions()).toEqual(['policy.acknowledged']);
    const [ack] = await ackRows(draft.id);
    expect(ack!.user_id).toBe(employeeA);
    expect(ack!.employee_id).toBe(employeeAEmp);
    expect(ack!.ip_hash).toBe(crypto.createHash('sha256').update('10.0.0.1policies-spec-secret').digest('hex'));
    expect(ack!.user_agent).toHaveLength(200);

    // repeat: same row, same timestamp, no second audit line
    auditLog.mockClear();
    const again = await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 });
    expect(again.data.acknowledged_at).toBe(first.data.acknowledged_at);
    expect(await ackRows(draft.id)).toHaveLength(1);
    expect(auditActions()).toEqual([]);

    const stale = await service.acknowledge(tenantA, managerA, draft.id, { version: 7 }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(HttpException);
    expect((stale as HttpException).getStatus()).toBe(409);
    expect((stale as HttpException).getResponse()).toMatchObject({ code: 'POLICY_VERSION_STALE' });
    expect(await pendingIds(tenantA, managerA)).toContain(draft.id);

    // a seat without an employee record acknowledges with employee_id null
    await service.acknowledge(tenantA, managerA, draft.id, { version: 1 });
    const mgrAck = (await ackRows(draft.id)).find((a) => a.user_id === managerA)!;
    expect(mgrAck.employee_id).toBeNull();

    const listed = (await service.list(tenantA)).data.find((p) => p.id === draft.id)!;
    expect(listed.signed_count).toBe(2);
    expect(listed.pending_count).toBe(3);

    const history = await service.myHistory(tenantA, employeeA);
    expect(history.data.find((h) => h.policy_id === draft.id)).toMatchObject({ title: draft.title, version: 1 });
    await service.archive(tenantA, hrA, draft.id);
  });

  it('re-publish with require_reacknowledgement → version 2 pending again, the v1 ack is ignored; without the flag the version stays', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 });
    expect(await pendingIds(tenantA, employeeA)).not.toContain(draft.id);

    const firstPublishedAt = (await row(draft.id))!.published_at!.toISOString();

    // same-version republish: no bump, nobody who signed is pending again, fan-out only to the still-pending,
    // and published_at keeps the version's original date (gate order / HR list don't move)
    createInAppNotification.mockClear();
    const same = await service.publish(tenantA, hrA, draft.id, {});
    expect(same.data.version).toBe(1);
    expect(same.data.published_at).toBe(firstPublishedAt);
    expect(await pendingIds(tenantA, employeeA)).not.toContain(draft.id);
    expect(inAppUsers()).not.toContain(employeeA);
    expect(same.notified).toBe(3); // owner, manager, finance

    createInAppNotification.mockClear();
    const bumped = await service.publish(tenantA, hrA, draft.id, { require_reacknowledgement: true });
    expect(bumped.data.version).toBe(2);
    expect(bumped.notified).toBe(4);
    expect(new Date(bumped.data.published_at!).getTime()).toBeGreaterThanOrEqual(new Date(firstPublishedAt).getTime());
    expect(inAppUsers()).toContain(employeeA);
    expect(await pendingIds(tenantA, employeeA)).toContain(draft.id);

    const stale = await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 }).catch((e: unknown) => e);
    expect((stale as HttpException).getStatus()).toBe(409);
    await service.acknowledge(tenantA, employeeA, draft.id, { version: 2 });
    expect(await pendingIds(tenantA, employeeA)).not.toContain(draft.id);
    expect(await ackRows(draft.id)).toHaveLength(2); // v1 + v2 rows kept as history

    const history = await service.myHistory(tenantA, employeeA);
    const versions = history.data.filter((h) => h.policy_id === draft.id).map((h) => h.version);
    expect(versions).toEqual([2, 1]);
    await service.archive(tenantA, hrA, draft.id);
  });

  it("applies_to_roles ['manager'] excludes employees from pending, acknowledge (404) and the detail (404)", async () => {
    const { data: draft } = await createRichText(tenantA, hrA, { applies_to_roles: ['manager'] });
    expect(draft.applies_to_roles).toEqual(['manager']);
    const res = await service.publish(tenantA, hrA, draft.id, {});
    expect(res.notified).toBe(1);
    expect(inAppUsers()).toEqual([managerA]);

    expect(await pendingIds(tenantA, managerA)).toContain(draft.id);
    expect(await pendingIds(tenantA, employeeA)).not.toContain(draft.id);
    expect(await pendingIds(tenantA, ownerA)).not.toContain(draft.id);

    const denied = await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 }).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(NotFoundException);
    const hidden = await service.get(actor(tenantA, employeeA, 'employee'), draft.id).catch((e: unknown) => e);
    expect(hidden).toBeInstanceOf(NotFoundException);
    const seen = await service.get(actor(tenantA, managerA, 'manager'), draft.id);
    expect(seen.data.id).toBe(draft.id);

    const listed = (await service.list(tenantA)).data.find((p) => p.id === draft.id)!;
    expect(listed.pending_count).toBe(1);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('requires_acknowledgement=false publishes without asking anyone: a neutral in-app line (no email) on the first publish only', async () => {
    const { data: draft } = await createRichText(tenantA, hrA, { requires_acknowledgement: false });
    const res = await service.publish(tenantA, hrA, draft.id, {});
    // applicable members still learn it exists — in-app only, publisher excluded
    expect(res.notified).toBe(4);
    expect(new Set(inAppUsers())).toEqual(new Set([ownerA, employeeA, managerA, financeA]));
    expect(createInAppNotification.mock.calls[0]![1]).toBe('policy.published');
    expect(String(createInAppNotification.mock.calls[0]![2])).toMatch(/has been published/);
    expect(String(createInAppNotification.mock.calls[0]![2])).not.toMatch(/acknowledgement/);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await pendingIds(tenantA, employeeA)).not.toContain(draft.id);
    const listed = (await service.list(tenantA)).data.find((p) => p.id === draft.id)!;
    expect(listed.pending_count).toBe(0);
    // still readable by a plain member (published + applicable)
    const seen = await service.get(actor(tenantA, employeeA, 'employee'), draft.id);
    expect(seen.data.requires_acknowledgement).toBe(false);
    // a content republish of an informational policy is silent
    createInAppNotification.mockClear();
    const again = await service.publish(tenantA, hrA, draft.id, {});
    expect(again.notified).toBe(0);
    expect(createInAppNotification).not.toHaveBeenCalled();
    await service.archive(tenantA, hrA, draft.id);
  });
});

// ─── HR surface: roster, CSV, reminders, archive ────────────────────────────

describe('acknowledgements, reminders, archive', () => {
  it('acknowledgements split signed / pending over active applicable members and render as CSV', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 });

    const { data } = await service.acknowledgements(tenantA, draft.id);
    expect(data.version).toBe(1);
    expect(data.signed.map((s) => s.user_id)).toEqual([employeeA]);
    expect(data.signed[0]).toMatchObject({ name: 'Eve Employee', role: 'employee' });
    expect(data.signed[0]!.acknowledged_at).toBeTruthy();
    expect(new Set(data.pending.map((p) => p.user_id))).toEqual(new Set([ownerA, hrA, managerA, financeA]));
    const pendingIdsSet = new Set(data.pending.map((p) => p.user_id));
    expect(pendingIdsSet.has(guestA)).toBe(false);
    expect(pendingIdsSet.has(auditorA)).toBe(false);
    expect(pendingIdsSet.has(invitedA)).toBe(false);

    const csv = await service.acknowledgementsCsv(tenantA, draft.id);
    const lines = csv.replace(/^﻿/, '').trim().split('\n');
    expect(lines[0]).toBe('name,email,role,status,acknowledged_at');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toMatch(/^Eve Employee,pol-emp-[0-9a-f]+@t\.test,employee,signed,20\d\d-/);
    expect(csv).toContain('Manny Manager,');
    expect(csv).toMatch(/,manager,pending,$/m);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('the CSV neutralises spreadsheet formula triggers in member-editable names (CWE-1236)', async () => {
    // Tenant B so tenant A's counts stay untouched for the other tests.
    const formulaUser = await seedUser('formula', '=HYPERLINK("https://evil.test","click")');
    await seat(tenantB, formulaUser, 'employee');
    const { data: draft } = await createRichText(tenantB, ownerB);
    await service.publish(tenantB, ownerB, draft.id, {});
    const csv = await service.acknowledgementsCsv(tenantB, draft.id);
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.test"",""click"")",`);
    expect(csv).not.toMatch(/^=HYPERLINK/m);
    expect(csv).not.toMatch(/,=HYPERLINK/);
    await service.archive(tenantB, ownerB, draft.id);
  });

  it('remind goes to every pending member (the caller included when pending), is audited, a second call inside the hour → 429 REMIND_TOO_SOON, and a version bump resets the throttle', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 });
    sendEmail.mockClear();
    createInAppNotification.mockClear();
    auditLog.mockClear();

    // The owner reminds while still pending themselves → counted like everyone else (matches the Pending tab).
    const res = await service.remind(tenantA, ownerA, draft.id);
    expect(res.data.reminded).toBe(4); // owner, hr, manager, finance
    expect(new Set(inAppUsers())).toEqual(new Set([ownerA, hrA, managerA, financeA]));
    expect(createInAppNotification.mock.calls[0]![1]).toBe('policy.reminder');
    expect(new Set(emailTemplates())).toEqual(new Set(['policy-reminder']));
    expect(emailRecipients()).toHaveLength(4);
    expect(auditActions()).toEqual(['policy.reminded']);
    expect((await row(draft.id))!.last_reminded_at).toBeTruthy();

    const again = await service.remind(tenantA, hrA, draft.id).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(HttpException);
    expect((again as HttpException).getStatus()).toBe(429);
    expect((again as HttpException).getResponse()).toMatchObject({
      code: 'REMIND_TOO_SOON',
      message: 'A reminder went out less than an hour ago',
    });

    // Marker older than an hour → allowed again.
    await dbAdmin
      .update(companyPolicies)
      .set({ last_reminded_at: new Date(Date.now() - 61 * 60 * 1000) })
      .where(eq(companyPolicies.id, draft.id));
    const later = await service.remind(tenantA, hrA, draft.id);
    expect(later.data.reminded).toBe(4); // owner, hr, manager, finance — employee signed
    expect((await row(draft.id))!.last_reminded_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // A re-publish with the flag is a new version nobody has been reminded about → the throttle is clear.
    const stillHot = await service.remind(tenantA, hrA, draft.id).catch((e: unknown) => e);
    expect((stillHot as HttpException).getStatus()).toBe(429);
    await service.publish(tenantA, hrA, draft.id, { require_reacknowledgement: true });
    expect((await row(draft.id))!.last_reminded_at).toBeNull();
    const v2 = await service.remind(tenantA, hrA, draft.id);
    expect(v2.data.reminded).toBe(5); // everyone again on v2
    await service.archive(tenantA, hrA, draft.id);
  });

  it('remind on a draft → 400; the notification stubs failing never fails the call', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    const onDraft = await service.remind(tenantA, hrA, draft.id).catch((e: unknown) => e);
    expect(onDraft).toBeInstanceOf(BadRequestException);

    sendEmail.mockImplementationOnce(async () => {
      throw new Error('resend down');
    });
    createInAppNotification.mockImplementationOnce(async () => {
      throw new Error('inbox down');
    });
    const res = await service.publish(tenantA, hrA, draft.id, {});
    expect(res.data.status).toBe('published');
    expect(res.notified).toBe(4);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('archive removes the policy from pending, zeroes the counts and keeps the signed history', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 });
    expect(await pendingIds(tenantA, managerA)).toContain(draft.id);

    const res = await service.archive(tenantA, hrA, draft.id);
    expect(res.data.status).toBe('archived');
    expect(res.data.archived_at).toBeTruthy();
    expect(res.data.signed_count).toBe(0);
    expect(res.data.pending_count).toBe(0);
    expect(await pendingIds(tenantA, managerA)).not.toContain(draft.id);
    expect(auditActions()).toContain('policy.archived');

    const { data } = await service.acknowledgements(tenantA, draft.id);
    expect(data.signed.map((s) => s.user_id)).toEqual([employeeA]);
    expect(data.pending).toEqual([]);

    // archived: no edits, no publish, no detail for plain members; idempotent archive
    expect(await service.update(tenantA, hrA, draft.id, { title: 'x' }).catch((e: unknown) => e)).toBeInstanceOf(BadRequestException);
    expect(await service.publish(tenantA, hrA, draft.id, {}).catch((e: unknown) => e)).toBeInstanceOf(BadRequestException);
    expect(await service.get(actor(tenantA, managerA, 'manager'), draft.id).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    auditLog.mockClear();
    expect((await service.archive(tenantA, hrA, draft.id)).data.status).toBe('archived');
    expect(auditActions()).toEqual([]);
  });
});

// ─── Isolation + editing rules ──────────────────────────────────────────────

describe('tenant isolation, access rule, editing', () => {
  it("tenant B's members see nothing of tenant A, and acknowledging A's policy id → 404", async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});

    expect(await pendingIds(tenantB, employeeB)).toEqual([]);
    expect((await service.list(tenantB)).data.map((p) => p.id)).not.toContain(draft.id);
    expect(await service.acknowledge(tenantB, employeeB, draft.id, { version: 1 }).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect(await service.get(actor(tenantB, ownerB, 'owner'), draft.id).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect(await service.update(tenantB, ownerB, draft.id, { title: 'stolen' }).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect(await service.publish(tenantB, ownerB, draft.id, {}).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect(await service.archive(tenantB, ownerB, draft.id).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect(await service.remind(tenantB, ownerB, draft.id).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect(await service.acknowledgements(tenantB, draft.id).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect(await ackRows(draft.id)).toHaveLength(0);
    expect((await row(draft.id))!.title).toBe(draft.title);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('GET /policies/:id — a view-grant holder opens a draft, a plain member gets 404 until it is published', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    expect(await service.get(actor(tenantA, employeeA, 'employee'), draft.id).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect((await service.get(actor(tenantA, ownerA, 'owner'), draft.id)).data.id).toBe(draft.id);
    grantedUsers.set(managerA, 'view'); // Settings → Access: manager granted policies:view
    expect((await service.get(actor(tenantA, managerA, 'manager'), draft.id)).data.body_md).toContain('Leave');
    await service.publish(tenantA, hrA, draft.id, {});
    const seen = await service.get(actor(tenantA, employeeA, 'employee'), draft.id);
    expect(seen.data).toMatchObject({ id: draft.id, status: 'published', version: 1 });
    await service.archive(tenantA, hrA, draft.id);
  });

  it('PATCH on a published policy changes the body in place and never bumps the version', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 });

    const res = await service.update(tenantA, hrA, draft.id, {
      body_md: 'Updated **text**',
      category: 'HR',
      applies_to_roles: [],
      title: '  Trimmed title  ',
    });
    expect(res.data.version).toBe(1);
    expect(res.data.status).toBe('published');
    expect(res.data.body_md).toBe('Updated **text**');
    expect(res.data.category).toBe('HR');
    expect(res.data.applies_to_roles).toBeNull(); // [] → every standard role
    expect(res.data.title).toBe('Trimmed title');
    expect(await pendingIds(tenantA, employeeA)).not.toContain(draft.id);
    expect(auditActions()).toContain('policy.updated');

    const empty = await service.update(tenantA, hrA, draft.id, { title: '   ' }).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(BadRequestException);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('PATCH can never leave a PUBLISHED policy unreadable: kind→pdf without a file and an emptied body → 400, row untouched, still readable in /pending', async () => {
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    const before = (await row(draft.id))!;
    auditLog.mockClear();

    const toPdf = await service.update(tenantA, hrA, draft.id, { kind: 'pdf' }).catch((e: unknown) => e);
    expect(toPdf).toBeInstanceOf(BadRequestException);
    expect((toPdf as BadRequestException).message).toMatch(/Upload the PDF first/);

    const emptied = await service.update(tenantA, hrA, draft.id, { body_md: '' }).catch((e: unknown) => e);
    expect(emptied).toBeInstanceOf(BadRequestException);
    expect((emptied as BadRequestException).message).toMatch(/needs its text/);
    const nulled = await service.update(tenantA, hrA, draft.id, { body_md: null }).catch((e: unknown) => e);
    expect(nulled).toBeInstanceOf(BadRequestException);
    // a combined patch that ends up empty is refused as a whole (no partial write)
    const combo = await service.update(tenantA, hrA, draft.id, { title: 'Renamed', body_md: '   ' }).catch((e: unknown) => e);
    expect(combo).toBeInstanceOf(BadRequestException);

    const after = (await row(draft.id))!;
    expect(after).toMatchObject({ kind: 'rich_text', body_md: before.body_md, title: before.title, status: 'published', version: 1 });
    expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
    expect(auditActions()).toEqual([]);
    const pending = (await service.pendingForUser(tenantA, employeeA)).data.find((p) => p.id === draft.id)!;
    expect(pending.body_md).toContain('Take it when you need it');

    // drafts stay free to be incomplete — publish() is their gate
    const { data: loose } = await createRichText(tenantA, hrA);
    expect((await service.update(tenantA, hrA, loose.id, { kind: 'pdf' })).data.kind).toBe('pdf');
    expect((await service.update(tenantA, hrA, loose.id, { kind: 'rich_text', body_md: null })).data.body_md).toBeNull();

    // a published PDF policy can't be flipped to text without a body either, but CAN once text exists
    const { data: pdf } = await service.create(tenantA, hrA, { title: 'Handbook', kind: 'pdf' });
    await service.uploadFile(tenantA, hrA, pdf.id, { buffer: PDF, originalname: 'h.pdf' });
    await service.publish(tenantA, hrA, pdf.id, {});
    const flip = await service.update(tenantA, hrA, pdf.id, { kind: 'rich_text' }).catch((e: unknown) => e);
    expect(flip).toBeInstanceOf(BadRequestException);
    const flipped = await service.update(tenantA, hrA, pdf.id, { kind: 'rich_text', body_md: 'Now as text' });
    expect(flipped.data).toMatchObject({ kind: 'rich_text', body_md: 'Now as text', version: 1 });

    await service.archive(tenantA, hrA, draft.id);
    await service.archive(tenantA, hrA, loose.id);
    await service.archive(tenantA, hrA, pdf.id);
  });

  it('publishing an empty policy → 400 (no text for rich_text, no file for pdf)', async () => {
    const { data: empty } = await service.create(tenantA, hrA, { title: 'Empty', kind: 'rich_text' });
    const e1 = await service.publish(tenantA, hrA, empty.id, {}).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(BadRequestException);
    expect((e1 as BadRequestException).message).toMatch(/Write the policy text/);

    const { data: pdfShell } = await service.create(tenantA, hrA, { title: 'PDF shell', kind: 'pdf', body_md: 'ignored for pdf' });
    const e2 = await service.publish(tenantA, hrA, pdfShell.id, {}).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(BadRequestException);
    expect((e2 as BadRequestException).message).toMatch(/Upload the policy PDF/);
    expect((await row(empty.id))!.status).toBe('draft');
    await service.archive(tenantA, hrA, empty.id);
    await service.archive(tenantA, hrA, pdfShell.id);
  });

  it('cleanMarkdown strips <script> and javascript: links from the stored body (create and update)', async () => {
    const { data: created } = await service.create(tenantA, hrA, {
      title: 'Clean me',
      kind: 'rich_text',
      body_md: '<script>alert(1)</script>Be nice [x](javascript:alert(1)) <img src=x onerror=alert(1)>',
    });
    expect(created.body_md).toBe('Be nice x');
    expect(created.body_md).not.toContain('<script');
    const { data: updated } = await service.update(tenantA, hrA, created.id, { body_md: 'ok <b>bold</b> `<Button>`' });
    expect(updated.body_md).toBe('ok bold `<Button>`');
    expect(cleanMarkdown('<script>x</script>after', { maxLen: 100 })).toBe('after');
    const tooLong = await service.update(tenantA, hrA, created.id, { body_md: 'x'.repeat(100_001) }).catch((e: unknown) => e);
    expect(tooLong).toBeInstanceOf(BadRequestException);
    await service.archive(tenantA, hrA, created.id);
  });

  it('policyAppliesToRole: NULL = standard roles only; explicit lists are exact; guest/auditor never', () => {
    expect(policyAppliesToRole({ applies_to_roles: null }, 'employee')).toBe(true);
    expect(policyAppliesToRole({ applies_to_roles: null }, 'owner')).toBe(true);
    expect(policyAppliesToRole({ applies_to_roles: null }, 'guest')).toBe(false);
    expect(policyAppliesToRole({ applies_to_roles: null }, 'auditor')).toBe(false);
    expect(policyAppliesToRole({ applies_to_roles: ['manager'] }, 'employee')).toBe(false);
    expect(policyAppliesToRole({ applies_to_roles: ['manager'] }, 'manager')).toBe(true);
    expect(policyAppliesToRole({ applies_to_roles: ['guest'] }, 'guest')).toBe(false);
  });
});

// ─── DTO hygiene through the real global ValidationPipe ─────────────────────

describe('DTOs under the global ValidationPipe', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const run = (metatype: new () => unknown, value: unknown) =>
    pipe.transform(value, { type: 'body', metatype }).then(
      () => 'ok' as const,
      (e: unknown) => e,
    );

  it('CreatePolicyDto: valid body passes; title > 200, a bad kind, a bad role and extra keys are refused', async () => {
    expect(await run(CreatePolicyDto, { title: 'Ok', kind: 'rich_text', body_md: 'x', applies_to_roles: ['employee', 'manager'] })).toBe('ok');
    expect(await run(CreatePolicyDto, { title: 'Ok', kind: 'pdf', category: null, requires_acknowledgement: false })).toBe('ok');
    expect(await run(CreatePolicyDto, { title: 'x'.repeat(201), kind: 'rich_text' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreatePolicyDto, { title: '', kind: 'rich_text' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreatePolicyDto, { title: 'Ok', kind: 'docx' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreatePolicyDto, { title: 'Ok' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreatePolicyDto, { title: 'Ok', kind: 'rich_text', applies_to_roles: ['guest'] })).toBeInstanceOf(BadRequestException);
    expect(await run(CreatePolicyDto, { title: 'Ok', kind: 'rich_text', applies_to_roles: 'employee' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreatePolicyDto, { title: 'Ok', kind: 'rich_text', category: 'c'.repeat(61) })).toBeInstanceOf(BadRequestException);
    expect(await run(CreatePolicyDto, { title: 'Ok', kind: 'rich_text', status: 'published' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreatePolicyDto, { title: 'Ok', kind: 'rich_text', version: 9 })).toBeInstanceOf(BadRequestException);
  });

  it('UpdatePolicyDto / AcknowledgePolicyDto', async () => {
    expect(await run(UpdatePolicyDto, {})).toBe('ok');
    expect(await run(UpdatePolicyDto, { body_md: null, applies_to_roles: null })).toBe('ok');
    expect(await run(UpdatePolicyDto, { kind: 'markdown' })).toBeInstanceOf(BadRequestException);
    expect(await run(UpdatePolicyDto, { file_key: 'tenants/x' })).toBeInstanceOf(BadRequestException);
    expect(await run(AcknowledgePolicyDto, { version: 1 })).toBe('ok');
    expect(await run(AcknowledgePolicyDto, { version: 0 })).toBeInstanceOf(BadRequestException);
    expect(await run(AcknowledgePolicyDto, { version: 1.5 })).toBeInstanceOf(BadRequestException);
    expect(await run(AcknowledgePolicyDto, {})).toBeInstanceOf(BadRequestException);
    expect(await run(AcknowledgePolicyDto, { version: 1, extra: true })).toBeInstanceOf(BadRequestException);
  });
});

// ─── PDF upload ─────────────────────────────────────────────────────────────

describe('PDF upload', () => {
  it('rejects a PNG by magic bytes, an over-10 MB buffer and an empty upload — nothing reaches R2', async () => {
    const { data: draft } = await service.create(tenantA, hrA, { title: 'Handbook', kind: 'pdf' });
    const png = await service.uploadFile(tenantA, hrA, draft.id, { buffer: PNG, originalname: 'cheeky.pdf' }).catch((e: unknown) => e);
    expect(png).toBeInstanceOf(BadRequestException);
    expect((png as BadRequestException).message).toMatch(/Only PDF files/);
    // A truncated header (signature with nothing behind it) makes file-type
    // throw End-Of-Stream — live verification caught this as a 500. Must be
    // the same friendly 400.
    const truncated = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(4, 0)]);
    const stub = await service.uploadFile(tenantA, hrA, draft.id, { buffer: truncated, originalname: 'stub.pdf' }).catch((e: unknown) => e);
    expect(stub).toBeInstanceOf(BadRequestException);
    expect((stub as BadRequestException).message).toMatch(/Only PDF files/);
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024, 0x20)]);
    const tooBig = await service.uploadFile(tenantA, hrA, draft.id, { buffer: big, originalname: 'big.pdf' }).catch((e: unknown) => e);
    expect(tooBig).toBeInstanceOf(BadRequestException);
    expect((tooBig as BadRequestException).message).toMatch(/maximum size is 10 MB/);
    const empty = await service.uploadFile(tenantA, hrA, draft.id, { buffer: Buffer.alloc(0) }).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(BadRequestException);
    expect(putObject).not.toHaveBeenCalled();
    expect((await row(draft.id))!.file_key).toBeNull();
    await service.archive(tenantA, hrA, draft.id);
  });

  it('stores a real PDF under tenants/<t>/policies/<id>/<uuid>.pdf, replaces + deletes the previous object, signs file_url, and publishes', async () => {
    const { data: draft } = await service.create(tenantA, hrA, { title: 'Handbook', kind: 'rich_text' });
    const res = await service.uploadFile(tenantA, hrA, draft.id, { buffer: PDF, originalname: 'Employee Handbook.pdf' });
    expect(putObject).toHaveBeenCalledTimes(1);
    const key1 = putObject.mock.calls[0]![0];
    expect(key1).toMatch(new RegExp(`^tenants/${tenantA}/policies/${draft.id}/[0-9a-f-]{36}\\.pdf$`));
    expect(putObject.mock.calls[0]![2]).toBe('application/pdf');
    expect(res.data.kind).toBe('pdf'); // uploading a PDF switches the kind
    expect(res.data.file_name).toBe('Employee Handbook.pdf');
    expect(res.data.file_size_bytes).toBe(PDF.length);
    // Round R: the web opens PDFs through the API route (a 60-s signed
    // redirect behind the sign-in); nothing is signed on upload.
    expect(res.data.file_url).toBe(`/api/v1/policies/${draft.id}/file`);
    expect(signedGetUrl).not.toHaveBeenCalled();
    expect((await row(draft.id))!.file_sha256).toBe(crypto.createHash('sha256').update(PDF).digest('hex'));
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(auditActions()).toContain('policy.file_uploaded');

    // replace → new key, the old object is deleted after commit
    await service.uploadFile(tenantA, hrA, draft.id, { buffer: PDF, originalname: '../../evil\\name.pdf' });
    const key2 = putObject.mock.calls[1]![0];
    expect(key2).not.toBe(key1);
    expect(deleteObjects).toHaveBeenCalledWith([key1]);
    expect((await row(draft.id))!.file_name).toBe('.._.._evil_name.pdf');

    const published = await service.publish(tenantA, hrA, draft.id, {});
    expect(published.data.status).toBe('published');
    const pending = (await service.pendingForUser(tenantA, employeeA)).data.find((p) => p.id === draft.id)!;
    expect(pending.kind).toBe('pdf');
    expect(pending.file_url).toBe(`/api/v1/policies/${draft.id}/file`);
    // Opening it: visibility rule, then a 60-second signed URL.
    const url = await service.fileRedirect({ userId: employeeA, tenantId: tenantA, role: 'employee' }, draft.id);
    expect(url).toBe(`https://signed.test/${key2}`);
    expect(signedGetUrl).toHaveBeenCalledWith(key2, 60);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('503 with a clear message when storage is not configured; unknown policy → 404 before any put', async () => {
    const { data: draft } = await service.create(tenantA, hrA, { title: 'Handbook', kind: 'pdf' });
    r2Configured = false;
    const off = await service.uploadFile(tenantA, hrA, draft.id, { buffer: PDF, originalname: 'h.pdf' }).catch((e: unknown) => e);
    expect(off).toBeInstanceOf(ServiceUnavailableException);
    expect((off as ServiceUnavailableException).message).toMatch(/not configured/);
    r2Configured = true;
    const missing = await service
      .uploadFile(tenantA, hrA, crypto.randomUUID(), { buffer: PDF, originalname: 'h.pdf' })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(putObject).not.toHaveBeenCalled();
    // a signing failure on open is a clean 503, never a 500
    await service.uploadFile(tenantA, hrA, draft.id, { buffer: PDF, originalname: 'h.pdf' });
    signedGetUrl.mockImplementationOnce(async () => {
      throw new Error('sig down');
    });
    const sigDown = await service.fileRedirect({ userId: hrA, tenantId: tenantA, role: 'admin' }, draft.id).catch((e: unknown) => e);
    expect(sigDown).toBeInstanceOf(ServiceUnavailableException);
    await service.archive(tenantA, hrA, draft.id);
  });
});

// ─── Data-export facade ─────────────────────────────────────────────────────

describe('PoliciesPublicService (consent/data-export facade)', () => {
  it('exportForUser lists my acknowledgements; exportForTenant lists policies + acknowledgements, tenant-scoped', async () => {
    const { data: draft } = await createRichText(tenantA, hrA, { title: `Export policy ${rid()}` });
    await service.publish(tenantA, hrA, draft.id, {});
    await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 });

    const mine = await pub.exportForUser(tenantA, employeeA);
    expect(mine.find((r) => r.policy_title === draft.title)).toMatchObject({ version: 1 });
    expect(await pub.exportForUser(tenantB, employeeB)).toEqual([]);

    const org = await pub.exportForTenant(tenantA);
    const p = org.policies.find((x) => x.id === draft.id)!;
    expect(p).toMatchObject({ title: draft.title, status: 'published', version: 1, applies_to_roles: 'all' });
    const a = org.acknowledgements.find((x) => x.policy_id === draft.id)!;
    expect(a).toMatchObject({ policy_title: draft.title, policy_version: 1, user_id: employeeA, user_name: 'Eve Employee' });
    const orgB = await pub.exportForTenant(tenantB);
    expect(orgB.policies.map((x) => x.id)).not.toContain(draft.id);
    expect(orgB.acknowledgements).toEqual([]);
    await service.archive(tenantA, hrA, draft.id);
  });
});

// ─── Membership liveness inside the service ─────────────────────────────────

describe('deactivated seats', () => {
  it('a deactivated member drops out of pending, the roster and the counts', async () => {
    const extra = await seedUser('deact', 'Dee Deactivated');
    await seat(tenantA, extra, 'employee');
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    expect(await pendingIds(tenantA, extra)).toContain(draft.id);
    const before = (await service.list(tenantA)).data.find((p) => p.id === draft.id)!;

    await dbAdmin
      .update(memberships)
      .set({ status: 'deactivated' })
      .where(and(eq(memberships.tenant_id, tenantA), eq(memberships.user_id, extra)));
    expect(await pendingIds(tenantA, extra)).toEqual([]);
    expect(await service.acknowledge(tenantA, extra, draft.id, { version: 1 }).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    const after = (await service.list(tenantA)).data.find((p) => p.id === draft.id)!;
    expect(after.pending_count).toBe(before.pending_count - 1);
    const { data } = await service.acknowledgements(tenantA, draft.id);
    expect(data.pending.map((p) => p.user_id)).not.toContain(extra);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('a seat whose access window lapsed (access_expires_at in the past) is not live: out of pending, roster, counts and acknowledge → 404; a future window keeps it live', async () => {
    const windowed = await seedUser('window', 'Wendy Windowed');
    await seat(tenantA, windowed, 'employee');
    const { data: draft } = await createRichText(tenantA, hrA);
    await service.publish(tenantA, hrA, draft.id, {});
    const base = (await service.list(tenantA)).data.find((p) => p.id === draft.id)!;

    // still open → live, same as the guard
    await dbAdmin
      .update(memberships)
      .set({ access_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      .where(and(eq(memberships.tenant_id, tenantA), eq(memberships.user_id, windowed)));
    expect(await pendingIds(tenantA, windowed)).toContain(draft.id);
    expect((await service.list(tenantA)).data.find((p) => p.id === draft.id)!.pending_count).toBe(base.pending_count);

    // lapsed → gone everywhere the guard would already refuse them
    await dbAdmin
      .update(memberships)
      .set({ access_expires_at: new Date(Date.now() - 60_000) })
      .where(and(eq(memberships.tenant_id, tenantA), eq(memberships.user_id, windowed)));
    expect(await pendingIds(tenantA, windowed)).toEqual([]);
    expect(await service.acknowledge(tenantA, windowed, draft.id, { version: 1 }).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect(await service.get(actor(tenantA, windowed, 'employee'), draft.id).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    expect((await service.list(tenantA)).data.find((p) => p.id === draft.id)!.pending_count).toBe(base.pending_count - 1);
    const { data } = await service.acknowledgements(tenantA, draft.id);
    expect(data.pending.map((p) => p.user_id)).not.toContain(windowed);
    createInAppNotification.mockClear();
    await service.remind(tenantA, hrA, draft.id);
    expect(inAppUsers()).not.toContain(windowed);

    await dbAdmin.delete(memberships).where(and(eq(memberships.tenant_id, tenantA), eq(memberships.user_id, windowed)));
    await service.archive(tenantA, hrA, draft.id);
  });
});

// ─── Controller: grant placement (reflection) ───────────────────────────────

describe('PoliciesController grant placement', () => {
  it('management handlers carry @RequireGrant(policies, …); self-service ones do not; the class carries PoliciesGrantGuard', () => {
    const grantOf = (method: string): GrantRequirement | undefined =>
      Reflect.getMetadata(REQUIRE_GRANT_KEY, (PoliciesController.prototype as unknown as Record<string, unknown>)[method] as object);
    const expected: Record<string, 'view' | 'edit' | undefined> = {
      list: 'view',
      create: 'edit',
      update: 'edit',
      uploadFile: 'edit',
      publish: 'edit',
      archive: 'edit',
      acknowledgements: 'view',
      remind: 'edit',
      pending: undefined,
      history: undefined,
      get: undefined,
      acknowledge: undefined,
    };
    for (const [method, level] of Object.entries(expected)) {
      const grant = grantOf(method);
      if (level === undefined) {
        expect({ method, grant }).toEqual({ method, grant: undefined });
      } else {
        expect({ method, grant }).toEqual({ method, grant: { module: 'policies', level, capability: undefined } });
      }
    }
    const guards = (Reflect.getMetadata('__guards__', PoliciesController) ?? []) as Array<{ name: string }>;
    expect(guards.map((g) => g.name)).toContain('PoliciesGrantGuard');
  });
});

// ─── Round R: delete + the file route + the company-bound FK ───────────────

describe('Round R — delete, file route, company-bound acknowledgements', () => {
  const PDF_R = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

  it('the file route applies the visibility rule: HR any status, an employee only a published policy that applies, another company 404, no file 404', async () => {
    const { data: draft } = await service.create(tenantA, hrA, { title: 'Travel policy', kind: 'rich_text' });
    const noFile = await service.fileRedirect({ userId: hrA, tenantId: tenantA, role: 'admin' }, draft.id).catch((e: unknown) => e);
    expect(noFile).toBeInstanceOf(NotFoundException);
    await service.uploadFile(tenantA, hrA, draft.id, { buffer: PDF_R, originalname: 't.pdf' });
    const key = putObject.mock.calls.at(-1)![0];
    // draft: HR yes, employee no
    expect(await service.fileRedirect({ userId: hrA, tenantId: tenantA, role: 'admin' }, draft.id)).toBe(`https://signed.test/${key}`);
    const emp = await service.fileRedirect({ userId: employeeA, tenantId: tenantA, role: 'employee' }, draft.id).catch((e: unknown) => e);
    expect(emp).toBeInstanceOf(NotFoundException);
    await service.publish(tenantA, hrA, draft.id, {});
    expect(await service.fileRedirect({ userId: employeeA, tenantId: tenantA, role: 'employee' }, draft.id)).toBe(`https://signed.test/${key}`);
    // another company's owner, same id → 404 (no existence leak)
    const foreign = await service.fileRedirect({ userId: ownerB, tenantId: tenantB, role: 'owner' }, draft.id).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);
    // targeted at managers only → an employee can no longer open it
    await service.update(tenantA, hrA, draft.id, { applies_to_roles: ['manager'] });
    const notMine = await service.fileRedirect({ userId: employeeA, tenantId: tenantA, role: 'employee' }, draft.id).catch((e: unknown) => e);
    expect(notMine).toBeInstanceOf(NotFoundException);
    await service.archive(tenantA, hrA, draft.id);
  });

  it('delete: gone from list / detail / pending / roster, PDF removed, acknowledgements kept, audited; second delete and other company → 404', async () => {
    const { data: draft } = await service.create(tenantA, hrA, { title: 'Dress code', kind: 'rich_text', body_md: 'Smart casual.' });
    await service.uploadFile(tenantA, hrA, draft.id, { buffer: PDF_R, originalname: 'dress.pdf' });
    const key = putObject.mock.calls.at(-1)![0];
    await service.publish(tenantA, hrA, draft.id, {});
    await service.acknowledge(tenantA, employeeA, draft.id, { version: 1 });
    expect((await service.pendingForUser(tenantA, managerA)).data.some((p) => p.id === draft.id)).toBe(true);

    const foreign = await service.remove(tenantB, ownerB, draft.id).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);

    deleteObjects.mockClear();
    const res = await service.remove(tenantA, hrA, draft.id);
    expect(res.data).toEqual({ id: draft.id, deleted: true });
    expect(deleteObjects).toHaveBeenCalledWith([key]);
    expect(auditActions()).toContain('policy.deleted');
    const audited = auditLog.mock.calls.map((c) => c[0] as { action: string; metadata?: Record<string, unknown> }).find((d) => d.action === 'policy.deleted')!;
    expect(audited.metadata).toMatchObject({ title: 'Dress code', version: 1, acknowledgements_kept: 1, file_removed: true });

    expect((await service.list(tenantA, hrA)).data.some((p) => p.id === draft.id)).toBe(false);
    const gone = await service.get({ userId: hrA, tenantId: tenantA, role: 'admin' }, draft.id).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(NotFoundException);
    expect((await service.pendingForUser(tenantA, managerA)).data.some((p) => p.id === draft.id)).toBe(false);
    const roster = await service.acknowledgements(tenantA, draft.id, hrA).catch((e: unknown) => e);
    expect(roster).toBeInstanceOf(NotFoundException);
    const file = await service.fileRedirect({ userId: hrA, tenantId: tenantA, role: 'admin' }, draft.id).catch((e: unknown) => e);
    expect(file).toBeInstanceOf(NotFoundException);
    // the proof survives: the acknowledgement row and the member's history
    const acks = await dbAdmin.select().from(policyAcknowledgements).where(eq(policyAcknowledgements.policy_id, draft.id));
    expect(acks).toHaveLength(1);
    expect((await service.myHistory(tenantA, employeeA)).data.some((h) => h.policy_id === draft.id && h.version === 1)).toBe(true);
    expect((await row(draft.id))!.deleted_at).not.toBeNull();
    // the org export still lists it, marked deleted
    const org = await pub.exportForTenant(tenantA);
    expect(org.policies.find((p) => p.id === draft.id)?.deleted_at).toBeTruthy();
    // again → 404; archive / publish / update after delete → 404
    const again = await service.remove(tenantA, hrA, draft.id).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(NotFoundException);
    const pub2 = await service.publish(tenantA, hrA, draft.id, {}).catch((e: unknown) => e);
    expect(pub2).toBeInstanceOf(NotFoundException);
    // a deleted policy keeps status 'published' for the proof — it must never
    // take a NEW agreement (PolicyGate still open, or a crafted POST)
    const ackAfter = await service.acknowledge(tenantA, managerA, draft.id, { version: 1 }).catch((e: unknown) => e);
    expect(ackAfter).toBeInstanceOf(NotFoundException);
    expect(await dbAdmin.select().from(policyAcknowledgements).where(eq(policyAcknowledgements.policy_id, draft.id))).toHaveLength(1);
    expect(auditActions().filter((a) => a === 'policy.acknowledged')).toHaveLength(1);
  });

  it('the controller ranks delete to Owner / HR admin on top of the edit grant, and exposes the file route', () => {
    const proto = PoliciesController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ROLES_KEY, proto.remove!)).toEqual(['admin']);
    expect(Reflect.getMetadata(REQUIRE_GRANT_KEY, proto.remove!)).toMatchObject({ module: 'policies', level: 'edit' } as GrantRequirement);
    expect(typeof proto.file).toBe('function');
    expect(Reflect.getMetadata(ROLES_KEY, proto.file!)).toBeUndefined();
  });

  it("the database refuses an acknowledgement that points at another company's policy (composite FK, 0069)", async () => {
    const { data: draft } = await service.create(tenantA, hrA, { title: 'FK probe', kind: 'rich_text', body_md: 'x' });
    const err = await dbAdmin
      .insert(policyAcknowledgements)
      .values({ tenant_id: tenantB, policy_id: draft.id, policy_version: 1, user_id: employeeB })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code ?? err)).toMatch(/23503|foreign key/i);
    await service.archive(tenantA, hrA, draft.id);
  });
});
