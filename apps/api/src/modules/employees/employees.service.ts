import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, ne, and, inArray, desc, asc, sql, or, isNull } from 'drizzle-orm';
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
  employeeChangeRequests,
} from '@flicks/db/schema';

// Bump when the privacy policy / consent copy materially changes so we can
// tell which version each principal agreed to (DPDP audit requirement).
const CONSENT_VERSION = '2026-05-v1';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { FieldCipher } from '../../core/common/field-cipher';
import type { Db, DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthService } from '../auth/auth.service';
import { MediaService } from '../media/media.service';
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
    // Resolves users.avatar_key into a signed URL. Every read surface that
    // renders a face must go through this: the upload path writes ONLY
    // avatar_key, so the legacy avatar_url columns stay null forever.
    private readonly mediaService: MediaService,
  ) {}

  // AES-256-GCM for sensitive at-rest columns (PAN, bank account number).
  // Blank key (local dev) = plaintext passthrough; decrypt handles legacy
  // plaintext rows written before encryption shipped.
  private readonly fieldCipher = new FieldCipher(
    process.env.EMPLOYEE_DATA_ENC_KEY,
    'flicks-employee-fields-v1',
  );

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

  /**
   * FK constraints bypass RLS, so an org ref accepted from a DTO
   * (department/designation/location/manager id) would happily point at
   * another tenant's row. These lookups run inside the tenant transaction
   * (RLS-scoped), so a cross-tenant id resolves to nothing and is rejected —
   * same pattern as assertRefsInTenant in crm/deals.service.ts.
   */
  private async assertOrgRefsInTenant(
    db: Db,
    tenantId: string,
    refs: {
      departmentId?: string | null;
      designationId?: string | null;
      locationId?: string | null;
      managerEmployeeId?: string | null;
    },
  ): Promise<void> {
    if (refs.departmentId) {
      const [row] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, refs.departmentId), eq(departments.tenant_id, tenantId)))
        .limit(1);
      if (!row) throw new BadRequestException('departmentId does not belong to this workspace');
    }
    if (refs.designationId) {
      const [row] = await db
        .select({ id: designations.id })
        .from(designations)
        .where(and(eq(designations.id, refs.designationId), eq(designations.tenant_id, tenantId)))
        .limit(1);
      if (!row) throw new BadRequestException('designationId does not belong to this workspace');
    }
    if (refs.locationId) {
      const [row] = await db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, refs.locationId), eq(locations.tenant_id, tenantId)))
        .limit(1);
      if (!row) throw new BadRequestException('locationId does not belong to this workspace');
    }
    if (refs.managerEmployeeId) {
      const [row] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.id, refs.managerEmployeeId), eq(employees.tenant_id, tenantId)))
        .limit(1);
      if (!row) throw new BadRequestException('managerId does not belong to this workspace');
    }
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
        // Reject cross-tenant / dangling org refs before writing them.
        await this.assertOrgRefsInTenant(db, tenantId, {
          departmentId: dto.departmentId,
          designationId: dto.designationId,
          locationId: dto.locationId,
          managerEmployeeId: dto.managerId,
        });

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
          locationCountryCode: locations.country_code,
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
          aadhaarLast4: employees.aadhaar_last4,
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
          avatarKey: users.avatar_key,
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
              // Gender-scoped: untagged types for everyone; tagged types only
              // when THIS employee's gender matches (mirrors leave service).
              or(
                isNull(leaveTypes.applicable_genders),
                sql`(SELECT e.gender::text FROM employees e WHERE e.id = ${employeeId} AND e.tenant_id = ${tenantId}) = ANY(${leaveTypes.applicable_genders})`,
              ),
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

      const { avatarKey, ...rest } = row;
      return {
        ...rest,
        // The photo lives in users.avatar_key (the upload path never writes
        // the legacy avatar_url columns), so resolve it to a signed URL here.
        avatarUrl: await this.mediaService.servedUrl(
          avatarKey ?? null,
          row.avatarUrl,
          256,
        ),
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
          avatarKey: users.avatar_key,
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

      const data = await this.withAvatars(rows);
      return {
        managerEmployeeId,
        data,
        total: data.length,
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
    if (dto.employeeCode !== undefined)
      empPatch.employee_code = dto.employeeCode.trim().toUpperCase();
    if (dto.departmentId !== undefined) empPatch.department_id = dto.departmentId;
    if (dto.locationId !== undefined) empPatch.location_id = dto.locationId;
    if (dto.reportingManagerId !== undefined)
      empPatch.reporting_manager_id = dto.reportingManagerId;
    if (dto.employmentType !== undefined)
      empPatch.employment_type = dto.employmentType as typeof employees.$inferInsert.employment_type;
    if (dto.dateOfJoining !== undefined)
      empPatch.date_of_joining = dto.dateOfJoining;

    const updated = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Reject cross-tenant / dangling org refs before writing them.
        await this.assertOrgRefsInTenant(db, tenantId, {
          departmentId: dto.departmentId,
          designationId: dto.designationId,
          locationId: dto.locationId,
          managerEmployeeId: dto.reportingManagerId,
        });

        const [updated] = await db
          .update(employees)
          .set(empPatch)
          .where(eq(employees.id, employeeId))
          .returning()
          .catch((err: unknown) => {
            // employees_tenant_code_unique — duplicate code in this workspace.
            if ((err as { code?: string })?.code === '23505') {
              throw new ConflictException(
                'That employee code is already in use in this workspace.',
              );
            }
            throw err;
          });

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

  /**
   * Swaps `avatarKey` for a signed URL on a row set, falling back to the
   * legacy `avatarUrl` column. Every avatar-bearing read goes through this —
   * the upload path writes `users.avatar_key` only, so a surface that reads
   * the legacy column alone shows initials forever.
   */
  private async withAvatars<
    T extends { avatarKey?: string | null; avatarUrl?: string | null },
  >(rows: T[], size: 256 | 64 = 64): Promise<Omit<T, 'avatarKey'>[]> {
    return Promise.all(
      rows.map(async ({ avatarKey, ...row }) => ({
        ...(row as Omit<T, 'avatarKey'>),
        avatarUrl: await this.mediaService.servedUrl(
          avatarKey ?? null,
          (row as { avatarUrl?: string | null }).avatarUrl ?? null,
          size,
        ),
      })),
    );
  }

  async getOnboardingQueue(tenantId: string, callerUserId: string) {
    const rows = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          fullName: users.full_name,
          email: users.email,
          avatarUrl: users.avatar_url,
          avatarKey: users.avatar_key,
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
            // Nobody reviews their own profile — hide the caller's row (a
            // second owner would otherwise see and approve himself). IS
            // DISTINCT FROM keeps invited rows (user_id NULL) visible.
            sql`${employees.user_id} IS DISTINCT FROM ${callerUserId}`,
          ),
        )
        .orderBy(asc(employees.created_at)),
    );

    const data = await this.withAvatars(rows);
    return { data, total: data.length };
  }

  async rejectOnboarding(
    employeeId: string,
    reason: string | undefined,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    if (employee.userId && employee.userId === adminId) {
      throw new ForbiddenException(
        'You cannot review your own onboarding — another admin must approve or send it back.',
      );
    }

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

    // Every other admin's queue/inbox just changed — broadcast the refresh.
    this.eventEmitter.emit('employees.directory.changed', { tenantId });

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
    ctx?: { ip?: string; userAgent?: string; isAdminEdit?: boolean },
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const existingCustom =
      (employee.custom_fields as Record<string, unknown> | null) ?? {};
    const currentStep =
      typeof existingCustom.onboarding_step === 'number'
        ? existingCustom.onboarding_step
        : 0;
    const nextStep = Math.max(currentStep, step);
    // Admin edits (the "Edit details" dialog / confirmed change requests)
    // must never re-trigger review submission: for an already-onboarded
    // employee onboarding_step sticks at 5, so without this guard any admin
    // tab-save recomputed allStepsComplete=true, flipped
    // onboarding_submitted_for_review back on and re-emailed the manager.
    const isAdminEdit = ctx?.isAdminEdit === true;
    const allStepsComplete =
      !isAdminEdit && (nextStep >= 5 || data.submitForReview === true);

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
      if (i.pan !== undefined)
        updateFields.pan_encrypted = this.fieldCipher.encrypt(i.pan);
      if (i.aadhaarLast4 !== undefined)
        updateFields.aadhaar_last4 = i.aadhaarLast4;
      if (i.passportNumber !== undefined)
        updateFields.passport_number_encrypted = this.fieldCipher.encrypt(
          i.passportNumber,
        );
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
        updateFields.bank_account_number_encrypted = this.fieldCipher.encrypt(
          b.bankAccountNumber,
        );
      if (b.pfUan !== undefined) updateFields.pf_uan = b.pfUan;
    }

    if (!isAdminEdit) {
      updateFields.custom_fields = {
        ...existingCustom,
        onboarding_step: nextStep,
        onboarding_completed_at: allStepsComplete ? new Date().toISOString() : null,
        onboarding_submitted_for_review: allStepsComplete,
        ...(allStepsComplete
          ? { onboarding_submitted_at: new Date().toISOString() }
          : {}),
      };
    }
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
        : isAdminEdit
          ? 'employee.details_admin_saved'
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
      // Tenant-wide "employees data changed" broadcast (queue rows appear on
      // every admin's screen without a reload).
      this.eventEmitter.emit('employees.directory.changed', { tenantId });

      // Notify reviewers (best-effort): the reporting manager by email, and
      // every active owner/admin in-app — EXCLUDING the submitter (a second
      // owner must never be invited to review their own profile). The
      // People → Onboarding queue is the canonical surface.
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
              reviewUrl: `${appUrl}/employees/onboarding?employee=${employeeId}`,
            },
          );
        }

        // In-app ping for every active owner/admin except the submitter.
        // dbAdmin (memberships are cross-tenant-invisible under RLS at this
        // point) — tenant predicate is mandatory.
        const reviewers = await this.dbAdmin
          .select({ userId: memberships.user_id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenant_id, tenantId),
              eq(memberships.status, 'active'),
              inArray(memberships.role, ['owner', 'admin']),
              ne(memberships.user_id, actorUserId),
            ),
          );
        const recipientIds = [...new Set(reviewers.map((r) => r.userId))];
        for (const reviewerId of recipientIds) {
          await this.notificationsService
            .createInAppNotification(
              reviewerId,
              'onboarding.submitted',
              `${info?.employeeName || 'A new hire'} submitted onboarding for review.`,
              // Deep link straight into the review dialog for THIS employee —
              // a bare queue URL left reviewers with nothing to act on.
              `/employees/onboarding?employee=${employeeId}`,
              tenantId,
              { groupKey: `onboarding:${employeeId}` },
            )
            .catch(() => undefined);
        }
      } catch (e) {
        this.logger.warn(
          `Could not send onboarding-submitted notifications: ${(e as Error).message}`,
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

  // ─── Admin detail edits → employee confirmation (change requests) ─────────
  // HR/Owner edits to an ACTIVE, app-joined employee's personal/identity/bank
  // details are held as a pending change request until the employee confirms
  // (or rejects) them — nothing touches the record behind their back. For
  // employees who haven't joined yet (invited / still onboarding) there is
  // nobody to confirm, so the edit applies directly as before.

  private maskTail(value: string): string {
    return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
  }

  /** Builds the masked old→new display summary for a change request. */
  private buildChangeSummary(
    employee: Record<string, unknown>,
    dto: SubmitOnboardingStepDto,
  ): Array<{ field: string; from: string | null; to: string }> {
    const rows: Array<{ field: string; from: string | null; to: string }> = [];
    const push = (field: string, from: unknown, to: unknown) => {
      if (to === undefined) return;
      rows.push({
        field,
        from: from == null || from === '' ? null : String(from),
        to: String(to),
      });
    };
    const p = dto.personalInfo;
    if (p) {
      const addr = (employee.currentAddress as Record<string, unknown>) ?? {};
      push('Date of birth', employee.dateOfBirth, p.dateOfBirth);
      push('Gender', employee.gender, p.gender);
      push('Marital status', employee.maritalStatus, p.maritalStatus);
      push('Blood group', employee.bloodGroup, p.bloodGroup);
      push('Address line 1', addr.line1, p.addressLine1);
      push('Address line 2', addr.line2, p.addressLine2);
      push('City', addr.city, p.city);
      push('State', addr.state, p.stateCode);
      push('Postal code', addr.postal_code, p.postalCode);
    }
    const i = dto.identity;
    if (i) {
      if (i.pan !== undefined)
        rows.push({
          field: 'PAN',
          from: employee.hasPan ? 'on file' : null,
          to: this.maskTail(i.pan),
        });
      if (i.passportNumber !== undefined)
        rows.push({
          field: 'Passport / ID number',
          from: employee.hasPassport ? 'on file' : null,
          to: this.maskTail(i.passportNumber),
        });
      push('Aadhaar (last 4)', employee.aadhaarLast4, i.aadhaarLast4);
      push('Personal phone', employee.personalPhone, i.personalPhone);
      push('Personal email', employee.personalEmail, i.personalEmail);
      push('Nationality', employee.nationality, i.nationality);
    }
    const b = dto.bank;
    if (b) {
      push('Bank name', employee.bankName, b.bankName);
      push('Branch', employee.bankBranch, b.bankBranch);
      if (b.bankAccountNumber !== undefined)
        rows.push({
          field: 'Account number',
          from: employee.hasBankAccount ? 'on file' : null,
          to: this.maskTail(b.bankAccountNumber),
        });
      push('Account holder', employee.bankAccountHolder, b.bankAccountHolder);
      push('IFSC', employee.bankIfsc, b.bankIfsc);
      push('Account type', employee.bankAccountType, b.bankAccountType);
      push('PF UAN', employee.pfUan, b.pfUan);
    }
    return rows;
  }

  /**
   * Entry point for the admin "Edit details" dialog. Decides between the
   * pending-confirmation flow (active, app-joined employee) and direct apply
   * (nobody to confirm yet).
   */
  async adminSubmitEmployeeDetails(
    employeeId: string,
    step: number,
    dto: SubmitOnboardingStepDto,
    tenantId: string,
    adminUserId: string,
    ctx?: { ip?: string; userAgent?: string },
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);
    const confirmable = Boolean(employee.userId) && employee.status === 'active';

    if (!confirmable) {
      const result = await this.submitOnboardingStep(
        employeeId,
        step,
        { ...dto, submitForReview: undefined },
        tenantId,
        adminUserId,
        { ...ctx, isAdminEdit: true },
      );
      return { ...result, pendingConfirmation: false as const };
    }

    // Store the payload with sensitive values encrypted at rest; the masked
    // summary is what both sides see in the UI.
    const payload: Record<string, unknown> = { step };
    if (dto.personalInfo) payload.personalInfo = { ...dto.personalInfo };
    if (dto.identity) {
      payload.identity = {
        ...dto.identity,
        ...(dto.identity.pan !== undefined
          ? { pan: this.fieldCipher.encrypt(dto.identity.pan) }
          : {}),
      };
    }
    if (dto.bank) {
      payload.bank = {
        ...dto.bank,
        ...(dto.bank.bankAccountNumber !== undefined
          ? { bankAccountNumber: this.fieldCipher.encrypt(dto.bank.bankAccountNumber) }
          : {}),
      };
    }
    const summary = this.buildChangeSummary(
      employee as unknown as Record<string, unknown>,
      dto,
    );
    if (summary.length === 0) {
      return { employeeId, step, pendingConfirmation: false as const };
    }

    const request = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // One live request per employee+step: a re-save replaces the
        // previous pending values instead of stacking duplicates.
        await db
          .update(employeeChangeRequests)
          .set({ status: 'cancelled', reviewed_at: new Date() })
          .where(
            and(
              eq(employeeChangeRequests.tenant_id, tenantId),
              eq(employeeChangeRequests.employee_id, employeeId),
              eq(employeeChangeRequests.step, step),
              eq(employeeChangeRequests.status, 'pending'),
            ),
          );
        const [row] = await db
          .insert(employeeChangeRequests)
          .values({
            tenant_id: tenantId,
            employee_id: employeeId,
            requested_by_user_id: adminUserId,
            step,
            payload,
            summary,
          })
          .returning();
        return row;
      },
    );

    if (employee.userId) {
      await this.notificationsService
        .createInAppNotification(
          employee.userId as string,
          'employee.details_change_requested',
          'HR updated your details — please review and confirm the change.',
          '/profile',
          tenantId,
        )
        .catch(() => undefined);
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminUserId,
      action: 'employee.details_change_requested',
      resourceType: 'employee',
      resourceId: employeeId,
      afterState: { requestId: request!.id, step, fields: summary.map((s) => s.field) },
    });

    return {
      employeeId,
      step,
      pendingConfirmation: true as const,
      requestId: request!.id,
    };
  }

  /** Pending change requests for the calling employee (masked summary). */
  async listMyChangeRequests(userId: string, tenantId: string) {
    const employeeId = await this.getEmployeeIdForUserOrNull(userId, tenantId);
    if (!employeeId) return { requests: [] };
    const rows = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employeeChangeRequests.id,
          step: employeeChangeRequests.step,
          summary: employeeChangeRequests.summary,
          createdAt: employeeChangeRequests.created_at,
          requestedByName: users.full_name,
        })
        .from(employeeChangeRequests)
        .leftJoin(users, eq(employeeChangeRequests.requested_by_user_id, users.id))
        .where(
          and(
            eq(employeeChangeRequests.tenant_id, tenantId),
            eq(employeeChangeRequests.employee_id, employeeId),
            eq(employeeChangeRequests.status, 'pending'),
          ),
        )
        .orderBy(desc(employeeChangeRequests.created_at)),
    );
    return { requests: rows };
  }

  /** Employee decision on a pending request. Confirm applies; reject flags HR. */
  async reviewMyChangeRequest(
    userId: string,
    tenantId: string,
    requestId: string,
    action: 'confirm' | 'reject',
    reason?: string,
  ) {
    const employeeId = await this.getEmployeeIdForUserOrNull(userId, tenantId);
    if (!employeeId) throw new NotFoundException('Employee record not found');

    const request = await this.databaseService.withTenant(tenantId, async (db) => {
      const [row] = await db
        .select()
        .from(employeeChangeRequests)
        .where(
          and(
            eq(employeeChangeRequests.id, requestId),
            eq(employeeChangeRequests.tenant_id, tenantId),
            eq(employeeChangeRequests.employee_id, employeeId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException('Change request not found');
      if (row.status !== 'pending')
        throw new ConflictException('This change request was already reviewed');
      return row;
    });

    if (action === 'confirm') {
      // Decrypt sensitive values back into the step-writer's shape; the
      // writer re-encrypts them into the employee columns.
      const payload = request.payload as {
        personalInfo?: Record<string, unknown>;
        identity?: { pan?: string } & Record<string, unknown>;
        bank?: { bankAccountNumber?: string } & Record<string, unknown>;
      };
      const dto: Record<string, unknown> = { step: request.step };
      if (payload.personalInfo) dto.personalInfo = payload.personalInfo;
      if (payload.identity) {
        dto.identity = {
          ...payload.identity,
          ...(payload.identity.pan !== undefined
            ? { pan: this.fieldCipher.decrypt(payload.identity.pan) }
            : {}),
        };
      }
      if (payload.bank) {
        dto.bank = {
          ...payload.bank,
          ...(payload.bank.bankAccountNumber !== undefined
            ? { bankAccountNumber: this.fieldCipher.decrypt(payload.bank.bankAccountNumber) }
            : {}),
        };
      }
      await this.submitOnboardingStep(
        employeeId,
        request.step,
        dto as unknown as SubmitOnboardingStepDto,
        tenantId,
        userId,
        { isAdminEdit: true },
      );
    }

    await this.databaseService.withTenant(tenantId, (db) =>
      db
        .update(employeeChangeRequests)
        .set({
          status: action === 'confirm' ? 'confirmed' : 'rejected',
          reason: reason ?? null,
          reviewed_at: new Date(),
        })
        .where(eq(employeeChangeRequests.id, requestId)),
    );

    if (request.requested_by_user_id) {
      const summary = (request.summary as Array<{ field: string }>) ?? [];
      const fields = summary.map((s) => s.field).slice(0, 3).join(', ');
      await this.notificationsService
        .createInAppNotification(
          request.requested_by_user_id,
          action === 'confirm'
            ? 'employee.details_change_confirmed'
            : 'employee.details_change_rejected',
          action === 'confirm'
            ? `Details change confirmed by the employee (${fields}).`
            : `Details change rejected by the employee${reason ? `: ${reason}` : ''} (${fields}).`,
          `/employees/${employeeId}`,
          tenantId,
        )
        .catch(() => undefined);
    }

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action:
        action === 'confirm'
          ? 'employee.details_change_confirmed'
          : 'employee.details_change_rejected',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: { requestId, reason: reason ?? null },
    });

    return { requestId, status: action === 'confirm' ? 'confirmed' : 'rejected' };
  }

  /** Admin view of an employee's change requests (recent first). */
  async listEmployeeChangeRequests(employeeId: string, tenantId: string) {
    await this.getEmployee(employeeId, tenantId); // 404 for unknown/foreign ids
    const rows = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employeeChangeRequests.id,
          step: employeeChangeRequests.step,
          summary: employeeChangeRequests.summary,
          status: employeeChangeRequests.status,
          reason: employeeChangeRequests.reason,
          createdAt: employeeChangeRequests.created_at,
          reviewedAt: employeeChangeRequests.reviewed_at,
          requestedByName: users.full_name,
        })
        .from(employeeChangeRequests)
        .leftJoin(users, eq(employeeChangeRequests.requested_by_user_id, users.id))
        .where(
          and(
            eq(employeeChangeRequests.tenant_id, tenantId),
            eq(employeeChangeRequests.employee_id, employeeId),
          ),
        )
        .orderBy(desc(employeeChangeRequests.created_at))
        .limit(20),
    );
    return { requests: rows };
  }

  /** Admin withdraws a pending request before the employee acts on it. */
  async cancelChangeRequest(
    employeeId: string,
    requestId: string,
    tenantId: string,
    adminUserId: string,
  ) {
    const updated = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .update(employeeChangeRequests)
        .set({ status: 'cancelled', reviewed_at: new Date() })
        .where(
          and(
            eq(employeeChangeRequests.id, requestId),
            eq(employeeChangeRequests.tenant_id, tenantId),
            eq(employeeChangeRequests.employee_id, employeeId),
            eq(employeeChangeRequests.status, 'pending'),
          ),
        )
        .returning({ id: employeeChangeRequests.id }),
    );
    if (updated.length === 0)
      throw new NotFoundException('No pending change request to cancel');
    await this.auditService.log({
      tenantId,
      actorUserId: adminUserId,
      action: 'employee.details_change_cancelled',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: { requestId },
    });
    return { cancelled: true };
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

    if (employee.user_id && employee.user_id === adminId) {
      throw new ForbiddenException(
        'You cannot approve your own onboarding — another admin must review it.',
      );
    }

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
      await this.notificationsService
        .createInAppNotification(
          employee.user_id,
          'onboarding.approved',
          'Your onboarding was approved — your profile is now active. Welcome aboard!',
          '/dashboard',
          tenantId,
        )
        .catch(() => undefined);

      const loginUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
      await this.notificationsService
        .sendEmail('onboarding-approved', user.email, {
          employeeName: user.full_name,
          loginUrl,
        })
        .catch(() => undefined);
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.onboarding.approved',
      resourceType: 'employee',
      resourceId: employeeId,
    });

    // The approved employee just became visible in the directory/org chart —
    // push a tenant-wide refresh so every open screen updates live.
    this.eventEmitter.emit('employees.directory.changed', { tenantId });

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
          avatarKey: users.avatar_key,
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

    // Resolve photos before the tree is assembled — the nodes are what the
    // chart renders, and they must carry a usable avatarUrl.
    const withPhotos = await this.withAvatars(allEmployees);

    type OrgNode = (typeof withPhotos)[number] & { children: OrgNode[] };

    const nodeMap = new Map<string, OrgNode>();
    for (const emp of withPhotos) {
      nodeMap.set(emp.id, { ...emp, children: [] });
    }

    const roots: OrgNode[] = [];
    for (const emp of withPhotos) {
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
