import 'dotenv/config';
import * as crypto from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  attendancePunches,
  attendanceRecords,
  attendanceRegularizations,
  auditLog,
  employees,
  leaveTypes,
  locations,
  memberships,
  tenants,
  users,
} from '@flicks/db/schema';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { AttendanceService } from '../modules/attendance/attendance.service';
import { LeaveService } from '../modules/leave/leave.service';
import { SettingsService } from '../modules/settings/settings.service';
import { TimesheetService } from '../modules/timesheet/timesheet.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import type { MediaService } from '../modules/media/media.service';

/**
 * Founder round 13 — geofence v1 (Haversine on punch + work_mode), team
 * attendance scoping for owner/admin/finance, gender-scoped leave types,
 * milestone-at-create + the cross-project milestone 400 regression, editable
 * slug with reserved/uniqueness rules, and the General-tab preferences
 * (timezone / fiscal year / week-starts-on driving timesheet weeks).
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const notificationsStub = {
  sendEmail: async () => true,
  notify: async () => undefined,
  createInAppNotification: jest.fn(async () => undefined),
} as never;

const attendance = new AttendanceService(dbSvc, dbAdmin as never, audit, notificationsStub);
const leave = new LeaveService(dbSvc, audit, notificationsStub);
const settings = new SettingsService(
  db as never,
  dbAdmin as never,
  audit,
  { servedUrl: async () => null } as unknown as MediaService,
  {} as unknown as DomainEventsService,
);
const timesheet = new TimesheetService(dbAdmin as never, dbSvc, audit, notificationsStub);
const visibility = new PmVisibilityService(dbSvc);
const pmNotifications = new NotificationsService(
  db as never,
  dbAdmin as never,
  new ConfigService(),
  emitter,
);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, pmNotifications, visibility);

// Geofence centre: Bengaluru HQ. Inside = the centre itself; outside = ~14km north.
const FENCE = { lat: 12.9716, lng: 77.5946, radiusM: 150 };
const INSIDE = { lat: 12.9718, lng: 77.5948, accuracy: 8 };
const OUTSIDE = { lat: 13.0987, lng: 77.5946, accuracy: 12 };

let tenantId: string;
let otherTenantId: string;
let locationId: string;
const userIds: string[] = [];

interface Person {
  userId: string;
  employeeId: string;
}
let owner: Person; // male, org owner
let priya: Person; // female employee (manager's direct report)
let manager: Person; // the reporting manager
let noGender: Person; // employee without a gender on file

let maternityTypeId: string;
let paternityTypeId: string;
let casualTypeId: string;

async function mkPerson(opts: {
  role: 'owner' | 'manager' | 'employee' | 'finance';
  gender?: 'male' | 'female' | null;
  reportingManagerId?: string | null;
}): Promise<Person> {
  const email = `r13-${opts.role}-${rid()}@t.test`;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: `R13 ${opts.role} ${rid()}`, status: 'active' })
    .returning();
  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tenantId,
      employee_code: `E13-${rid().toUpperCase()}`,
      first_name: 'R13',
      last_name: opts.role,
      work_email: email,
      date_of_joining: '2026-01-01',
      gender: opts.gender ?? null,
      location_id: locationId,
      reporting_manager_id: opts.reportingManagerId ?? null,
      status: 'active',
    })
    .returning();
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: u!.id,
    employee_id: emp!.id,
    role: opts.role,
    status: 'active',
  });
  userIds.push(u!.id);
  return { userId: u!.id, employeeId: emp!.id };
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `R13 ${rid()}`, slug: `r13-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `R13B ${rid()}`, slug: `r13b-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  otherTenantId = t2!.id;

  const [loc] = await dbAdmin
    .insert(locations)
    .values({
      tenant_id: tenantId,
      name: 'Bengaluru HQ',
      city: 'Bengaluru',
      timezone: 'Asia/Kolkata',
      geofence_lat: String(FENCE.lat),
      geofence_lng: String(FENCE.lng),
      geofence_radius_m: FENCE.radiusM,
    })
    .returning();
  locationId = loc!.id;

  owner = await mkPerson({ role: 'owner', gender: 'male' });
  manager = await mkPerson({ role: 'manager', gender: 'male' });
  priya = await mkPerson({ role: 'employee', gender: 'female', reportingManagerId: manager.employeeId });
  noGender = await mkPerson({ role: 'employee', gender: null });

  const mkType = async (name: string, code: string, genders: string[] | null) => {
    const [row] = await dbAdmin
      .insert(leaveTypes)
      .values({
        tenant_id: tenantId,
        name,
        code,
        default_quota_days: 12,
        is_paid: true,
        is_active: true,
        applicable_genders: genders,
      })
      .returning();
    return row!.id;
  };
  casualTypeId = await mkType('Casual Leave', 'CL', null);
  maternityTypeId = await mkType('Maternity Leave', 'ML', ['female']);
  paternityTypeId = await mkType('Paternity Leave', 'PTL', ['male']);
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, otherTenantId));
  for (const id of userIds) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ─── 1. Geofence v1 ─────────────────────────────────────────────────────────

describe('Geofence v1 — Haversine on punch, work_mode on the day', () => {
  it('punch-in INSIDE the fence resolves office: is_within_geofence, location, user agent', async () => {
    const res = await attendance.punchIn(owner.userId, tenantId, INSIDE, '1.2.3.4', 'jest-agent');
    expect(res.isWithinGeofence).toBe(true);
    expect(res.workMode).toBe('office');
    expect(res.locationName).toBe('Bengaluru HQ');

    const [punch] = await dbAdmin
      .select()
      .from(attendancePunches)
      .where(eq(attendancePunches.id, res.id));
    expect(punch!.is_within_geofence).toBe(true);
    expect(punch!.location_id).toBe(locationId);
    expect(punch!.user_agent).toBe('jest-agent');
    expect(punch!.geo_lat).toBeCloseTo(INSIDE.lat, 3);

    const [rec] = await dbAdmin
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.id, res.attendanceRecordId));
    expect(rec!.work_mode).toBe('office');
  });

  it('punch-in OUTSIDE resolves remote (WFH), and punch-out never downgrades the day', async () => {
    const res = await attendance.punchIn(priya.userId, tenantId, OUTSIDE, '1.2.3.4', 'jest-agent');
    expect(res.isWithinGeofence).toBe(false);
    expect(res.workMode).toBe('remote');
    let [rec] = await dbAdmin
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.id, res.attendanceRecordId));
    expect(rec!.work_mode).toBe('remote');

    // Clocking out from INSIDE the office later must not rewrite the day —
    // work_mode is a punch-in fact.
    const out = await attendance.punchOut(priya.userId, tenantId, INSIDE, '1.2.3.4', 'jest-agent');
    const [outPunch] = await dbAdmin
      .select()
      .from(attendancePunches)
      .where(eq(attendancePunches.id, out.id));
    expect(outPunch!.is_within_geofence).toBe(true); // the punch row keeps its own truth
    ;[rec] = await dbAdmin
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.id, res.attendanceRecordId));
    expect(rec!.work_mode).toBe('remote'); // the day stays WFH
  });

  it('a punch WITHOUT coordinates degrades gracefully: NULL geofence state, punch still lands', async () => {
    const res = await attendance.punchIn(noGender.userId, tenantId, {});
    expect(res.isWithinGeofence).toBeNull();
    expect(res.workMode).toBeNull();
    const [rec] = await dbAdmin
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.id, res.attendanceRecordId));
    expect(rec!.work_mode).toBeNull();
  });

  it('getMyToday carries the assigned geofence (for the pre-check) and the clock-in position', async () => {
    const today = await attendance.getMyToday(owner.userId, tenantId);
    expect(today.location).toMatchObject({
      id: locationId,
      name: 'Bengaluru HQ',
      geofenceRadiusM: FENCE.radiusM,
    });
    expect(today.location!.geofenceLat).toBeCloseTo(FENCE.lat, 4);
    expect(today.workMode).toBe('office');
    expect(today.lastPunchGeo).not.toBeNull();
    expect(today.lastPunchGeo!.isWithinGeofence).toBe(true);
    expect(today.lastPunchGeo!.lat).toBeCloseTo(INSIDE.lat, 3);
  });

  it('approving a WFH regularization marks the day work_mode=remote (status stays present)', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const [reg] = await dbAdmin
      .insert(attendanceRegularizations)
      .values({
        tenant_id: tenantId,
        employee_id: priya.employeeId,
        attendance_date: yesterday,
        request_type: 'wfh_request',
        status: 'pending',
        reason: 'Working from home — internet installation at the flat.',
      })
      .returning();
    await attendance.reviewRegularization(reg!.id, manager.userId, tenantId, { action: 'approve' });
    const [rec] = await dbAdmin
      .select()
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.tenant_id, tenantId),
          eq(attendanceRecords.employee_id, priya.employeeId),
          eq(attendanceRecords.attendance_date, yesterday),
        ),
      );
    expect(rec!.attendance_status).toBe('present');
    expect(rec!.work_mode).toBe('remote');
  });
});

// ─── 2. Team attendance scoping ─────────────────────────────────────────────

describe('Team attendance — org-wide for owner/admin/finance, direct reports for managers', () => {
  it('owner sees the whole workspace with workMode + locationName on each row', async () => {
    const rows = await attendance.listTeamToday(owner.userId, tenantId, 'owner');
    expect(rows.length).toBeGreaterThanOrEqual(4); // everyone, not direct reports
    const p = rows.find((r) => r.employeeId === priya.employeeId)!;
    expect(p.workMode).toBe('remote');
    expect(p.locationName).toBe('Bengaluru HQ');
  });

  it('manager keeps direct-reports scoping', async () => {
    const rows = await attendance.listTeamToday(manager.userId, tenantId, 'manager');
    expect(rows.map((r) => r.employeeId)).toEqual([priya.employeeId]);
  });

  it('legacy 2-arg call (no role) still behaves as direct reports', async () => {
    const rows = await attendance.listTeamToday(manager.userId, tenantId);
    expect(rows.map((r) => r.employeeId)).toEqual([priya.employeeId]);
  });
});

// ─── 3. Gender-scoped leave types ───────────────────────────────────────────

describe('Leave types are gender-scoped', () => {
  it('a male employee sees Paternity but never Maternity', async () => {
    const { data } = await leave.listLeaveTypes(tenantId, owner.userId);
    const names = data.map((t) => t.name);
    expect(names).toContain('Paternity Leave');
    expect(names).toContain('Casual Leave');
    expect(names).not.toContain('Maternity Leave');
  });

  it('a female employee gets Maternity balances but no Paternity', async () => {
    const { balances } = await leave.getMyBalances(priya.userId, tenantId);
    const names = balances.map((b) => b.leaveTypeName);
    expect(names).toContain('Maternity Leave');
    expect(names).not.toContain('Paternity Leave');
  });

  it('no gender on file ⇒ only untagged types', async () => {
    const { data } = await leave.listLeaveTypes(tenantId, noGender.userId);
    expect(data.map((t) => t.name)).toEqual(['Casual Leave']);
  });

  it('applying for a non-applicable type is rejected', async () => {
    await expect(
      leave.applyLeave(owner.userId, tenantId, {
        leaveTypeId: maternityTypeId,
        startDate: '2026-09-07',
        endDate: '2026-09-08',
        reason: 'Should never be allowed for a male employee',
      } as never),
    ).rejects.toThrow(/not applicable|not found/i);
    // …while the matching type sails through validation.
    const req = await leave.applyLeave(owner.userId, tenantId, {
      leaveTypeId: paternityTypeId,
      startDate: '2026-09-07',
      endDate: '2026-09-08',
      reason: 'Paternity leave for the new arrival',
    } as never);
    expect(req.status).toBe('pending');
  });
});

// ─── 4. PM milestones ───────────────────────────────────────────────────────

describe('PM — milestone at create + cross-project move regression', () => {
  let teamId: string;
  let projectA: string;
  let projectB: string;
  let milestoneA: string;

  beforeAll(async () => {
    await teamsSvc.ensureWorkspace(tenantId, owner.userId);
    const teams = await teamsSvc.list(tenantId, owner.userId);
    teamId = teams.data.teams[0]!.id;
    const pa = await projectsSvc.create(tenantId, owner.userId, { name: 'R13 Alpha', team_ids: [teamId] });
    const pb = await projectsSvc.create(tenantId, owner.userId, { name: 'R13 Beta', team_ids: [teamId] });
    projectA = pa.data.id;
    projectB = pb.data.id;
    const ms = await projectsSvc.createMilestone(tenantId, owner.userId, {
      project_id: projectA,
      name: 'Design freeze',
    });
    milestoneA = ms.data.id;
  });

  it('creates an issue linked to a project + milestone in one call', async () => {
    const created = await issuesSvc.create(tenantId, owner.userId, {
      team_id: teamId,
      title: 'Ship the geofence strip',
      project_id: projectA,
      milestone_id: milestoneA,
    });
    expect(created.data.project_id).toBe(projectA);
    expect(created.data.milestone_id).toBe(milestoneA);
  });

  it("rejects a milestone that isn't in the given project (and milestone without project)", async () => {
    await expect(
      issuesSvc.create(tenantId, owner.userId, {
        team_id: teamId,
        title: 'Wrong project milestone',
        project_id: projectB,
        milestone_id: milestoneA,
      }),
    ).rejects.toThrow(/milestone_id does not belong/);
    await expect(
      issuesSvc.create(tenantId, owner.userId, {
        team_id: teamId,
        title: 'Milestone with no project',
        milestone_id: milestoneA,
      }),
    ).rejects.toThrow(/requires project_id/);
  });

  it('REGRESSION: moving a milestoned issue to another project clears the milestone instead of 400ing', async () => {
    const created = await issuesSvc.create(tenantId, owner.userId, {
      team_id: teamId,
      title: 'Issue that moves house',
      project_id: projectA,
      milestone_id: milestoneA,
    });
    // Pre-fix this threw BadRequest('milestone_id does not belong to this project').
    const moved = await issuesSvc.setProject(tenantId, owner.userId, created.data.id, {
      project_id: projectB,
    });
    expect(moved.data.project_id).toBe(projectB);
    expect(moved.data.milestone_id).toBeNull();
  });
});

// ─── 5. Slug + General-tab preferences ──────────────────────────────────────

describe('Editable slug + workspace preferences', () => {
  it('updates the slug (audited before/after), rejects reserved and taken IDs', async () => {
    const fresh = `r13-renamed-${rid()}`;
    const org = await settings.updateOrganization(tenantId, owner.userId, { slug: fresh } as never);
    expect(org.slug).toBe(fresh);

    const [entry] = await dbAdmin
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, 'tenant.updated')))
      .orderBy(desc(auditLog.created_at))
      .limit(1);
    expect((entry!.after_state as { slug?: string }).slug).toBe(fresh);
    expect((entry!.before_state as { slug?: string }).slug).not.toBe(fresh);

    await expect(
      settings.updateOrganization(tenantId, owner.userId, { slug: 'admin' } as never),
    ).rejects.toThrow(/reserved/i);

    const [other] = await dbAdmin.select().from(tenants).where(eq(tenants.id, otherTenantId));
    await expect(
      settings.updateOrganization(tenantId, owner.userId, { slug: other!.slug } as never),
    ).rejects.toThrow(/taken/i);
  });

  it('writes timezone / fiscal year / week start, and timesheet weeks follow week_starts_on', async () => {
    const org = await settings.updateOrganization(tenantId, owner.userId, {
      timezone: 'Asia/Dubai',
      fiscalYearStartMonth: 1,
      weekStartsOn: 0, // Sunday
    } as never);
    expect(org.timezone).toBe('Asia/Dubai');
    expect(org.fiscalYearStartMonth).toBe(1);
    expect(org.weekStartsOn).toBe(0);

    // The get-or-create current period must now key on a SUNDAY start.
    const period = await timesheet.getMyCurrentPeriod(owner.userId, tenantId);
    const start = new Date(`${period.periodStart}T00:00:00Z`);
    expect(start.getUTCDay()).toBe(0);
    const end = new Date(`${period.periodEnd}T00:00:00Z`);
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(6);
  });
});
