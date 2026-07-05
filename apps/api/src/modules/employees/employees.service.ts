import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  Inject,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, ne, and, inArray, desc, asc, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as crypto from 'crypto';
import {
  employees,
  users,
  memberships,
  tenants,
  departments,
  designations,
  employmentHistory,
  employeeDocuments,
  emergencyContacts,
  locations,
  attendanceRecords,
  leaveBalances,
  leaveTypes,
  dataConsents,
} from '@flicks/db/schema';

// Bump when the privacy policy / consent copy materially changes so we can
// tell which version each principal agreed to (DPDP audit requirement).
const CONSENT_VERSION = '2026-05-v1';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthService } from '../auth/auth.service';
import type {
  InviteEmployeeDto,
  UpdateEmployeeDto,
  SelfUpdateEmployeeDto,
  SubmitOnboardingStepDto,
  TransferEmployeeDto,
  TerminateEmployeeDto,
  EmployeeListQueryDto,
  ImportEmployeesDto,
} from './employees.dto';
import { ConfigService } from '@nestjs/config';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Fields to exclude from API responses (sensitive data)
const SAFE_EMPLOYEE_FIELDS = {
  id: employees.id,
  tenant_id: employees.tenant_id,
  user_id: employees.user_id,
  employee_code: employees.employee_code,
  status: employees.status,
  employment_type: employees.employment_type,
  date_of_joining: employees.date_of_joining,
  department_id: employees.department_id,
  location_id: employees.location_id,
  reporting_manager_id: employees.reporting_manager_id,
  designation_id: employees.designation_id,
  custom_fields: employees.custom_fields,
  created_at: employees.created_at,
  updated_at: employees.updated_at,
} as const;

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  // Every query runs through databaseService.withTenant(tenantId, …) so that
  // app.tenant_id is set for the duration of the transaction and the RLS
  // policies on the tenant tables resolve correctly. Under the NOBYPASSRLS
  // app role, a query without that context returns zero rows — so this is
  // load-bearing, not just defense-in-depth.
  constructor(
    private readonly databaseService: DatabaseService,
    // Identity provisioning (find-or-create a user by email during invite) must
    // see users across tenants — a person can already exist in another tenant —
    // so it runs on the service-role (BYPASSRLS) connection. The users RLS
    // policy (0010) otherwise scopes user visibility to the current tenant.
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async listEmployees(tenantId: string, query: EmployeeListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [eq(employees.tenant_id, tenantId)];

    if (query.departmentId) {
      conditions.push(eq(employees.department_id, query.departmentId));
    }
    if (query.locationId) {
      conditions.push(eq(employees.location_id, query.locationId));
    }
    if (query.status) {
      conditions.push(eq(employees.status, query.status as typeof employees.status._.data));
    }

    const result = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          status: employees.status,
          employmentType: employees.employment_type,
          dateOfJoining: employees.date_of_joining,
          departmentId: employees.department_id,
          departmentName: departments.name,
          locationId: employees.location_id,
          locationName: locations.name,
          reportingManagerId: employees.reporting_manager_id,
          designationId: employees.designation_id,
          userId: employees.user_id,
          fullName: users.full_name,
          email: users.email,
          avatarUrl: users.avatar_url,
          avatarKey: users.avatar_key, // §4 — controller swaps for a signed URL
          createdAt: employees.created_at,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .leftJoin(locations, eq(employees.location_id, locations.id))
        .where(and(...conditions))
        .orderBy(desc(employees.created_at))
        .limit(limit)
        .offset(offset),
    );

    return {
      data: result,
      pagination: { page, limit, total: result.length },
    };
  }

  async inviteEmployee(
    dto: InviteEmployeeDto,
    adminId: string,
    tenantId: string,
  ) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const joiningDate = dto.joiningDate
      ? dto.joiningDate
      : new Date().toISOString().split('T')[0];

    const nameParts = dto.fullName.trim().split(/\s+/);
    const firstName = nameParts[0] ?? dto.fullName;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    // Find or create the user on the service-role connection: an existing user
    // may belong to a different tenant and would be invisible under the users
    // RLS policy, so this lookup/creation must bypass RLS.
    let user = await this.dbAdmin
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (!user[0]) {
      const inserted = await this.dbAdmin
        .insert(users)
        .values({
          email: normalizedEmail,
          full_name: dto.fullName,
        })
        .returning();
      user = inserted;
    }

    const currentUser = user[0];

    const { employee, companyName } =
      await this.databaseService.withTenant(tenantId, async (db) => {
        // Check for duplicate employee code within tenant
        const existing = await db
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.tenant_id, tenantId),
              eq(employees.employee_code, dto.employeeCode),
            ),
          )
          .limit(1);

        if (existing[0]) {
          throw new ConflictException(
            `Employee code ${dto.employeeCode} is already in use`,
          );
        }

        // Create employee record
        const [employee] = await db
          .insert(employees)
          .values({
            tenant_id: tenantId,
            user_id: currentUser.id,
            employee_code: dto.employeeCode,
            first_name: firstName,
            last_name: lastName,
            work_email: normalizedEmail,
            designation_id: dto.designationId,
            department_id: dto.departmentId,
            location_id: dto.locationId,
            reporting_manager_id: dto.managerId,
            employment_type:
              (dto.employmentType as typeof employees.$inferInsert['employment_type']) ??
              'full_time',
            date_of_joining: joiningDate,
            // Pre-fills from the Invite form — the wizard lets the employee
            // edit them later but admins typically know phone + DOB up front.
            ...(dto.personalPhone ? { personal_phone: dto.personalPhone } : {}),
            ...(dto.dateOfBirth ? { date_of_birth: dto.dateOfBirth } : {}),
            status: 'inactive',
            custom_fields: {
              onboarding_step: 0,
              ...(dto.jobTitle ? { job_title: dto.jobTitle } : {}),
            },
          })
          .returning();

        // Create or update membership
        const existingMembership = await db
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.user_id, currentUser.id),
              eq(memberships.tenant_id, tenantId),
            ),
          )
          .limit(1);

        if (!existingMembership[0]) {
          await db.insert(memberships).values({
            tenant_id: tenantId,
            user_id: currentUser.id,
            employee_id: employee.id,
            role: 'employee',
            status: 'invited',
            invited_by: adminId,
            invited_at: new Date(),
          });
        }

        // Resolve tenant name for the email template.
        const [tenantRow] = await db
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        const companyName = tenantRow?.name ?? 'Your Company';

        return { employee, companyName };
      });

    // Generate a 7-day magic link so the invitee can sign in with one click,
    // bypassing the OTP flow. The link routes through /verify → /auth/magic-link
    // which calls handleSuccessfulAuth — and that activates their 'invited'
    // membership before issuing the session cookies.
    const magicLinkUrl = await this.authService.issueInviteMagicLink(
      currentUser.id,
      normalizedEmail,
    );

    // Send welcome email with the magic link as the primary CTA.
    await this.notificationsService.sendEmail(
      'welcome-employee',
      normalizedEmail,
      {
        employeeName: dto.fullName,
        companyName,
        magicLinkUrl,
      },
    );

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.invited',
      resourceType: 'employee',
      resourceId: employee.id,
      afterState: { email: normalizedEmail, employeeCode: dto.employeeCode },
    });

    this.logger.log(`Employee invited: ${normalizedEmail} (${employee.id})`);

    // Return safe response (no sensitive fields)
    return {
      id: employee.id,
      employeeCode: employee.employee_code,
      designationId: employee.designation_id,
      userId: employee.user_id,
      email: normalizedEmail,
      fullName: dto.fullName,
      status: employee.status,
      joiningDate: employee.date_of_joining,
    };
  }

  // ─── Bulk CSV import (PRD §5.5) ────────────────────────────────────────
  // Resolves department/designation/location NAMES to ids, then reuses the
  // single-invite path per row so every row goes through the same validation,
  // membership creation, and welcome email. Per-row failures are collected,
  // not fatal — a bad row never blocks the good ones.
  async importEmployees(
    dto: ImportEmployeesDto,
    adminId: string,
    tenantId: string,
  ) {
    const norm = (s: string) => s.trim().toLowerCase();

    const [depts, desigs, locs] = await this.databaseService.withTenant(
      tenantId,
      (db) =>
        Promise.all([
          db
            .select({ id: departments.id, name: departments.name })
            .from(departments)
            .where(eq(departments.tenant_id, tenantId)),
          db
            .select({ id: designations.id, title: designations.title })
            .from(designations)
            .where(eq(designations.tenant_id, tenantId)),
          db
            .select({ id: locations.id, name: locations.name })
            .from(locations)
            .where(eq(locations.tenant_id, tenantId)),
        ]),
    );
    const deptMap = new Map(depts.map((d) => [norm(d.name), d.id]));
    const desigMap = new Map(desigs.map((d) => [norm(d.title), d.id]));
    const locMap = new Map(locs.map((l) => [norm(l.name), l.id]));

    let created = 0;
    const failed: Array<{ row: number; email: string; error: string }> = [];

    for (let i = 0; i < dto.rows.length; i++) {
      const r = dto.rows[i];
      try {
        if (r.department && !deptMap.has(norm(r.department))) {
          throw new Error(`Unknown department "${r.department}"`);
        }
        if (r.designation && !desigMap.has(norm(r.designation))) {
          throw new Error(`Unknown designation "${r.designation}"`);
        }
        if (r.location && !locMap.has(norm(r.location))) {
          throw new Error(`Unknown location "${r.location}"`);
        }
        await this.inviteEmployee(
          {
            fullName: r.fullName,
            email: r.email,
            employeeCode: r.employeeCode,
            departmentId: r.department ? deptMap.get(norm(r.department)) : undefined,
            designationId: r.designation ? desigMap.get(norm(r.designation)) : undefined,
            locationId: r.location ? locMap.get(norm(r.location)) : undefined,
            employmentType: r.employmentType,
            joiningDate: r.joiningDate,
            jobTitle: r.jobTitle,
          },
          adminId,
          tenantId,
        );
        created += 1;
      } catch (e) {
        failed.push({
          row: i + 1,
          email: r.email,
          error: e instanceof Error ? e.message : 'Failed to import',
        });
      }
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.bulk_imported',
      resourceType: 'employee',
      resourceId: tenantId,
      metadata: { total: dto.rows.length, created, failed: failed.length },
    });

    return { total: dto.rows.length, created, failed };
  }

  async getEmployee(employeeId: string, tenantId: string) {
    return this.databaseService.withTenant(tenantId, async (db) => {
      // Self-join alias for the reporting manager (manager is also an employee).
      const manager = alias(employees, 'manager');
      const managerUser = alias(users, 'manager_user');

      // ─── Core profile with all joins ──────────────────────────────────────
      const [row] = await db
        .select({
          // Identity
          id: employees.id,
          employeeCode: employees.employee_code,
          firstName: employees.first_name,
          middleName: employees.middle_name,
          lastName: employees.last_name,
          preferredName: employees.preferred_name,
          // Email / phone
          workEmail: employees.work_email,
          personalEmail: employees.personal_email,
          workPhone: employees.work_phone,
          personalPhone: employees.personal_phone,
          // FKs + joined names
          userId: employees.user_id,
          departmentId: employees.department_id,
          departmentName: departments.name,
          designationId: employees.designation_id,
          designationTitle: designations.title,
          designationLevel: designations.level,
          locationId: employees.location_id,
          locationName: locations.name,
          locationCity: locations.city,
          locationTimezone: locations.timezone,
          reportingManagerId: employees.reporting_manager_id,
          reportingManagerName: managerUser.full_name,
          reportingManagerEmail: managerUser.email,
          // Employment
          employmentType: employees.employment_type,
          dateOfJoining: employees.date_of_joining,
          dateOfConfirmation: employees.date_of_confirmation,
          probationEndDate: employees.probation_end_date,
          dateOfExit: employees.date_of_exit,
          noticePeriodDays: employees.notice_period_days,
          // Personal
          dateOfBirth: employees.date_of_birth,
          gender: employees.gender,
          maritalStatus: employees.marital_status,
          nationality: employees.nationality,
          bloodGroup: employees.blood_group,
          currentAddress: employees.current_address,
          permanentAddress: employees.permanent_address,
          // Statutory (encrypted columns surfaced as flags only)
          hasPan: sql<boolean>`${employees.pan_encrypted} IS NOT NULL`,
          hasPassport: sql<boolean>`${employees.passport_number_encrypted} IS NOT NULL`,
          pfUan: employees.pf_uan,
          esicNumber: employees.esic_number,
          pfApplicable: employees.pf_applicable,
          esiApplicable: employees.esi_applicable,
          // Banking (account number encrypted; show last-4 + bank name + ifsc)
          bankName: employees.bank_name,
          bankBranch: employees.bank_branch,
          bankIfsc: employees.bank_ifsc,
          bankAccountType: employees.bank_account_type,
          bankAccountHolder: employees.bank_account_holder,
          hasBankAccount: sql<boolean>`${employees.bank_account_number_encrypted} IS NOT NULL`,
          // Status + avatar
          status: employees.status,
          avatarUrl: sql<string | null>`COALESCE(${employees.avatar_url}, ${users.avatar_url})`,
          customFields: employees.custom_fields,
          createdAt: employees.created_at,
          updatedAt: employees.updated_at,
          // Linked user identity
          userFullName: users.full_name,
          userEmail: users.email,
          // Keep snake_case mirrors of the columns that other service methods
          // already reference, so this rewrite stays a non-breaking enrichment.
          custom_fields: employees.custom_fields,
          user_id: employees.user_id,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .leftJoin(locations, eq(employees.location_id, locations.id))
        .leftJoin(manager, eq(employees.reporting_manager_id, manager.id))
        .leftJoin(managerUser, eq(manager.user_id, managerUser.id))
        .where(
          and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)),
        )
        .limit(1);

      if (!row) {
        throw new NotFoundException('Employee not found');
      }

      // ─── Sibling collections ──────────────────────────────────────────────
      const [emergencyList, leaveBalanceRows, monthStats] = await Promise.all([
        // Emergency contacts (primary first)
        db
          .select({
            id: emergencyContacts.id,
            name: emergencyContacts.name,
            relationship: emergencyContacts.relationship,
            phone: emergencyContacts.phone,
            email: emergencyContacts.email,
            isPrimary: emergencyContacts.is_primary,
          })
          .from(emergencyContacts)
          .where(
            and(
              eq(emergencyContacts.tenant_id, tenantId),
              eq(emergencyContacts.employee_id, employeeId),
            ),
          )
          .orderBy(desc(emergencyContacts.is_primary)),

        // Leave balances for the current year (with type metadata).
        // Falls back to leave_types.default_quota_days when no balance row
        // exists yet — matches the leave service's own getMyBalances shape.
        db
          .select({
            leaveTypeId: leaveTypes.id,
            leaveTypeName: leaveTypes.name,
            code: leaveTypes.code,
            color: leaveTypes.color,
            defaultQuotaDays: leaveTypes.default_quota_days,
            opening: leaveBalances.opening_balance,
            accrued: leaveBalances.accrued,
            used: leaveBalances.used,
            pending: leaveBalances.pending,
            available: leaveBalances.available,
          })
          .from(leaveTypes)
          .leftJoin(
            leaveBalances,
            and(
              eq(leaveBalances.leave_type_id, leaveTypes.id),
              eq(leaveBalances.employee_id, employeeId),
              eq(leaveBalances.leave_year, new Date().getFullYear()),
            ),
          )
          .where(
            and(
              eq(leaveTypes.tenant_id, tenantId),
              eq(leaveTypes.is_active, true),
            ),
          )
          .orderBy(asc(leaveTypes.display_order)),

        // 'This month' attendance summary — single row aggregate
        db
          .select({
            daysPresent: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} IN ('present','late','work_from_home','on_duty'))::int`,
            lateArrivals: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.is_late} = true)::int`,
            minutesWorked: sql<number>`COALESCE(SUM(${attendanceRecords.total_worked_minutes}),0)::int`,
            onLeave: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} = 'on_leave')::int`,
          })
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.tenant_id, tenantId),
              eq(attendanceRecords.employee_id, employeeId),
              sql`${attendanceRecords.attendance_date} >= date_trunc('month', current_date)::date`,
              sql`${attendanceRecords.attendance_date} <= current_date`,
            ),
          ),
      ]);

      const month = monthStats[0] ?? {
        daysPresent: 0,
        lateArrivals: 0,
        minutesWorked: 0,
        onLeave: 0,
      };

      return {
        ...row,
        // Synthesise the "this month" card from the aggregate.
        thisMonth: {
          daysPresent: Number(month.daysPresent ?? 0),
          lateArrivals: Number(month.lateArrivals ?? 0),
          hoursWorked: Math.round(Number(month.minutesWorked ?? 0) / 60),
          leaveTaken: Number(month.onLeave ?? 0),
        },
        emergencyContacts: emergencyList,
        leaveBalances: leaveBalanceRows.map((b) => ({
          leaveTypeId: b.leaveTypeId,
          leaveTypeName: b.leaveTypeName,
          code: b.code,
          color: b.color,
          opening: Number(b.opening ?? b.defaultQuotaDays ?? 0),
          accrued: Number(b.accrued ?? 0),
          used: Number(b.used ?? 0),
          pending: Number(b.pending ?? 0),
          available: Number(b.available ?? b.defaultQuotaDays ?? 0),
        })),
      };
    });
  }

  async getMyRecord(userId: string, tenantId: string) {
    const membership = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({ employeeId: memberships.employee_id })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, userId),
            eq(memberships.tenant_id, tenantId),
          ),
        )
        .limit(1),
    );

    if (!membership[0]?.employeeId) {
      throw new NotFoundException('Employee record not found');
    }

    return this.getEmployee(membership[0].employeeId, tenantId);
  }

  async listMyTeam(userId: string, tenantId: string) {
    return this.databaseService.withTenant(tenantId, async (db) => {
      const [membership] = await db
        .select({ employeeId: memberships.employee_id })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, userId),
            eq(memberships.tenant_id, tenantId),
          ),
        )
        .limit(1);
      if (!membership?.employeeId) {
        // User has no employee row (e.g. plain admin user) → empty team.
        return { data: [], total: 0 };
      }

      const managerEmployeeId = membership.employeeId;

      const rows = await db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          firstName: employees.first_name,
          lastName: employees.last_name,
          fullName: sql<string>`COALESCE(${employees.first_name}, '') || ' ' || COALESCE(${employees.last_name}, '')`,
          workEmail: employees.work_email,
          status: employees.status,
          employmentType: employees.employment_type,
          dateOfJoining: employees.date_of_joining,
          // Joined names
          departmentId: employees.department_id,
          departmentName: departments.name,
          designationId: employees.designation_id,
          designationTitle: designations.title,
          locationId: employees.location_id,
          locationName: locations.name,
          avatarUrl: sql<string | null>`COALESCE(${employees.avatar_url}, ${users.avatar_url})`,
          userId: employees.user_id, // D9 presence keying
          // Submitted-for-review flag — managers should see which of their
          // reports have finished self-onboarding.
          onboardingComplete: sql<boolean>`(${employees.custom_fields}->>'onboarding_submitted_for_review')::boolean`,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .leftJoin(locations, eq(employees.location_id, locations.id))
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            eq(employees.reporting_manager_id, managerEmployeeId),
          ),
        )
        .orderBy(asc(employees.first_name));

      return {
        managerEmployeeId,
        data: rows,
        total: rows.length,
      };
    });
  }

  async updateEmployee(
    employeeId: string,
    dto: UpdateEmployeeDto,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const empPatch: Partial<typeof employees.$inferInsert> = {
      updated_at: new Date(),
    };

    if (dto.fullName !== undefined) {
      const parts = dto.fullName.trim().split(/\s+/);
      empPatch.first_name = parts[0] ?? dto.fullName;
      empPatch.last_name = parts.length > 1 ? parts.slice(1).join(' ') : '';
    }
    if (dto.workPhone !== undefined) empPatch.work_phone = dto.workPhone;
    if (dto.personalPhone !== undefined)
      empPatch.personal_phone = dto.personalPhone;
    if (dto.designationId !== undefined)
      empPatch.designation_id = dto.designationId;

    const updated = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        const [updated] = await db
          .update(employees)
          .set(empPatch)
          .where(eq(employees.id, employeeId))
          .returning();

        // Name + avatar live on the user record, shared across memberships.
        if (
          employee.userId &&
          (dto.fullName !== undefined || dto.avatarUrl !== undefined)
        ) {
          await db
            .update(users)
            .set({
              ...(dto.fullName !== undefined ? { full_name: dto.fullName } : {}),
              ...(dto.avatarUrl !== undefined ? { avatar_url: dto.avatarUrl } : {}),
              updated_at: new Date(),
            })
            .where(eq(users.id, employee.userId));
        }

        return updated;
      },
    );

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.updated',
      resourceType: 'employee',
      resourceId: employeeId,
      beforeState: {
        firstName: employee.firstName,
        lastName: employee.lastName,
        workPhone: employee.workPhone,
        personalPhone: employee.personalPhone,
        designationId: employee.designationId,
      },
      afterState: {
        fullName: dto.fullName,
        workPhone: dto.workPhone,
        personalPhone: dto.personalPhone,
        designationId: dto.designationId,
      },
    });

    return updated;
  }

  async getOnboardingQueue(tenantId: string) {
    const rows = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          fullName: users.full_name,
          email: users.email,
          avatarUrl: users.avatar_url,
          designationTitle: designations.title,
          departmentName: departments.name,
          status: employees.status,
          submittedAt: sql<string | null>`${employees.custom_fields}->>'onboarding_submitted_at'`,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            sql`(${employees.custom_fields}->>'onboarding_submitted_for_review')::boolean = true`,
            ne(employees.status, 'active'),
          ),
        )
        .orderBy(asc(employees.created_at)),
    );

    return { data: rows, total: rows.length };
  }

  async rejectOnboarding(
    employeeId: string,
    reason: string | undefined,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    // Clear the review flag so the employee can edit + resubmit, and record
    // the reason in custom_fields for the wizard to surface.
    const existing = (employee.customFields ?? {}) as Record<string, unknown>;
    const user = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        await db
          .update(employees)
          .set({
            custom_fields: {
              ...existing,
              onboarding_submitted_for_review: false,
              onboarding_rejection_reason: reason ?? null,
              onboarding_rejected_at: new Date().toISOString(),
            },
            updated_at: new Date(),
          })
          .where(eq(employees.id, employeeId));

        if (!employee.userId) return null;
        const [u] = await db
          .select({ email: users.email, full_name: users.full_name })
          .from(users)
          .where(eq(users.id, employee.userId))
          .limit(1);
        return u ?? null;
      },
    );

    if (employee.userId && user) {
      await this.notificationsService
        .createInAppNotification(
          employee.userId,
          'onboarding.rejected',
          reason
            ? `Your onboarding was sent back for changes: ${reason}`
            : 'Your onboarding was sent back for changes. Please review and resubmit.',
          '/employees/me/onboarding',
          tenantId,
        )
        .catch(() => undefined);

      const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
      await this.notificationsService
        .sendEmail('onboarding-rejected', user.email, {
          employeeName: user.full_name,
          reason,
          resubmitUrl: `${appUrl}/employees/me/onboarding`,
        })
        .catch(() => undefined);
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.onboarding.rejected',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: { reason: reason ?? null },
    });

    return { employeeId, status: employee.status, rejectedBy: adminId };
  }

  async selfUpdateEmployee(
    userId: string,
    dto: SelfUpdateEmployeeDto,
    tenantId: string,
  ) {
    const employeeId = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        const membership = await db
          .select({ employeeId: memberships.employee_id })
          .from(memberships)
          .where(
            and(
              eq(memberships.user_id, userId),
              eq(memberships.tenant_id, tenantId),
            ),
          )
          .limit(1);

        if (!membership[0]?.employeeId) {
          throw new NotFoundException('Employee record not found');
        }

        // Update user's phone in users table
        if (dto.phone) {
          await db
            .update(users)
            .set({ phone: dto.phone, updated_at: new Date() })
            .where(eq(users.id, userId));
        }

        return membership[0].employeeId;
      },
    );

    return this.getEmployee(employeeId, tenantId);
  }

  async submitOnboardingStep(
    employeeId: string,
    step: number,
    data: SubmitOnboardingStepDto,
    tenantId: string,
    actorUserId: string,
    ctx?: { ip?: string; userAgent?: string },
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const existingCustom =
      (employee.custom_fields as Record<string, unknown> | null) ?? {};
    const currentStep =
      typeof existingCustom.onboarding_step === 'number'
        ? existingCustom.onboarding_step
        : 0;
    const nextStep = Math.max(currentStep, step);
    const allStepsComplete = nextStep >= 5 || data.submitForReview === true;

    // ─── Project section data into typed employee columns ────────────────
    const updateFields: Record<string, unknown> = {};

    if (data.personalInfo) {
      const p = data.personalInfo;
      if (p.dateOfBirth !== undefined) updateFields.date_of_birth = p.dateOfBirth;
      if (p.gender !== undefined) updateFields.gender = p.gender;
      if (p.maritalStatus !== undefined)
        updateFields.marital_status = p.maritalStatus;
      if (p.bloodGroup !== undefined) updateFields.blood_group = p.bloodGroup;
      // current_address is a JSONB blob. Merge with whatever's already there.
      if (
        p.addressLine1 !== undefined ||
        p.addressLine2 !== undefined ||
        p.city !== undefined ||
        p.stateCode !== undefined ||
        p.postalCode !== undefined
      ) {
        const prev =
          (employee.currentAddress as Record<string, unknown> | null) ?? {};
        updateFields.current_address = {
          line1: p.addressLine1 ?? prev.line1 ?? null,
          line2: p.addressLine2 ?? prev.line2 ?? null,
          city: p.city ?? prev.city ?? null,
          state: p.stateCode ?? prev.state ?? null,
          postal_code: p.postalCode ?? prev.postal_code ?? null,
          country: prev.country ?? 'IN',
        };
      }
    }

    if (data.identity) {
      const i = data.identity;
      // *_encrypted columns are named for the future; field-level encryption
      // is a Sprint 4 hardening task. For now we write plain text.
      if (i.pan !== undefined) updateFields.pan_encrypted = i.pan;
      if (i.personalPhone !== undefined)
        updateFields.personal_phone = i.personalPhone;
      if (i.personalEmail !== undefined)
        updateFields.personal_email = i.personalEmail;
      if (i.nationality !== undefined) updateFields.nationality = i.nationality;
    }

    if (data.bank) {
      const b = data.bank;
      if (b.bankName !== undefined) updateFields.bank_name = b.bankName;
      if (b.bankBranch !== undefined) updateFields.bank_branch = b.bankBranch;
      if (b.bankIfsc !== undefined) updateFields.bank_ifsc = b.bankIfsc;
      if (b.bankAccountType !== undefined)
        updateFields.bank_account_type = b.bankAccountType;
      if (b.bankAccountHolder !== undefined)
        updateFields.bank_account_holder = b.bankAccountHolder;
      if (b.bankAccountNumber !== undefined)
        updateFields.bank_account_number_encrypted = b.bankAccountNumber;
      if (b.pfUan !== undefined) updateFields.pf_uan = b.pfUan;
    }

    updateFields.custom_fields = {
      ...existingCustom,
      onboarding_step: nextStep,
      onboarding_completed_at: allStepsComplete ? new Date().toISOString() : null,
      onboarding_submitted_for_review: allStepsComplete,
      ...(allStepsComplete
        ? { onboarding_submitted_at: new Date().toISOString() }
        : {}),
    };
    updateFields.updated_at = new Date();

    await this.databaseService.withTenant(tenantId, async (db) => {
      await db
        .update(employees)
        .set(updateFields)
        .where(eq(employees.id, employeeId));

      // ─── Emergency contact: upsert the primary row ─────────────────────
      if (data.emergencyContact) {
        const ec = data.emergencyContact;
        const [existing] = await db
          .select()
          .from(emergencyContacts)
          .where(
            and(
              eq(emergencyContacts.tenant_id, tenantId),
              eq(emergencyContacts.employee_id, employeeId),
              eq(emergencyContacts.is_primary, true),
            ),
          )
          .limit(1);

        if (existing) {
          await db
            .update(emergencyContacts)
            .set({
              name: ec.name,
              relationship: ec.relationship,
              phone: ec.phone,
              email: ec.email ?? null,
            })
            .where(eq(emergencyContacts.id, existing.id));
        } else {
          await db.insert(emergencyContacts).values({
            tenant_id: tenantId,
            employee_id: employeeId,
            name: ec.name,
            relationship: ec.relationship,
            phone: ec.phone,
            email: ec.email ?? null,
            is_primary: true,
          });
        }
      }

      // ─── DPDP consents ─────────────────────────────────────────────────
      // Record each granted/withheld consent as its own immutable row, with
      // the policy version + IP + UA for the audit trail. We re-grant on
      // every submit that carries consents (idempotent enough for the MVP —
      // the rows are timestamped so the latest one wins on read).
      if (data.consents?.length) {
        const now = new Date();
        await db.insert(dataConsents).values(
          data.consents.map((c) => ({
            tenant_id: tenantId,
            user_id: actorUserId,
            consent_type: c.type as
              | 'data_processing'
              | 'marketing'
              | 'background_check'
              | 'biometric_data'
              | 'third_party_sharing',
            purpose: c.purpose ?? null,
            granted: c.granted,
            consent_version: CONSENT_VERSION,
            ip_address: ctx?.ip ?? null,
            user_agent: ctx?.userAgent ?? null,
            granted_at: c.granted ? now : null,
          })),
        );
      }
    });

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: allStepsComplete
        ? 'employee.onboarding_submitted'
        : 'employee.onboarding_step_saved',
      resourceType: 'employee',
      resourceId: employeeId,
      afterState: {
        step: nextStep,
        allStepsComplete,
        consentsRecorded: data.consents?.length ?? 0,
      },
    });

    if (allStepsComplete) {
      this.eventEmitter.emit('employee.onboarding.submitted', {
        employeeId,
        tenantId,
        step,
      });

      // Notify the reporting manager (best-effort) that there's an onboarding
      // to approve. The People → Onboarding queue is the canonical surface.
      try {
        const info = await this.databaseService.withTenant(
          tenantId,
          async (db) => {
            const mgr = alias(employees, 'mgr_submit');
            const mgrUser = alias(users, 'mgr_submit_user');
            const [info] = await db
              .select({
                employeeName: sql<string>`trim(coalesce(${employees.first_name},'') || ' ' || coalesce(${employees.last_name},''))`,
                managerEmail: mgrUser.email,
                managerName: mgrUser.full_name,
              })
              .from(employees)
              .leftJoin(mgr, eq(employees.reporting_manager_id, mgr.id))
              .leftJoin(mgrUser, eq(mgr.user_id, mgrUser.id))
              .where(eq(employees.id, employeeId))
              .limit(1);
            return info;
          },
        );

        if (info?.managerEmail) {
          const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
          await this.notificationsService.sendEmail(
            'onboarding-submitted',
            info.managerEmail,
            {
              approverName: info.managerName ?? 'there',
              employeeName: info.employeeName || 'A new hire',
              reviewUrl: `${appUrl}/employees/onboarding`,
            },
          );
        }
      } catch (e) {
        this.logger.warn(
          `Could not send onboarding-submitted email: ${(e as Error).message}`,
        );
      }
    }

    return {
      employeeId,
      step,
      onboardingStep: nextStep,
      allStepsComplete,
    };
  }

  async getMyOnboardingStatus(userId: string, tenantId: string) {
    const employeeId = await this.getEmployeeIdForUserOrNull(userId, tenantId);
    if (!employeeId) {
      return { employeeId: null, onboardingStep: 0, submittedAt: null, submittedForReview: false };
    }
    const employee = await this.getEmployee(employeeId, tenantId);
    const custom =
      (employee.customFields as Record<string, unknown> | null) ?? {};
    return {
      employeeId,
      onboardingStep:
        typeof custom.onboarding_step === 'number' ? custom.onboarding_step : 0,
      submittedAt: (custom.onboarding_completed_at as string | undefined) ?? null,
      submittedForReview:
        custom.onboarding_submitted_for_review === true,
    };
  }

  private async getEmployeeIdForUserOrNull(userId: string, tenantId: string) {
    const [m] = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({ employeeId: memberships.employee_id })
        .from(memberships)
        .where(
          and(eq(memberships.user_id, userId), eq(memberships.tenant_id, tenantId)),
        )
        .limit(1),
    );
    return m?.employeeId ?? null;
  }

  async approveOnboarding(
    employeeId: string,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const user = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Activate employee
        await db
          .update(employees)
          .set({ status: 'active', updated_at: new Date() })
          .where(eq(employees.id, employeeId));

        // Activate membership
        await db
          .update(memberships)
          .set({ status: 'active', accepted_at: new Date() })
          .where(
            and(
              eq(memberships.employee_id, employeeId),
              eq(memberships.tenant_id, tenantId),
            ),
          );

        // Get user email for notification
        if (!employee.user_id) return null;
        const [u] = await db
          .select({ email: users.email, full_name: users.full_name })
          .from(users)
          .where(eq(users.id, employee.user_id))
          .limit(1);
        return u ?? null;
      },
    );

    if (employee.user_id && user) {
      const loginUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
      await this.notificationsService.sendEmail(
        'onboarding-approved',
        user.email,
        { employeeName: user.full_name, loginUrl },
      );
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.onboarding.approved',
      resourceType: 'employee',
      resourceId: employeeId,
    });

    return { employeeId, status: 'active', approvedBy: adminId };
  }

  async transferEmployee(
    employeeId: string,
    dto: TransferEmployeeDto,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const previousValue = {
      departmentId: employee.departmentId,
      reportingManagerId: employee.reportingManagerId,
      locationId: employee.locationId,
      designationId: employee.designationId,
    };
    const newValue = {
      departmentId: dto.departmentId ?? employee.departmentId,
      reportingManagerId: dto.managerId ?? employee.reportingManagerId,
      locationId: dto.locationId ?? employee.locationId,
      designationId: dto.designationId ?? employee.designationId,
    };

    const updated = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Record history
        await db.insert(employmentHistory).values({
          tenant_id: tenantId,
          employee_id: employeeId,
          change_type: 'transfer',
          effective_from:
            dto.effectiveDate ?? new Date().toISOString().split('T')[0],
          previous_value: previousValue,
          new_value: newValue,
          reason: dto.reason,
          changed_by: adminId,
        });

        // Update employee record
        const [updated] = await db
          .update(employees)
          .set({
            department_id: dto.departmentId ?? employee.departmentId,
            reporting_manager_id: dto.managerId ?? employee.reportingManagerId,
            location_id: dto.locationId ?? employee.locationId,
            designation_id: dto.designationId ?? employee.designationId,
            updated_at: new Date(),
          })
          .where(eq(employees.id, employeeId))
          .returning();

        return updated;
      },
    );

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.transferred',
      resourceType: 'employee',
      resourceId: employeeId,
      beforeState: previousValue,
      afterState: newValue,
    });

    return updated;
  }

  async terminateEmployee(
    employeeId: string,
    dto: TerminateEmployeeDto,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const lastWorkingDate =
      dto.lastWorkingDate ?? new Date().toISOString().split('T')[0];

    await this.databaseService.withTenant(tenantId, async (db) => {
      await db
        .update(employees)
        .set({
          status: 'notice_period',
          updated_at: new Date(),
        })
        .where(eq(employees.id, employeeId));

      // Record in employment history
      await db.insert(employmentHistory).values({
        tenant_id: tenantId,
        employee_id: employeeId,
        change_type: 'separation',
        effective_from: lastWorkingDate,
        previous_value: {
          designationId: employee.designationId,
          status: employee.status,
        },
        new_value: { status: 'notice_period', separationType: dto.separationType },
        reason: dto.reason,
        changed_by: adminId,
      });
    });

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.termination.initiated',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: {
        reason: dto.reason,
        lastWorkingDate,
        separationType: dto.separationType,
      },
    });

    return {
      employeeId,
      status: 'notice_period',
      lastWorkingDate,
      reason: dto.reason,
    };
  }

  async getEmploymentHistory(employeeId: string, tenantId: string) {
    await this.getEmployee(employeeId, tenantId); // verify access

    return this.databaseService.withTenant(tenantId, (db) =>
      db
        .select()
        .from(employmentHistory)
        .where(eq(employmentHistory.employee_id, employeeId))
        .orderBy(desc(employmentHistory.effective_from)),
    );
  }

  async getOrgChart(tenantId: string) {
    const allEmployees = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          fullName: users.full_name,
          email: users.email,
          avatarUrl: users.avatar_url,
          userId: employees.user_id, // D9 presence keying
          designationTitle: designations.title,
          departmentName: departments.name,
          managerId: employees.reporting_manager_id,
          status: employees.status,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            inArray(employees.status, ['active', 'on_leave', 'notice_period']),
          ),
        ),
    );

    type OrgNode = (typeof allEmployees)[number] & { children: OrgNode[] };

    const nodeMap = new Map<string, OrgNode>();
    for (const emp of allEmployees) {
      nodeMap.set(emp.id, { ...emp, children: [] });
    }

    const roots: OrgNode[] = [];
    for (const emp of allEmployees) {
      const node = nodeMap.get(emp.id)!;
      if (emp.managerId && nodeMap.has(emp.managerId)) {
        nodeMap.get(emp.managerId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return { tree: roots, total: allEmployees.length };
  }

  async generateSignedUrl(r2Key: string): Promise<{ url: string; expiresAt: Date }> {
    // In production: generate pre-signed Cloudflare R2 URL
    // For now, return a placeholder structure
    const publicUrl = this.configService.get<string>('R2_PUBLIC_URL', '');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    return {
      url: `${publicUrl}/${r2Key}`,
      expiresAt,
    };
  }

  async getDocumentSignedUrl(
    employeeId: string,
    docId: string,
    tenantId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const doc = await this.databaseService.withTenant(tenantId, async (db) => {
      const [doc] = await db
        .select()
        .from(employeeDocuments)
        .where(
          and(
            eq(employeeDocuments.id, docId),
            eq(employeeDocuments.employee_id, employeeId),
            eq(employeeDocuments.tenant_id, tenantId),
          ),
        )
        .limit(1);
      return doc;
    });

    if (!doc) {
      throw new NotFoundException('Document not found');
    }

    return this.generateSignedUrl(doc.r2_key ?? '');
  }
}
