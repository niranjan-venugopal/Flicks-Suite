import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { employees, memberships, shiftTemplates, tenants, users } from '@flicks/db/schema';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { AttendanceController } from '../modules/attendance/attendance.controller';
import { PresenceService } from '../modules/presence/presence.service';

/**
 * Attendance self-heal (beta blocker): members without an HR employee record
 * (CRM-first workspaces, invited members) and tenants without shift templates
 * could never clock in — the status never updated. Punch-in must now mint the
 * missing employee bridge + default shift, or link an HR-created employee row
 * by work email.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const notificationsStub = { sendEmail: async () => true, notify: async () => undefined } as never;
const service = new AttendanceService(dbSvc, dbAdmin as never, audit, notificationsStub);

let tenantId: string;
let bareUser: string; // membership WITHOUT employee_id
let linkUser: string; // membership without bridge, but HR employee row exists by email

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `Heal${rid()}`, slug: `heal-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const mkMember = async (email: string) => {
    const [u] = await dbAdmin.insert(users).values({ email, full_name: 'Sam Heal Carter', status: 'active' }).returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role: 'owner', status: 'active' });
    return u!.id;
  };
  bareUser = await mkMember(`bare-${rid()}@heal.test`);
  const linkEmail = `linked-${rid()}@heal.test`;
  linkUser = await mkMember(linkEmail);
  // HR created this employee separately; the membership was never bridged.
  await dbAdmin.insert(employees).values({
    tenant_id: tenantId,
    employee_code: `EMP-${rid().toUpperCase()}`,
    first_name: 'Linked',
    last_name: 'Person',
    work_email: linkEmail,
    date_of_joining: '2026-01-01',
  });
  // NOTE: deliberately NO shift template for this tenant.
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  const emails = [bareUser, linkUser];
  for (const id of emails) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Clock-in self-heal', () => {
  it('mints employee + default shift on first punch for a bare member, and the status updates', async () => {
    // Was: NotFoundException('No employee record found for the current user').
    const punch = await service.punchIn(bareUser, tenantId, {});
    expect(punch.type).toBe('in');

    // Bridge exists now, employee minted from the user profile.
    const [m] = await dbAdmin
      .select({ employee_id: memberships.employee_id })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, bareUser)));
    expect(m!.employee_id).not.toBeNull();
    const [emp] = await dbAdmin.select().from(employees).where(eq(employees.id, m!.employee_id!));
    expect(emp!.first_name).toBe('Sam');
    expect(emp!.last_name).toBe('Heal Carter');

    // Default shift was seeded for the tenant.
    const shifts = await dbAdmin
      .select()
      .from(shiftTemplates)
      .where(and(eq(shiftTemplates.tenant_id, tenantId), eq(shiftTemplates.is_default, true)));
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.name).toBe('General');

    // THE symptom: /me/today must now reflect the punch (status updated).
    const today = await service.getMyToday(bareUser, tenantId);
    expect(today.firstPunchInAt).not.toBeNull();
    expect(['present', 'late']).toContain(today.attendanceStatus);
  });

  it('links an HR-created employee row by work email instead of duplicating it', async () => {
    await service.punchIn(linkUser, tenantId, {});
    const [m] = await dbAdmin
      .select({ employee_id: memberships.employee_id })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, linkUser)));
    const [emp] = await dbAdmin.select().from(employees).where(eq(employees.id, m!.employee_id!));
    expect(emp!.first_name).toBe('Linked'); // the HR row, not a fresh mint
    // Exactly one employee for that email — no duplicate.
    const all = await dbAdmin.select().from(employees).where(and(eq(employees.tenant_id, tenantId), eq(employees.work_email, emp!.work_email)));
    expect(all).toHaveLength(1);
  });
});

describe('Punch overrides a stale manual Set-status (PRD v4 §5)', () => {
  it('clock-in through the controller clears "Appear offline" → profile flips to the green in-office state', async () => {
    const presence = new PresenceService(dbAdmin as never, dbSvc);
    const controller = new AttendanceController(service, presence, new EventEmitter2());
    // A fresh member who pinned a manual status from the profile picker…
    const [u] = await dbAdmin.insert(users).values({ email: `status-${rid()}@heal.test`, full_name: 'Stat Us', status: 'active' }).returning();
    const [mem] = await dbAdmin
      .insert(memberships)
      .values({ tenant_id: tenantId, user_id: u!.id, role: 'employee', status: 'active' })
      .returning();
    await presence.setStatus(tenantId, u!.id, { status: 'offline' });
    let [resolved] = await presence.resolve(tenantId, [u!.id], new Map());
    expect(resolved!.status).toBe('offline');
    expect(resolved!.manual).toBe(true);

    // …then clocks in through the REAL endpoint handler. The punch is the
    // newer, explicit availability signal — it must clear the manual pin.
    // Round C: clearStatus is detached from the response (the PRD promises
    // ≤5s propagation, not same-response), so poll briefly.
    const jwtUser = { sub: u!.id, tenantId, membershipId: mem!.id, role: 'employee' } as never;
    await controller.punchIn({}, jwtUser, { ip: '127.0.0.1', headers: {} } as never);
    const start = Date.now();
    do {
      ;[resolved] = await presence.resolve(tenantId, [u!.id], new Map());
      if (resolved!.manual === false) break;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() - start < 5_000);
    expect(resolved!.manual).toBe(false);
    expect(resolved!.status).toBe('in_office'); // open punch → green, org-wide
    await dbAdmin.delete(users).where(eq(users.id, u!.id));
  });
});
