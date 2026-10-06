/**
 * Round P R4 — company asset register (migration 0068, module `assets`).
 *
 * Service-level against the real Postgres (RLS-bound tenant pool), stubs for
 * audit / notifications / media, mirroring policies.spec. Covers: tag
 * numbering (server AST-NNNN, explicit tags, duplicate 409, deleted-row
 * reuse, next-tag skipping deleted numbers, a parallel blank-tag burst under
 * the advisory lock, case-insensitive uniqueness), list / filters / q /
 * total, summary, detail + history, update (status while assigned → 409),
 * assign (status flip, row, fan-out recipients + props, cross-tenant
 * employee, separated employee, double assign, retired asset), return,
 * acknowledge (holder / idempotent / 403s), /me, seat liveness on the
 * self-service routes, by-employee, delete gating (+ photo cleanup), the
 * photo pipeline (prefix, replace, remove, 15-minute R2 signing), CSV (BOM +
 * formula neutralisation), cross-tenant 404s, DTO hygiene through the real
 * ValidationPipe (incl. nulls on NOT NULL fields), the controller's @Roles
 * placement (reflection) and its route order through a real Nest app on an
 * ephemeral port (static paths before `:id`, export.csv).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { assetAssignments, assets, employees, memberships, tenants, users } from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import type { R2Service } from '../core/storage/r2.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { MediaService } from '../modules/media/media.service';
import { AssetsService, csvCell } from '../modules/assets/assets.service';
import { AssetsController } from '../modules/assets/assets.controller';
import {
  AssignAssetDto,
  CreateAssetDto,
  ListAssetsQueryDto,
  ReturnAssetDto,
  UpdateAssetDto,
} from '../modules/assets/assets.dto';
import { countAllAssignmentsTx, countOpenAssignmentsTx, listOpenAssignmentsTx } from '../modules/assets/public';
import { ROLES_KEY } from '../core/auth/decorators/roles.decorator';

const rid = () => crypto.randomBytes(4).toString('hex');

// ─── Stubs ──────────────────────────────────────────────────────────────────
const auditLog = jest.fn(async (_dto: unknown) => undefined);
const audit = { log: auditLog } as unknown as AuditService;
const sendEmail = jest.fn(async (_tpl: unknown, _to: unknown, _props: unknown, _opts?: unknown) => true);
const createInAppNotification = jest.fn(async (..._args: unknown[]) => undefined);
const notifications = { sendEmail, createInAppNotification } as unknown as NotificationsService;
const processImage = jest.fn(async (_buf: Buffer, prefix: string) => {
  const id = crypto.randomUUID();
  return { key256: `${prefix}/${id}_256.webp`, key64: `${prefix}/${id}_64.webp` };
});
const deleteImage = jest.fn(async (_key: string) => undefined);
const servedUrl = jest.fn(async (key: string | null, legacy: string | null, size: 256 | 64 = 256) =>
  key ? `https://signed.test/${size === 64 ? key.replace('_256.webp', '_64.webp') : key}` : legacy,
);
const media = { processImage, deleteImage, servedUrl } as unknown as MediaService;
const config = new ConfigService({ APP_URL: 'http://localhost:3000/' });
const service = new AssetsService(new DatabaseService(), media, notifications, audit, config);

// ─── Fixtures ───────────────────────────────────────────────────────────────
let tenantA: string;
let tenantB: string;
let tenantC: string; // tag-numbering sandbox
let ownerA: string; // owner seat, NO employee record
let hrA: string; // admin seat
let e1User: string;
let e2User: string;
let sepUser: string;
let ownerB: string;
let eBUser: string;
let E1: string; // active, user e1User
let E2: string; // active, user e2User
let E3: string; // separated
let E4: string; // active, no user (work email only)
let EB: string; // tenant B employee
let e1WorkEmail: string;
let e4WorkEmail: string;
const trackedTenants: string[] = [];
const trackedUsers: string[] = [];

async function seedUser(label: string, fullName: string) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `ast-${label}-${rid()}@t.test`, full_name: fullName, status: 'active' })
    .returning();
  trackedUsers.push(u!.id);
  return u!.id;
}

async function mkTenant(label: string) {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `Assets ${label} ${rid()}`, slug: `ast-${label}-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  trackedTenants.push(t!.id);
  return t!.id;
}

async function seat(tenantId: string, userId: string, role: UserRole, employeeId: string | null = null) {
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: userId,
    role,
    status: 'active',
    employee_id: employeeId,
    accepted_at: new Date(),
  });
}

async function seedEmployee(
  tenantId: string,
  userId: string | null,
  first: string,
  last: string,
  status: 'active' | 'separated' | 'notice_period' = 'active',
) {
  const workEmail = `ast-work-${rid()}@t.test`;
  const [e] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      employee_code: `AST-${rid()}`,
      first_name: first,
      last_name: last,
      work_email: workEmail,
      date_of_joining: '2026-01-01',
      status,
    })
    .returning();
  return { id: e!.id, workEmail };
}

const assetRow = async (id: string) => {
  const [r] = await dbAdmin.select().from(assets).where(eq(assets.id, id));
  return r ?? null;
};
const assignmentRows = (assetId: string) =>
  dbAdmin.select().from(assetAssignments).where(eq(assetAssignments.asset_id, assetId));

const auditActions = () => auditLog.mock.calls.map((c) => (c[0] as { action: string }).action);
const codeOf = (e: unknown) => ((e as HttpException).getResponse() as { code?: string }).code;

beforeAll(async () => {
  tenantA = await mkTenant('a');
  tenantB = await mkTenant('b');
  tenantC = await mkTenant('c');
  ownerA = await seedUser('owner', 'Olivia Owner');
  hrA = await seedUser('hr', 'Harry HR');
  e1User = await seedUser('e1', 'Eve Employee');
  e2User = await seedUser('e2', 'Erin Second');
  sepUser = await seedUser('sep', 'Sam Separated');
  ownerB = await seedUser('ownerb', 'Beatrice Owner');
  eBUser = await seedUser('eb', 'Bob Elsewhere');

  const e1 = await seedEmployee(tenantA, e1User, 'Eve', 'Employee');
  E1 = e1.id;
  e1WorkEmail = e1.workEmail;
  E2 = (await seedEmployee(tenantA, e2User, 'Erin', 'Second', 'notice_period')).id;
  E3 = (await seedEmployee(tenantA, sepUser, 'Sam', 'Separated', 'separated')).id;
  const e4 = await seedEmployee(tenantA, null, 'Nina', 'NoSeat');
  E4 = e4.id;
  e4WorkEmail = e4.workEmail;
  EB = (await seedEmployee(tenantB, eBUser, 'Bob', 'Elsewhere')).id;

  await seat(tenantA, ownerA, 'owner');
  await seat(tenantA, hrA, 'admin');
  await seat(tenantA, e1User, 'employee', E1);
  await seat(tenantA, e2User, 'employee', E2);
  await seat(tenantA, sepUser, 'employee', E3);
  await seat(tenantB, ownerB, 'owner');
  await seat(tenantB, eBUser, 'employee', EB);
  await seat(tenantC, hrA, 'admin');
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
  processImage.mockClear();
  deleteImage.mockClear();
  servedUrl.mockClear();
});

// ─── Tag numbering (tenant C sandbox) ───────────────────────────────────────

describe('create + tags', () => {
  it('server tags AST-0001 then AST-0002; defaults (in_stock / good / INR); explicit tag trimmed; number → 2-dp string', async () => {
    const { data: a1 } = await service.create(tenantC, hrA, { name: '  Laptop one ', category: 'laptop' });
    expect(a1.asset_tag).toBe('AST-0001');
    expect(a1.name).toBe('Laptop one');
    expect(a1).toMatchObject({ status: 'in_stock', condition: 'good', currency: 'INR', current_assignment: null, photo_url: null });
    expect((a1 as unknown as { history?: unknown }).history).toBeUndefined();
    expect(auditActions()).toEqual(['asset.created']);

    const { data: a2 } = await service.create(tenantC, hrA, {
      name: 'Laptop two',
      category: 'laptop',
      purchase_value: 54999.5,
      purchase_date: '2026-03-15',
      currency: 'inr',
      condition: 'new',
    });
    expect(a2.asset_tag).toBe('AST-0002');
    expect(a2.purchase_value).toBe('54999.50');
    expect(a2.purchase_date).toBe('2026-03-15');
    expect(a2.currency).toBe('INR');
    expect(a2.condition).toBe('new');

    const { data: lap } = await service.create(tenantC, hrA, { asset_tag: '  LAP-07 ', name: 'Dell', category: 'laptop' });
    expect(lap.asset_tag).toBe('LAP-07');

    expect((await service.nextTag(tenantC, hrA)).data.asset_tag).toBe('AST-0003');
  });

  it('duplicate live tag → 409 ASSET_TAG_TAKEN; a deleted row’s tag is reusable; next-tag skips deleted rows’ numbers', async () => {
    const dup = await service.create(tenantC, hrA, { asset_tag: 'LAP-07', name: 'HP', category: 'laptop' }).catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(ConflictException);
    expect((dup as HttpException).getResponse()).toMatchObject({ code: 'ASSET_TAG_TAKEN', message: 'Asset tag LAP-07 is already in use' });

    const { data: list } = await service.list(tenantC, {}, hrA);
    const lap = list.find((a) => a.asset_tag === 'LAP-07')!;
    const two = list.find((a) => a.asset_tag === 'AST-0002')!;
    expect(await service.remove(tenantC, hrA, lap.id)).toEqual({ data: { deleted: true } });
    expect((await assetRow(lap.id))!.deleted_at).toBeTruthy();
    const { data: again } = await service.create(tenantC, hrA, { asset_tag: 'LAP-07', name: 'HP', category: 'laptop' });
    expect(again.asset_tag).toBe('LAP-07');

    await service.remove(tenantC, hrA, two.id);
    expect((await service.nextTag(tenantC, hrA)).data.asset_tag).toBe('AST-0003');
    const { data: three } = await service.create(tenantC, hrA, { name: 'Laptop three', category: 'laptop' });
    expect(three.asset_tag).toBe('AST-0003');
    expect((await service.nextTag(tenantC, hrA)).data.asset_tag).toBe('AST-0004');

    // the register only shows live rows; total agrees
    const after = await service.list(tenantC, {}, hrA);
    expect(after.data.map((a) => a.asset_tag).sort()).toEqual(['AST-0001', 'AST-0003', 'LAP-07']);
    expect(after.total).toBe(3);
    // a bad calendar date is a 400 in product voice (never the wire key, never a 500)
    const badDate = await service.create(tenantC, hrA, { name: 'x', category: 'other', purchase_date: '2026-13-45' }).catch((e: unknown) => e);
    expect(badDate).toBeInstanceOf(BadRequestException);
    expect((badDate as BadRequestException).message).toBe('Purchase date isn’t a real calendar date (use YYYY-MM-DD)');
  });

  it('six blank-tag adds at once all succeed with consecutive tags (advisory lock — no 409 for a tag the user never typed)', async () => {
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, i) => service.create(tenantC, hrA, { name: `Batch ${i}`, category: 'peripheral' })),
    );
    const tags = burst.map((r) => r.data.asset_tag).sort();
    expect(new Set(tags).size).toBe(6);
    expect(tags).toEqual(['AST-0004', 'AST-0005', 'AST-0006', 'AST-0007', 'AST-0008', 'AST-0009']);
    expect((await service.nextTag(tenantC, hrA)).data.asset_tag).toBe('AST-0010');
    expect(auditActions().filter((a) => a === 'asset.created')).toHaveLength(6);
  });

  it('tags are unique case-insensitively on create and rename; renaming an asset to its own tag in another case is fine', async () => {
    const lower = await service.create(tenantC, hrA, { asset_tag: 'lap-07', name: 'HP', category: 'laptop' }).catch((e: unknown) => e);
    expect(lower).toBeInstanceOf(ConflictException);
    expect((lower as HttpException).getResponse()).toMatchObject({ code: 'ASSET_TAG_TAKEN', message: 'Asset tag lap-07 is already in use' });

    const { data: list } = await service.list(tenantC, {}, hrA);
    const one = list.find((a) => a.asset_tag === 'AST-0001')!;
    const lap = list.find((a) => a.asset_tag === 'LAP-07')!;
    const rename = await service.update(tenantC, hrA, one.id, { asset_tag: 'Lap-07' }).catch((e: unknown) => e);
    expect(rename).toBeInstanceOf(ConflictException);
    expect(codeOf(rename)).toBe('ASSET_TAG_TAKEN');
    expect((await assetRow(one.id))!.asset_tag).toBe('AST-0001');

    const self = await service.update(tenantC, hrA, lap.id, { asset_tag: 'lap-07' });
    expect(self.data.asset_tag).toBe('lap-07');
  });
});

// ─── Main flow (tenant A) ───────────────────────────────────────────────────

let L1: string; // laptop → E1
let P1: string; // phone
let S1: string; // SIM → E4 (no seat)
let M1: string; // monitor → retired

describe('register, assign, acknowledge, return', () => {
  it('registers rows; list orders assigned first then by tag; filters, q and total work', async () => {
    L1 = (await service.create(tenantA, hrA, { name: 'MacBook Pro 14', category: 'laptop', brand: 'Apple', model: 'A2779', serial_number: 'C02XYZ123' })).data.id;
    P1 = (await service.create(tenantA, hrA, { name: 'iPhone 13', category: 'phone', brand: 'Apple', serial_number: 'IMEI-9' })).data.id;
    S1 = (await service.create(tenantA, hrA, { name: 'Jio SIM', category: 'sim', notes: 'number ends 4321' })).data.id;
    M1 = (await service.create(tenantA, hrA, { name: 'Dell U2722D', category: 'monitor', brand: 'Dell' })).data.id;

    const all = await service.list(tenantA, {}, hrA);
    expect(all.total).toBe(4);
    expect(all.data.map((a) => a.asset_tag)).toEqual(['AST-0001', 'AST-0002', 'AST-0003', 'AST-0004']);

    const apple = await service.list(tenantA, { q: 'apple' }, hrA);
    expect(apple.data.map((a) => a.id).sort()).toEqual([L1, P1].sort());
    expect(apple.total).toBe(2);
    const serial = await service.list(tenantA, { q: 'c02xyz' }, hrA);
    expect(serial.data.map((a) => a.id)).toEqual([L1]);
    const wild = await service.list(tenantA, { q: '%' }, hrA); // wildcards are literal
    expect(wild.total).toBe(0);
    const phones = await service.list(tenantA, { category: 'phone' }, hrA);
    expect(phones.data.map((a) => a.id)).toEqual([P1]);
    const paged = await service.list(tenantA, { limit: 2, offset: 1 }, hrA);
    expect(paged.data).toHaveLength(2);
    expect(paged.total).toBe(4);
    expect(paged.data[0]!.asset_tag).toBe('AST-0002');
  });

  it('summary counts live rows by status', async () => {
    await service.update(tenantA, hrA, M1, { status: 'retired' });
    expect((await service.summary(tenantA, hrA)).data).toEqual({
      total: 4,
      assigned: 0,
      in_stock: 3,
      under_repair: 0,
      retired: 1,
      lost: 0,
      awaiting_acknowledgement: 0,
    });
    expect(auditActions()).toContain('asset.updated');
    const upd = auditLog.mock.calls.find((c) => (c[0] as { action: string }).action === 'asset.updated')![0] as {
      beforeState: Record<string, unknown>;
      afterState: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    expect(upd.beforeState).toEqual({ status: 'in_stock' });
    expect(upd.afterState).toEqual({ status: 'retired' });
    expect(upd.metadata).toEqual({ fields: ['status'] });
  });

  it('assign: status → assigned, condition = issue condition, row written, in-app + email to the holder with the right props', async () => {
    const { data } = await service.assign(tenantA, hrA, L1, { employee_id: E1, issue_condition: 'new', notes: 'with charger' });
    expect(data.status).toBe('assigned');
    expect(data.condition).toBe('new');
    expect(data.current_assignment).toMatchObject({
      employee_id: E1,
      employee_name: 'Eve Employee',
      assigned_by_name: 'Harry HR',
      issue_condition: 'new',
      notes: 'with charger',
      acknowledged_at: null,
    });
    expect(data.current_assignment!.employee_code).toMatch(/^AST-/);
    expect(data.history).toHaveLength(1);
    expect(data.history[0]!.id).toBe(data.current_assignment!.id);
    expect(data.history[0]!.returned_at).toBeNull();

    const rows = await assignmentRows(L1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: tenantA, employee_id: E1, assigned_by: hrA, issue_condition: 'new', returned_at: null });
    expect((await assetRow(L1))!.status).toBe('assigned');

    expect(createInAppNotification).toHaveBeenCalledTimes(1);
    expect(createInAppNotification.mock.calls[0]).toEqual([
      e1User,
      'asset.assigned',
      'MacBook Pro 14 (AST-0001) was issued to you — please acknowledge receipt',
      '/employees/assets?view=me',
      tenantA,
      { groupKey: `asset:${L1}` },
    ]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [tpl, to, props, opts] = sendEmail.mock.calls[0]!;
    expect(tpl).toBe('asset-assigned');
    expect(to).toBe(e1WorkEmail);
    expect(props).toMatchObject({
      assetName: 'MacBook Pro 14',
      assetTag: 'AST-0001',
      link: 'http://localhost:3000/employees/assets?view=me',
      issuedBy: 'Harry HR',
      issueCondition: 'new',
      notes: 'with charger',
    });
    expect(typeof (props as { companyName: unknown }).companyName).toBe('string');
    expect(opts).toEqual({ userId: e1User });
    const assignedAudit = auditLog.mock.calls.find((c) => (c[0] as { action: string }).action === 'asset.assigned')![0] as {
      resourceType: string;
      resourceId: string;
      metadata: Record<string, unknown>;
    };
    expect(assignedAudit.resourceType).toBe('asset');
    expect(assignedAudit.resourceId).toBe(L1);
    expect(assignedAudit.metadata).toEqual({ employee_id: E1, assignment_id: rows[0]!.id });

    // the register now shows the assigned one first; employee_id filters to what they hold
    const list = await service.list(tenantA, {}, hrA);
    expect(list.data[0]!.id).toBe(L1);
    const held = await service.list(tenantA, { employee_id: E1 }, hrA);
    expect(held.data.map((a) => a.id)).toEqual([L1]);
    expect(held.total).toBe(1);
    expect((await service.summary(tenantA, hrA)).data).toMatchObject({ assigned: 1, in_stock: 2, awaiting_acknowledgement: 1 });
  });

  it('assign guards: double assign 409, other tenant’s employee 404, separated 400, retired 409, future date 400, status edit while held 409', async () => {
    const twice = await service.assign(tenantA, hrA, L1, { employee_id: E2 }).catch((e: unknown) => e);
    expect(twice).toBeInstanceOf(ConflictException);
    expect((twice as HttpException).getResponse()).toMatchObject({
      code: 'ASSET_ALREADY_ASSIGNED',
      message: 'Already assigned to Eve Employee — record the return first',
    });

    const foreign = await service.assign(tenantA, hrA, P1, { employee_id: EB }).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);

    const gone = await service.assign(tenantA, hrA, P1, { employee_id: E3 }).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(BadRequestException);
    expect((gone as BadRequestException).message).toBe('Sam Separated is no longer with the company');

    const retired = await service.assign(tenantA, hrA, M1, { employee_id: E1 }).catch((e: unknown) => e);
    expect(retired).toBeInstanceOf(ConflictException);
    expect(codeOf(retired)).toBe('ASSET_UNAVAILABLE');

    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const early = await service.assign(tenantA, hrA, P1, { employee_id: E1, assigned_at: future }).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(BadRequestException);
    expect((early as BadRequestException).message).toBe('The issue date can’t be in the future');

    const flip = await service.update(tenantA, hrA, L1, { status: 'in_stock' }).catch((e: unknown) => e);
    expect(flip).toBeInstanceOf(ConflictException);
    expect((flip as HttpException).getResponse()).toMatchObject({ code: 'ASSET_ASSIGNED', message: 'Return the asset first' });
    // non-status edits are fine while held
    const edited = await service.update(tenantA, hrA, L1, { notes: 'HR laptop pool', brand: ' Apple ' });
    expect(edited.data.notes).toBe('HR laptop pool');
    expect(edited.data.status).toBe('assigned');

    // nothing was written and nobody was pinged by the failures
    expect(await assignmentRows(P1)).toHaveLength(0);
    expect((await assetRow(P1))!.status).toBe('in_stock');
    expect(createInAppNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a holder without a seat (no user) gets the email but no bell; a backdated assigned_at is kept', async () => {
    const when = '2026-02-01T09:30:00.000Z';
    const { data } = await service.assign(tenantA, hrA, S1, { employee_id: E4, assigned_at: when });
    expect(data.current_assignment!.assigned_at).toBe(when);
    expect(data.current_assignment!.employee_name).toBe('Nina NoSeat');
    expect(data.condition).toBe('good'); // issue_condition defaulted to the asset's condition
    expect(data.current_assignment!.issue_condition).toBe('good');
    expect(createInAppNotification).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![1]).toBe(e4WorkEmail);
    expect(sendEmail.mock.calls[0]![3]).toBeUndefined();
  });

  it('acknowledge: another employee → 403, a seat without an employee record → 403, nothing assigned → 404, holder OK + idempotent', async () => {
    const other = await service.acknowledge(tenantA, e2User, L1).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(ForbiddenException);
    const owner = await service.acknowledge(tenantA, ownerA, L1).catch((e: unknown) => e);
    expect(owner).toBeInstanceOf(ForbiddenException);
    expect((owner as ForbiddenException).message).toBe('Only the person holding this asset can acknowledge it');
    const nobody = await service.acknowledge(tenantA, e1User, P1).catch((e: unknown) => e);
    expect(nobody).toBeInstanceOf(NotFoundException);
    const unknown = await service.acknowledge(tenantA, e1User, crypto.randomUUID()).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(NotFoundException);
    expect(auditActions()).toEqual([]);

    const first = await service.acknowledge(tenantA, e1User, L1);
    expect(first.data.asset_id).toBe(L1);
    expect(first.data.acknowledged_at).toBeTruthy();
    const second = await service.acknowledge(tenantA, e1User, L1);
    expect(second.data.acknowledged_at).toBe(first.data.acknowledged_at);
    expect(auditActions()).toEqual(['asset.acknowledged']);
    const ack = auditLog.mock.calls[0]![0] as { actorUserId: string; actorEmployeeId: string };
    expect(ack.actorUserId).toBe(e1User);
    expect(ack.actorEmployeeId).toBe(E1);
    expect((await service.summary(tenantA, hrA)).data.awaiting_acknowledgement).toBe(1); // S1 still unacknowledged
  });

  it('/assets/me: the holder sees their open assignments; a seat without an employee record and a non-holder get []', async () => {
    // Give the laptop a price so the "never reaches the holder" check below is real.
    await dbAdmin.update(assets).set({ purchase_value: '149999.00', purchase_date: '2026-09-01' }).where(eq(assets.id, L1));
    const mine = await service.myAssets(tenantA, e1User);
    await dbAdmin.update(assets).set({ purchase_value: null, purchase_date: null }).where(eq(assets.id, L1));
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0]!.asset).toMatchObject({ id: L1, asset_tag: 'AST-0001', name: 'MacBook Pro 14', status: 'assigned' });
    expect((mine.data[0]!.asset as unknown as { current_assignment?: unknown }).current_assignment).toBeUndefined();
    // Security audit 2026-10-06: what the company paid never reaches the holder.
    expect(mine.data[0]!.asset.purchase_value).toBeNull();
    expect(mine.data[0]!.asset.purchase_date).toBeNull();
    expect(mine.data[0]!.assignment).toMatchObject({ assigned_by_name: 'Harry HR', issue_condition: 'new', notes: 'with charger' });
    expect(mine.data[0]!.assignment.acknowledged_at).toBeTruthy();
    expect((await service.myAssets(tenantA, ownerA)).data).toEqual([]);
    expect((await service.myAssets(tenantA, e2User)).data).toEqual([]);
    expect((await service.myAssets(tenantB, eBUser)).data).toEqual([]);
  });

  it('employees-module facade helpers count what the person holds / ever held', async () => {
    await new DatabaseService().withTenant(tenantA, async (tx) => {
      expect(await countOpenAssignmentsTx(tx, tenantA, E1)).toBe(1);
      expect(await countAllAssignmentsTx(tx, tenantA, E1)).toBe(1);
      expect(await listOpenAssignmentsTx(tx, tenantA, E1)).toMatchObject([{ asset_id: L1, asset_tag: 'AST-0001', name: 'MacBook Pro 14' }]);
      expect(await countOpenAssignmentsTx(tx, tenantA, E2)).toBe(0);
    });
  });

  it('return: closes the assignment (history row), moves status/condition, 409 when nobody holds it', async () => {
    const { data } = await service.returnAsset(tenantA, hrA, L1, {
      return_condition: 'fair',
      return_notes: 'scratched lid',
      next_status: 'under_repair',
    });
    expect(data.status).toBe('under_repair');
    expect(data.condition).toBe('fair');
    expect(data.current_assignment).toBeNull();
    expect(data.history).toHaveLength(1);
    expect(data.history[0]).toMatchObject({
      employee_id: E1,
      employee_name: 'Eve Employee',
      assigned_by_name: 'Harry HR',
      returned_by_name: 'Harry HR',
      return_condition: 'fair',
      return_notes: 'scratched lid',
    });
    expect(data.history[0]!.returned_at).toBeTruthy();
    expect(data.history[0]!.acknowledged_at).toBeTruthy();
    expect(auditActions()).toEqual(['asset.returned']);

    const again = await service.returnAsset(tenantA, hrA, L1, { return_condition: 'good' }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ConflictException);
    expect(codeOf(again)).toBe('ASSET_NOT_ASSIGNED');

    // default next_status is in_stock
    await service.assign(tenantA, hrA, P1, { employee_id: E1 });
    const back = await service.returnAsset(tenantA, hrA, P1, { return_condition: 'good' });
    expect(back.data.status).toBe('in_stock');
    expect((await service.myAssets(tenantA, e1User)).data).toEqual([]);
    await new DatabaseService().withTenant(tenantA, async (tx) => {
      expect(await countOpenAssignmentsTx(tx, tenantA, E1)).toBe(0);
      expect(await countAllAssignmentsTx(tx, tenantA, E1)).toBe(2);
    });
  });

  it('detail history is newest first with the open one on top; by-employee splits current vs returned; 404 for a foreign employee', async () => {
    // L1 is under repair after its return — put it back in stock, then hand it to E2
    await service.update(tenantA, hrA, L1, { status: 'in_stock' });
    await service.assign(tenantA, hrA, L1, { employee_id: E2, issue_condition: 'fair' });
    const { data: detail } = await service.get(tenantA, L1, hrA);
    expect(detail.history).toHaveLength(2);
    expect(detail.history[0]!.employee_id).toBe(E2);
    expect(detail.history[0]!.returned_at).toBeNull();
    expect(detail.history[1]!.employee_id).toBe(E1);
    expect(detail.history[1]!.returned_at).toBeTruthy();
    expect(detail.current_assignment!.id).toBe(detail.history[0]!.id);

    const e1 = await service.byEmployee(tenantA, E1, hrA);
    expect(e1.data.current).toEqual([]);
    expect(e1.data.history.map((h) => h.asset_id)).toEqual([P1, L1]); // newest return first
    expect(e1.data.history[1]).toMatchObject({ asset_tag: 'AST-0001', asset_name: 'MacBook Pro 14', category: 'laptop', return_condition: 'fair' });

    const e2 = await service.byEmployee(tenantA, E2, hrA);
    expect(e2.data.current.map((a) => a.id)).toEqual([L1]);
    expect(e2.data.current[0]!.current_assignment!.employee_id).toBe(E2);
    expect(e2.data.history).toEqual([]);

    const foreign = await service.byEmployee(tenantA, EB, hrA).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);
  });

  it('delete is blocked while somebody holds the asset, allowed after the return; the row disappears from every read', async () => {
    const blocked = await service.remove(tenantA, hrA, L1).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(ConflictException);
    expect((blocked as HttpException).getResponse()).toMatchObject({ code: 'ASSET_ASSIGNED', message: 'Return the asset first' });
    expect((await assetRow(L1))!.deleted_at).toBeNull();

    await service.returnAsset(tenantA, hrA, L1, { return_condition: 'good' });
    expect(await service.remove(tenantA, hrA, L1)).toEqual({ data: { deleted: true } });
    expect(auditActions()).toContain('asset.deleted');
    expect((await assetRow(L1))!.deleted_at).toBeTruthy();
    const gone = await service.get(tenantA, L1, hrA).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(NotFoundException);
    const twice = await service.remove(tenantA, hrA, L1).catch((e: unknown) => e);
    expect(twice).toBeInstanceOf(NotFoundException);
    expect((await service.list(tenantA, {}, hrA)).data.map((a) => a.id)).not.toContain(L1);
    expect((await service.summary(tenantA, hrA)).data.total).toBe(3);
    // the person's history keeps the deleted asset's rows (their "ever held" record)
    const e1 = await service.byEmployee(tenantA, E1, hrA);
    expect(e1.data.history.map((h) => h.asset_id)).toContain(L1);
    // the tag is free again
    const { data: reuse } = await service.create(tenantA, hrA, { asset_tag: 'AST-0001', name: 'Replacement', category: 'laptop' });
    expect(reuse.asset_tag).toBe('AST-0001');
    expect((await service.nextTag(tenantA, hrA)).data.asset_tag).toBe('AST-0005');
  });
});

// ─── Seat liveness on the self-service routes ───────────────────────────────

describe('self-service needs a LIVE seat', () => {
  const seatOf = (userId: string) => and(eq(memberships.tenant_id, tenantA), eq(memberships.user_id, userId));

  it('a deactivated or expired membership sees [] on /me and gets 403 on acknowledge, even though the token is still valid', async () => {
    const { data: k } = await service.create(tenantA, hrA, { name: 'Keyboard', category: 'peripheral' });
    await service.assign(tenantA, hrA, k.id, { employee_id: E2 });
    expect((await service.myAssets(tenantA, e2User)).data.map((m) => m.asset.id)).toEqual([k.id]);

    try {
      await dbAdmin.update(memberships).set({ status: 'deactivated' }).where(seatOf(e2User));
      expect((await service.myAssets(tenantA, e2User)).data).toEqual([]);
      const off = await service.acknowledge(tenantA, e2User, k.id).catch((e: unknown) => e);
      expect(off).toBeInstanceOf(ForbiddenException);

      await dbAdmin
        .update(memberships)
        .set({ status: 'active', access_expires_at: new Date(Date.now() - 60_000) })
        .where(seatOf(e2User));
      expect((await service.myAssets(tenantA, e2User)).data).toEqual([]);
      const expired = await service.acknowledge(tenantA, e2User, k.id).catch((e: unknown) => e);
      expect(expired).toBeInstanceOf(ForbiddenException);
      expect((await assignmentRows(k.id))[0]!.acknowledged_at).toBeNull();

      await dbAdmin
        .update(memberships)
        .set({ status: 'active', access_expires_at: new Date(Date.now() + 60 * 60_000) })
        .where(seatOf(e2User));
      expect((await service.myAssets(tenantA, e2User)).data).toHaveLength(1);
      expect((await service.acknowledge(tenantA, e2User, k.id)).data.acknowledged_at).toBeTruthy();
    } finally {
      await dbAdmin.update(memberships).set({ status: 'active', access_expires_at: null }).where(seatOf(e2User));
    }
    await service.returnAsset(tenantA, hrA, k.id, { return_condition: 'good' });
  });
});

// ─── Photo pipeline ─────────────────────────────────────────────────────────

describe('photo', () => {
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  it('processes under tenants/<t>/assets/<id>/photo, signs both variants, deletes the previous object on replace, remove clears', async () => {
    const res = await service.uploadPhoto(tenantA, hrA, P1, JPG);
    expect(processImage).toHaveBeenCalledTimes(1);
    expect(processImage.mock.calls[0]![0]).toBe(JPG);
    expect(processImage.mock.calls[0]![1]).toBe(`tenants/${tenantA}/assets/${P1}/photo`);
    const key1 = (await assetRow(P1))!.photo_key!;
    expect(key1).toMatch(new RegExp(`^tenants/${tenantA}/assets/${P1}/photo/[0-9a-f-]{36}_256\\.webp$`));
    expect(res.data.photo_url).toBe(`https://signed.test/${key1}`);
    expect(res.data.photo_thumb_url).toBe(`https://signed.test/${key1.replace('_256.webp', '_64.webp')}`);
    expect(deleteImage).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(['asset.photo_updated']);

    await service.uploadPhoto(tenantA, hrA, P1, JPG);
    const key2 = (await assetRow(P1))!.photo_key!;
    expect(key2).not.toBe(key1);
    expect(deleteImage).toHaveBeenCalledTimes(1);
    expect(deleteImage).toHaveBeenCalledWith(key1);

    const cleared = await service.removePhoto(tenantA, hrA, P1);
    expect(cleared.data.photo_url).toBeNull();
    expect(cleared.data.photo_thumb_url).toBeNull();
    expect((await assetRow(P1))!.photo_key).toBeNull();
    expect(deleteImage).toHaveBeenCalledWith(key2);
    expect(auditActions()).toContain('asset.photo_removed');
    // removing again is a no-op (no second delete / audit)
    deleteImage.mockClear();
    auditLog.mockClear();
    await service.removePhoto(tenantA, hrA, P1);
    expect(deleteImage).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    // the list carries the photo too
    await service.uploadPhoto(tenantA, hrA, P1, JPG);
    const { data } = await service.list(tenantA, { category: 'phone' }, hrA);
    expect(data[0]!.photo_url).toMatch(/^https:\/\/signed\.test\//);
  });

  it('with R2Service injected the photo is signed straight through it for 15 minutes (both variants); unconfigured storage → null', async () => {
    const signedGetUrl = jest.fn(async (key: string, ttl?: number) => `https://r2.test/${key}?ttl=${ttl}`);
    const configured = { isConfigured: () => true, signedGetUrl } as unknown as R2Service;
    const withR2 = new AssetsService(new DatabaseService(), media, notifications, audit, config, configured);
    const key = (await assetRow(P1))!.photo_key!;
    const { data } = await withR2.get(tenantA, P1, hrA);
    expect(data.photo_url).toBe(`https://r2.test/${key}?ttl=900`);
    expect(data.photo_thumb_url).toBe(`https://r2.test/${key.replace('_256.webp', '_64.webp')}?ttl=900`);
    expect(signedGetUrl).toHaveBeenCalledTimes(2);
    expect(signedGetUrl.mock.calls.every((c) => c[1] === 900)).toBe(true);
    expect(servedUrl).not.toHaveBeenCalled(); // the photo never goes through the 24 h avatar signer

    const unconfigured = { isConfigured: () => false, signedGetUrl } as unknown as R2Service;
    const noR2 = new AssetsService(new DatabaseService(), media, notifications, audit, config, unconfigured);
    const off = await noR2.get(tenantA, P1, hrA);
    expect(off.data.photo_url).toBeNull();
    expect(off.data.photo_thumb_url).toBeNull();
    expect(signedGetUrl).toHaveBeenCalledTimes(2);
  });

  it('soft delete clears the key and deletes the photo objects after commit (no orphaned storage)', async () => {
    const { data: cam } = await service.create(tenantA, hrA, { name: 'Webcam', category: 'peripheral' });
    await service.uploadPhoto(tenantA, hrA, cam.id, JPG);
    const key = (await assetRow(cam.id))!.photo_key!;
    deleteImage.mockClear();
    expect(await service.remove(tenantA, hrA, cam.id)).toEqual({ data: { deleted: true } });
    expect(deleteImage).toHaveBeenCalledTimes(1);
    expect(deleteImage).toHaveBeenCalledWith(key);
    const row = (await assetRow(cam.id))!;
    expect(row.deleted_at).toBeTruthy();
    expect(row.photo_key).toBeNull();
    expect(auditActions()).toContain('asset.deleted');
    // a storage hiccup never fails the delete
    const { data: mic } = await service.create(tenantA, hrA, { name: 'Mic', category: 'peripheral' });
    await service.uploadPhoto(tenantA, hrA, mic.id, JPG);
    deleteImage.mockImplementationOnce(async () => {
      throw new Error('R2 down');
    });
    expect(await service.remove(tenantA, hrA, mic.id)).toEqual({ data: { deleted: true } });
    expect((await assetRow(mic.id))!.deleted_at).toBeTruthy();
  });

  it('never reaches the media pipeline for another tenant’s asset or an empty upload', async () => {
    const foreign = await service.uploadPhoto(tenantB, ownerB, P1, JPG).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);
    const empty = await service.uploadPhoto(tenantA, hrA, P1, Buffer.alloc(0)).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(BadRequestException);
    expect(processImage).not.toHaveBeenCalled();
  });
});

// ─── CSV ────────────────────────────────────────────────────────────────────

describe('CSV export', () => {
  it('UTF-8 BOM + the fixed header, holder columns, and a leading = + - @ neutralised', async () => {
    await service.create(tenantA, hrA, { name: '=cmd|calc', category: 'other', notes: '-1+1' });
    const csv = await service.exportCsv(tenantA, hrA);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\n');
    expect(lines[0]).toBe(
      'asset_tag,name,category,brand,model,serial_number,status,condition,holder_name,holder_code,assigned_at,acknowledged_at,purchase_date,purchase_value,currency,notes',
    );
    expect(lines.length).toBe(1 + (await service.list(tenantA, {}, hrA)).total);
    const evil = lines.find((l) => l.includes("'=cmd|calc"))!;
    expect(evil).toBeTruthy();
    expect(evil.endsWith(",'-1+1")).toBe(true);
    const sim = lines.find((l) => l.startsWith('AST-0003,'))!;
    expect(sim).toContain(',assigned,good,Nina NoSeat,');
    expect(sim).toContain('2026-02-01T09:30:00.000Z');
    expect(csvCell('hello, "world"')).toBe('"hello, ""world"""');
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell(null)).toBe('');
  });
});

// ─── Tenant isolation ───────────────────────────────────────────────────────

describe('cross-tenant', () => {
  it('another tenant cannot read, edit, assign, return, photo or delete the asset — 404 everywhere; the list and summary stay empty', async () => {
    const not = async (p: Promise<unknown>) => {
      const e = await p.catch((err: unknown) => err);
      expect(e).toBeInstanceOf(NotFoundException);
    };
    await not(service.get(tenantB, P1, ownerB));
    await not(service.update(tenantB, ownerB, P1, { name: 'stolen' }));
    await not(service.assign(tenantB, ownerB, P1, { employee_id: EB }));
    await not(service.returnAsset(tenantB, ownerB, P1, { return_condition: 'good' }));
    await not(service.removePhoto(tenantB, ownerB, P1));
    await not(service.remove(tenantB, ownerB, P1));
    await not(service.acknowledge(tenantB, eBUser, P1));
    expect((await service.list(tenantB, {}, ownerB)).total).toBe(0);
    expect((await service.summary(tenantB, ownerB)).data.total).toBe(0);
    expect((await service.nextTag(tenantB, ownerB)).data.asset_tag).toBe('AST-0001');
    expect((await assetRow(P1))!.name).toBe('iPhone 13');
    expect(await assignmentRows(P1)).toHaveLength(1);
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
  const run = <T>(metatype: new () => T, value: unknown, type: 'body' | 'query' = 'body') =>
    pipe.transform(value, { type, metatype }).then(
      (v) => v as T,
      (e: unknown) => e,
    );

  it('CreateAssetDto: valid bodies pass (blank tag → undefined, number → 2 dp); bad category, negative value, 40-char tag, bad tag chars, extra keys refused', async () => {
    const ok = (await run(CreateAssetDto, { name: 'Laptop', category: 'laptop', asset_tag: '  ', purchase_value: 100, currency: 'inr' })) as CreateAssetDto;
    expect(ok).toBeInstanceOf(CreateAssetDto);
    expect(ok.asset_tag).toBeUndefined();
    expect(ok.purchase_value).toBe('100.00');
    expect(ok.currency).toBe('INR');
    const ok2 = (await run(CreateAssetDto, { name: 'SIM', category: 'sim', asset_tag: 'SIM/2026-01', purchase_value: '54999.5', brand: '' })) as CreateAssetDto;
    expect(ok2.asset_tag).toBe('SIM/2026-01');
    expect(ok2.brand).toBeNull();
    expect(await run(CreateAssetDto, { name: 'x', category: 'drone' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', purchase_value: -5 })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', purchase_value: '-5.00' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', purchase_value: 'abc' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', purchase_value: '1.234' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', asset_tag: 'T'.repeat(40) })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', asset_tag: 'AB C' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: '', category: 'laptop' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x'.repeat(121), category: 'laptop' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { category: 'laptop' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', purchase_date: '15/03/2026' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', currency: 'rupees' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', condition: 'mint' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', status: 'assigned' })).toBeInstanceOf(BadRequestException);
    expect(await run(CreateAssetDto, { name: 'x', category: 'laptop', photo_key: 'evil' })).toBeInstanceOf(BadRequestException);
  });

  it('UpdateAssetDto / AssignAssetDto / ReturnAssetDto / ListAssetsQueryDto', async () => {
    expect(await run(UpdateAssetDto, { status: 'retired', condition: 'poor' })).toBeInstanceOf(UpdateAssetDto);
    expect(await run(UpdateAssetDto, { status: 'assigned' })).toBeInstanceOf(BadRequestException);
    expect(await run(UpdateAssetDto, { deleted_at: null })).toBeInstanceOf(BadRequestException);
    // null on a NOT NULL field reads as "not provided" (IsOptional alone would let it through to a 500)
    const nulls = (await run(UpdateAssetDto, {
      asset_tag: null,
      name: null,
      category: null,
      currency: null,
      condition: null,
      status: null,
      brand: null,
    })) as UpdateAssetDto;
    expect(nulls).toBeInstanceOf(UpdateAssetDto);
    for (const k of ['asset_tag', 'name', 'category', 'currency', 'condition', 'status'] as const) {
      expect(nulls[k]).toBeUndefined();
    }
    expect(nulls.brand).toBeNull(); // nullable columns still clear on null
    // and the service tolerates a stray null anyway (belt and braces)
    const kept = await service.update(tenantA, hrA, P1, { name: null, currency: null, status: null } as unknown as UpdateAssetDto);
    expect(kept.data.name).toBe('iPhone 13');
    expect(kept.data.currency).toBe('INR');

    expect(await run(AssignAssetDto, { employee_id: crypto.randomUUID(), assigned_at: '2026-02-01T09:30:00.000Z', issue_condition: 'good' })).toBeInstanceOf(AssignAssetDto);
    expect(await run(AssignAssetDto, { employee_id: 'nope' })).toBeInstanceOf(BadRequestException);
    expect(await run(AssignAssetDto, {})).toBeInstanceOf(BadRequestException);
    expect(await run(AssignAssetDto, { employee_id: crypto.randomUUID(), assigned_at: 'yesterday' })).toBeInstanceOf(BadRequestException);
    expect(await run(AssignAssetDto, { employee_id: crypto.randomUUID(), issue_condition: 'ok' })).toBeInstanceOf(BadRequestException);

    expect(await run(ReturnAssetDto, { return_condition: 'fair', next_status: 'under_repair' })).toBeInstanceOf(ReturnAssetDto);
    expect(await run(ReturnAssetDto, {})).toBeInstanceOf(BadRequestException);
    expect(await run(ReturnAssetDto, { return_condition: 'fair', next_status: 'assigned' })).toBeInstanceOf(BadRequestException);

    const q = (await run(ListAssetsQueryDto, { limit: '50', offset: '10', status: '', q: 'mac' }, 'query')) as ListAssetsQueryDto;
    expect(q).toBeInstanceOf(ListAssetsQueryDto);
    expect(q.limit).toBe(50);
    expect(q.offset).toBe(10);
    expect(q.status).toBeUndefined();
    expect(await run(ListAssetsQueryDto, { limit: '500' }, 'query')).toBeInstanceOf(BadRequestException);
    expect(await run(ListAssetsQueryDto, { status: 'broken' }, 'query')).toBeInstanceOf(BadRequestException);
    expect(await run(ListAssetsQueryDto, { employee_id: 'x' }, 'query')).toBeInstanceOf(BadRequestException);
  });
});

// ─── Controller: role placement + route order ───────────────────────────────

describe('AssetsController', () => {
  it('management routes carry @Roles(admin); me and acknowledge are open to any member', () => {
    const roles = (name: string) =>
      Reflect.getMetadata(ROLES_KEY, AssetsController.prototype[name as keyof AssetsController] as object) as UserRole[] | undefined;
    for (const m of ['list', 'summary', 'nextTag', 'exportCsv', 'byEmployee', 'create', 'get', 'update', 'uploadPhoto', 'removePhoto', 'assign', 'returnAsset', 'remove']) {
      expect(roles(m)).toEqual(['admin']);
    }
    expect(roles('me')).toBeUndefined();
    expect(roles('acknowledge')).toBeUndefined();
  });

  describe('routing through a real Nest app', () => {
    let app: INestApplication;
    let base: string;
    const USER = crypto.randomUUID();
    const TENANT = crypto.randomUUID();
    const svc = {
      list: jest.fn(async (...a: unknown[]) => ({ data: [], total: 0, called: 'list', a })),
      summary: jest.fn(async (...a: unknown[]) => ({ data: { called: 'summary', a } })),
      nextTag: jest.fn(async (...a: unknown[]) => ({ data: { asset_tag: 'AST-0001', a } })),
      exportCsv: jest.fn(async () => '﻿asset_tag,name\n'),
      myAssets: jest.fn(async (...a: unknown[]) => ({ data: [{ called: 'me', a }] })),
      byEmployee: jest.fn(async (...a: unknown[]) => ({ data: { called: 'byEmployee', a } })),
      create: jest.fn(async (...a: unknown[]) => ({ data: { called: 'create', a } })),
      get: jest.fn(async (...a: unknown[]) => ({ data: { called: 'get', a } })),
      update: jest.fn(async (...a: unknown[]) => ({ data: { called: 'update', a } })),
      uploadPhoto: jest.fn(async (...a: unknown[]) => ({ data: { called: 'uploadPhoto', a: a.slice(0, 3) } })),
      removePhoto: jest.fn(async (...a: unknown[]) => ({ data: { called: 'removePhoto', a } })),
      assign: jest.fn(async (...a: unknown[]) => ({ data: { called: 'assign', a } })),
      returnAsset: jest.fn(async (...a: unknown[]) => ({ data: { called: 'returnAsset', a } })),
      acknowledge: jest.fn(async (...a: unknown[]) => ({ data: { called: 'acknowledge', a } })),
      remove: jest.fn(async (...a: unknown[]) => ({ data: { called: 'remove', a } })),
    };

    beforeAll(async () => {
      const mod = await Test.createTestingModule({
        controllers: [AssetsController],
        providers: [{ provide: AssetsService, useValue: svc }],
      }).compile();
      app = mod.createNestApplication();
      app.use((req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
        req.user = { sub: USER, tenantId: TENANT, membershipId: crypto.randomUUID(), role: 'admin', email: 'hr@t.test', isPlatformAdmin: false };
        next();
      });
      app.useGlobalPipes(
        new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } }),
      );
      app.setGlobalPrefix('api/v1');
      await app.listen(0);
      const addr = app.getHttpServer().address() as { port: number };
      base = `http://127.0.0.1:${addr.port}/api/v1/assets`;
    });

    afterAll(async () => {
      await app.close();
    });

    const json = async (res: globalThis.Response) => (await res.json()) as { data?: Record<string, unknown>; message?: unknown; statusCode?: number };

    it('static paths resolve to their handlers, never to GET :id', async () => {
      const summary = await fetch(`${base}/summary`);
      expect(summary.status).toBe(200);
      expect((await json(summary)).data).toMatchObject({ called: 'summary', a: [TENANT, USER] });
      const nextTag = await fetch(`${base}/next-tag`);
      expect((await json(nextTag)).data).toMatchObject({ asset_tag: 'AST-0001' });
      const me = await fetch(`${base}/me`);
      expect(me.status).toBe(200);
      expect(((await json(me)).data as unknown as Array<{ called: string }>)[0]!.called).toBe('me');
      const emp = crypto.randomUUID();
      const by = await fetch(`${base}/by-employee/${emp}`);
      expect((await json(by)).data).toMatchObject({ called: 'byEmployee', a: [TENANT, emp, USER] });
      const list = await fetch(`${base}?status=in_stock&limit=20&q=mac`);
      expect(list.status).toBe(200);
      expect(svc.list).toHaveBeenCalledWith(TENANT, expect.objectContaining({ status: 'in_stock', limit: 20, q: 'mac' }), USER);
      expect(svc.get).not.toHaveBeenCalled();
    });

    it('export.csv streams text/csv with the attachment filename and the BOM body', async () => {
      const res = await fetch(`${base}/export.csv`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/csv; charset=utf-8/);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="assets-\d{4}-\d{2}-\d{2}\.csv"$/);
      // fetch's text() strips a leading BOM per the WHATWG spec — check the raw bytes.
      const bytes = Buffer.from(await res.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes.subarray(3).toString('utf8')).toBe('asset_tag,name\n');
      expect(svc.exportCsv).toHaveBeenCalledWith(TENANT, USER);
    });

    it(':id routes take a uuid (400 otherwise), action POSTs answer 200, create answers 201, bad bodies are 400', async () => {
      const id = crypto.randomUUID();
      const get = await fetch(`${base}/${id}`);
      expect(get.status).toBe(200);
      expect((await json(get)).data).toMatchObject({ called: 'get', a: [TENANT, id, USER] });
      expect((await fetch(`${base}/not-a-uuid`)).status).toBe(400);

      const created = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Laptop', category: 'laptop' }) });
      expect(created.status).toBe(201);
      const bad = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Laptop', category: 'drone' }) });
      expect(bad.status).toBe(400);

      const ack = await fetch(`${base}/${id}/acknowledge`, { method: 'POST' });
      expect(ack.status).toBe(200);
      expect((await json(ack)).data).toMatchObject({ called: 'acknowledge', a: [TENANT, USER, id] });
      const assign = await fetch(`${base}/${id}/assign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employee_id: 'x' }) });
      expect(assign.status).toBe(400);
      const ret = await fetch(`${base}/${id}/return`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ return_condition: 'good' }) });
      expect(ret.status).toBe(200);
      const del = await fetch(`${base}/${id}/delete`, { method: 'POST' });
      expect(del.status).toBe(200);
      expect((await json(del)).data).toMatchObject({ called: 'remove' });
      const patch = await fetch(`${base}/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'assigned' }) });
      expect(patch.status).toBe(400);
      const noFile = await fetch(`${base}/${id}/photo`, { method: 'POST' });
      expect(noFile.status).toBe(400);
      expect(svc.uploadPhoto).not.toHaveBeenCalled();
      const form = new FormData();
      form.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'p.jpg');
      const withFile = await fetch(`${base}/${id}/photo`, { method: 'POST', body: form });
      expect(withFile.status).toBe(200);
      expect(svc.uploadPhoto).toHaveBeenCalledTimes(1);
      expect(svc.uploadPhoto.mock.calls[0]!.slice(0, 3)).toEqual([TENANT, USER, id]);
      expect(Buffer.isBuffer(svc.uploadPhoto.mock.calls[0]![3])).toBe(true);
      const removed = await fetch(`${base}/${id}/photo/remove`, { method: 'POST' });
      expect(removed.status).toBe(200);
      expect((await json(removed)).data).toMatchObject({ called: 'removePhoto', a: [TENANT, USER, id] });
    });
  });
});
