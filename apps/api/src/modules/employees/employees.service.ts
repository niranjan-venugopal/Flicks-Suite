import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  Inject,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, and, ilike, inArray, desc, asc, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import {
  employees,
  users,
  memberships,
  departments,
  employmentHistory,
  employeeDocuments,
  locations,
} from '@flicks/db/schema';
import { DB_TENANT } from '../../core/database/database.module';
import type { Db } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  InviteEmployeeDto,
  UpdateEmployeeDto,
  SelfUpdateEmployeeDto,
  OnboardingStepDto,
  TransferEmployeeDto,
  TerminateEmployeeDto,
  EmployeeListQueryDto,
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

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
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

    const result = await this.db
      .select(SAFE_EMPLOYEE_FIELDS)
      .from(employees)
      .where(and(...conditions))
      .orderBy(desc(employees.created_at))
      .limit(limit)
      .offset(offset);

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

    // Check for duplicate employee code within tenant
    const existing = await this.db
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

    // Find or create user
    let user = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (!user[0]) {
      const inserted = await this.db
        .insert(users)
        .values({
          email: normalizedEmail,
          full_name: dto.fullName,
        })
        .returning();
      user = inserted;
    }

    const currentUser = user[0];

    // Create employee record
    const joiningDate = dto.joiningDate
      ? dto.joiningDate
      : new Date().toISOString().split('T')[0];

    const nameParts = dto.fullName.trim().split(/\s+/);
    const firstName = nameParts[0] ?? dto.fullName;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    const [employee] = await this.db
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
        employment_type: (dto.employmentType as typeof employees.$inferInsert['employment_type']) ?? 'full_time',
        date_of_joining: joiningDate,
        status: 'inactive',
        custom_fields: { onboarding_step: 0 },
      })
      .returning();

    // Create or update membership
    const existingMembership = await this.db
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
      await this.db.insert(memberships).values({
        tenant_id: tenantId,
        user_id: currentUser.id,
        employee_id: employee.id,
        role: 'employee',
        status: 'invited',
        invited_by: adminId,
        invited_at: new Date(),
      });
    }

    // Get company info for invite email
    const adminUser = await this.db
      .select({ full_name: users.full_name })
      .from(users)
      .where(eq(users.id, adminId))
      .limit(1);

    const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
    const onboardingUrl = `${appUrl}/onboarding`;

    // Send welcome email
    await this.notificationsService.sendEmail(
      'welcome-employee',
      normalizedEmail,
      {
        employeeName: dto.fullName,
        companyName: 'Your Company', // Would resolve from tenant
        onboardingUrl,
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

  async getEmployee(employeeId: string, tenantId: string) {
    const [employee] = await this.db
      .select(SAFE_EMPLOYEE_FIELDS)
      .from(employees)
      .where(
        and(
          eq(employees.id, employeeId),
          eq(employees.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    return employee;
  }

  async getMyRecord(userId: string, tenantId: string) {
    const membership = await this.db
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

    return this.getEmployee(membership[0].employeeId, tenantId);
  }

  async updateEmployee(
    employeeId: string,
    dto: UpdateEmployeeDto,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const [updated] = await this.db
      .update(employees)
      .set({
        updated_at: new Date(),
      })
      .where(eq(employees.id, employeeId))
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.updated',
      resourceType: 'employee',
      resourceId: employeeId,
      beforeState: { designationId: employee.designation_id },
      afterState: { fullName: dto.fullName, phone: dto.phone },
    });

    return updated;
  }

  async selfUpdateEmployee(
    userId: string,
    dto: SelfUpdateEmployeeDto,
    tenantId: string,
  ) {
    const membership = await this.db
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
      await this.db
        .update(users)
        .set({ phone: dto.phone, updated_at: new Date() })
        .where(eq(users.id, userId));
    }

    return this.getEmployee(membership[0].employeeId, tenantId);
  }

  async submitOnboardingStep(
    employeeId: string,
    step: number,
    data: OnboardingStepDto,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const existingCustom =
      (employee.custom_fields as Record<string, unknown> | null) ?? {};
    const currentStep =
      typeof existingCustom.onboarding_step === 'number'
        ? existingCustom.onboarding_step
        : 0;
    const nextStep = Math.max(currentStep, step);
    const allStepsComplete = nextStep >= 5;

    const [updated] = await this.db
      .update(employees)
      .set({
        custom_fields: {
          ...existingCustom,
          onboarding_step: nextStep,
          onboarding_completed_at: allStepsComplete
            ? new Date().toISOString()
            : null,
        },
        updated_at: new Date(),
      })
      .where(eq(employees.id, employeeId))
      .returning();

    if (allStepsComplete) {
      this.eventEmitter.emit('employee.onboarding.submitted', {
        employeeId,
        tenantId,
        step,
      });
    }

    const updatedCustom =
      (updated.custom_fields as Record<string, unknown> | null) ?? {};
    return {
      employeeId,
      step,
      onboardingStep: updatedCustom.onboarding_step ?? nextStep,
      allStepsComplete,
    };
  }

  async approveOnboarding(
    employeeId: string,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    // Activate employee
    await this.db
      .update(employees)
      .set({ status: 'active', updated_at: new Date() })
      .where(eq(employees.id, employeeId));

    // Activate membership
    await this.db
      .update(memberships)
      .set({ status: 'active', accepted_at: new Date() })
      .where(
        and(
          eq(memberships.employee_id, employeeId),
          eq(memberships.tenant_id, tenantId),
        ),
      );

    // Get user email for notification
    if (employee.user_id) {
      const [user] = await this.db
        .select({ email: users.email, full_name: users.full_name })
        .from(users)
        .where(eq(users.id, employee.user_id))
        .limit(1);

      if (user) {
        const loginUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
        await this.notificationsService.sendEmail(
          'onboarding-approved',
          user.email,
          { employeeName: user.full_name, loginUrl },
        );
      }
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
      departmentId: employee.department_id,
      reportingManagerId: employee.reporting_manager_id,
      locationId: employee.location_id,
      designationId: employee.designation_id,
    };
    const newValue = {
      departmentId: dto.departmentId ?? employee.department_id,
      reportingManagerId: dto.managerId ?? employee.reporting_manager_id,
      locationId: dto.locationId ?? employee.location_id,
      designationId: dto.designationId ?? employee.designation_id,
    };

    // Record history
    await this.db.insert(employmentHistory).values({
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
    const [updated] = await this.db
      .update(employees)
      .set({
        department_id: dto.departmentId ?? employee.department_id,
        reporting_manager_id: dto.managerId ?? employee.reporting_manager_id,
        location_id: dto.locationId ?? employee.location_id,
        designation_id: dto.designationId ?? employee.designation_id,
        updated_at: new Date(),
      })
      .where(eq(employees.id, employeeId))
      .returning();

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

    await this.db
      .update(employees)
      .set({
        status: 'notice_period',
        updated_at: new Date(),
      })
      .where(eq(employees.id, employeeId));

    // Record in employment history
    await this.db.insert(employmentHistory).values({
      tenant_id: tenantId,
      employee_id: employeeId,
      change_type: 'separation',
      effective_from: lastWorkingDate,
      previous_value: {
        designationId: employee.designation_id,
        status: employee.status,
      },
      new_value: { status: 'notice_period', separationType: dto.separationType },
      reason: dto.reason,
      changed_by: adminId,
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

    return this.db
      .select()
      .from(employmentHistory)
      .where(eq(employmentHistory.employee_id, employeeId))
      .orderBy(desc(employmentHistory.effective_from));
  }

  async getOrgChart(tenantId: string) {
    const allEmployees = await this.db
      .select({
        id: employees.id,
        employeeCode: employees.employee_code,
        designationId: employees.designation_id,
        managerId: employees.reporting_manager_id,
        departmentId: employees.department_id,
        status: employees.status,
      })
      .from(employees)
      .where(
        and(
          eq(employees.tenant_id, tenantId),
          eq(employees.status, 'active'),
        ),
      );

    // Build tree structure
    const nodeMap = new Map<
      string,
      typeof allEmployees[0] & { children: typeof allEmployees }
    >();

    for (const emp of allEmployees) {
      nodeMap.set(emp.id, { ...emp, children: [] });
    }

    const roots: typeof allEmployees = [];

    for (const emp of allEmployees) {
      const node = nodeMap.get(emp.id)!;
      if (emp.managerId && nodeMap.has(emp.managerId)) {
        nodeMap.get(emp.managerId)!.children.push(node as typeof allEmployees[0]);
      } else {
        roots.push(node as typeof allEmployees[0]);
      }
    }

    return { tree: roots };
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
    const [doc] = await this.db
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

    if (!doc) {
      throw new NotFoundException('Document not found');
    }

    return this.generateSignedUrl(doc.r2_key ?? '');
  }
}
