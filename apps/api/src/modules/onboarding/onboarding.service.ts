import {
  Injectable,
  ConflictException,
  BadRequestException,
  Logger,
  Inject,
} from '@nestjs/common';
import { eq, and, inArray } from 'drizzle-orm';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import {
  tenants,
  memberships,
  users,
  leaveTypes,
  holidays,
  employees,
  departments,
  locations,
  shiftTemplates,
  subscriptions,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { TRIAL_DAYS, PLATFORM_PLAN, RESERVED_TENANT_SLUGS } from '@flicks/shared/constants';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AnalyticsService,
  SERVER_EVENTS,
} from '../../core/analytics/analytics.service';
import type {
  CreateTenantDto,
  UpdateTenantDetailsDto,
  CreateDepartmentsDto,
} from './onboarding.dto';

// 11 standard Indian leave types
const INDIAN_LEAVE_TYPES = [
  {
    name: 'Casual Leave',
    code: 'CL',
    default_quota_days: 12,
    is_paid: true,
    allow_half_day: true,
    accrual_method: 'none' as const,
    description: 'General purpose leave for personal matters',
    color: '#6366f1',
  },
  {
    name: 'Sick Leave',
    code: 'SL',
    default_quota_days: 12,
    is_paid: true,
    allow_half_day: true,
    accrual_method: 'none' as const,
    description: 'Leave for illness or medical treatment',
    requires_attachment: true,
    attachment_after_days: 3,
    color: '#f59e0b',
  },
  {
    name: 'Earned Leave',
    code: 'EL',
    default_quota_days: 15,
    is_paid: true,
    allow_half_day: true,
    accrual_method: 'monthly' as const,
    carry_forward_allowed: true,
    max_carry_forward_days: 30,
    encashable: true,
    description: 'Annual earned leave / privilege leave',
    color: '#22c55e',
  },
  {
    name: 'Maternity Leave',
    code: 'ML',
    default_quota_days: 182,
    is_paid: true,
    allow_half_day: false,
    accrual_method: 'none' as const,
    min_tenure_days: 80,
    applicable_genders: ['female'],
    description: 'Maternity leave as per Maternity Benefit Act (26 weeks)',
    color: '#ec4899',
  },
  {
    name: 'Paternity Leave',
    code: 'PL',
    default_quota_days: 15,
    is_paid: true,
    allow_half_day: false,
    accrual_method: 'none' as const,
    applicable_genders: ['male'],
    description: 'Paternity leave for new fathers',
    color: '#3b82f6',
  },
  {
    name: 'Loss of Pay',
    code: 'LOP',
    default_quota_days: 0,
    is_paid: false,
    is_lop: true,
    allow_half_day: true,
    accrual_method: 'none' as const,
    description: 'Unpaid leave when no leave balance is available',
    color: '#ef4444',
  },
  {
    name: 'Compensatory Off',
    code: 'COMP',
    default_quota_days: 0,
    is_paid: true,
    allow_half_day: true,
    accrual_method: 'none' as const,
    description: 'Comp off for working on holidays/weekends',
    color: '#8b5cf6',
  },
  {
    name: 'Bereavement Leave',
    code: 'BL',
    default_quota_days: 5,
    is_paid: true,
    allow_half_day: false,
    accrual_method: 'none' as const,
    description: 'Leave for the death of an immediate family member',
    color: '#6b7280',
  },
  {
    name: 'Marriage Leave',
    code: 'MAR',
    default_quota_days: 5,
    is_paid: true,
    allow_half_day: false,
    accrual_method: 'none' as const,
    description: 'Leave for own marriage',
    color: '#f472b6',
  },
  {
    name: 'Optional Holiday',
    code: 'OH',
    default_quota_days: 2,
    is_paid: true,
    allow_half_day: false,
    accrual_method: 'none' as const,
    description: 'Flexible holidays from a list of optional holidays',
    color: '#14b8a6',
  },
  {
    name: 'Work From Home',
    code: 'WFH',
    default_quota_days: 0,
    is_paid: true,
    allow_half_day: true,
    accrual_method: 'none' as const,
    description: 'Work from home — tracked but not deducted from leave',
    color: '#06b6d4',
  },
];

// Indian national holidays for the current year
function getIndianNationalHolidays(year: number) {
  return [
    { date: `${year}-01-26`, name: 'Republic Day', type: 'national' as const },
    { date: `${year}-08-15`, name: 'Independence Day', type: 'national' as const },
    { date: `${year}-10-02`, name: 'Gandhi Jayanti', type: 'national' as const },
    { date: `${year}-01-01`, name: 'New Year', type: 'company' as const },
    { date: `${year}-05-01`, name: 'Labour Day', type: 'national' as const },
    { date: `${year}-12-25`, name: 'Christmas', type: 'national' as const },
  ];
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  // Onboarding provisions a brand-new tenant and seeds its tables (locations,
  // employees, departments, memberships, …). At checkSlug/createTenant time
  // there is no tenant context to scope to — the tenant is being created — and
  // slug uniqueness is a global check. So this service runs on the service-role
  // (BYPASSRLS) connection, like FAM provisioning, rather than the tenant role.
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly db: DbAdmin,
    private readonly auditService: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
  ) {}

  async checkSlug(slug: string): Promise<{ available: boolean }> {
    // Reserved platform hosts (PRD v5 §1) can never become tenant subdomains —
    // {slug}.flickssuite.com would collide with app/api/mail/in/admin/etc.
    if ((RESERVED_TENANT_SLUGS as readonly string[]).includes(slug.toLowerCase())) {
      return { available: false };
    }
    const existing = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);

    return { available: existing.length === 0 };
  }

  async createTenant(dto: CreateTenantDto, userId: string) {
    // Check slug uniqueness
    const { available } = await this.checkSlug(dto.slug);
    if (!available) {
      throw new ConflictException('This slug is already taken. Please choose another.');
    }

    // Load the user so we can use their email + update their name if the
    // current value is still the email-prefix default (handleSuccessfulAuth
    // seeds full_name = email.split('@')[0]).
    const [foundingUser] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!foundingUser) {
      throw new BadRequestException('User not found — sign in before creating a workspace.');
    }

    // Don't let a single user OWN multiple tenants from this flow — but
    // being a guest/employee/auditor somewhere else must NOT block creating
    // your own first workspace (round 7, founder decision: the guest →
    // customer path). Only an existing owner membership blocks.
    const existingOwner = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, userId),
          eq(memberships.role, 'owner'),
          inArray(memberships.status, ['active', 'invited']),
        ),
      )
      .limit(1);
    if (existingOwner[0]) {
      throw new ConflictException(
        'You already own a workspace. Open it from the company switcher instead.',
      );
    }

    // Parse fullName into first/last for the employee row.
    const trimmedName = dto.fullName.trim().replace(/\s+/g, ' ');
    const nameParts = trimmedName.split(' ');
    const firstName = nameParts[0]!;
    const lastName = nameParts.slice(1).join(' ') || firstName;

    // Create tenant with Indian defaults. Trial length is the single shared
    // constant (PRD v4 — locked at 7 days).
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

    const [tenant] = await this.db
      .insert(tenants)
      .values({
        name: dto.name,
        slug: dto.slug,
        industry: dto.industry,
        size_band: dto.sizeBand,
        country_code: 'IN',
        timezone: dto.primaryLocation.timezone ?? 'Asia/Kolkata',
        currency: 'INR',
        fiscal_year_start_month: 4, // April
        date_format: 'DD/MM/YYYY',
        status: 'trialing',
        trial_ends_at: trialEndsAt,
      })
      .returning();

    // PRD v4 §8B.1 — every tenant gets its platform subscription row at
    // creation (trialing, 1 seat; seats are recounted lazily by billing).
    await this.db.insert(subscriptions).values({
      tenant_id: tenant!.id,
      plan_code: PLATFORM_PLAN.code,
      status: 'trialing',
      per_user_price: PLATFORM_PLAN.priceRupees,
      user_count: 1,
      billing_cycle: 'monthly',
      trial_ends_at: trialEndsAt,
    });

    // Update the founding user's display name. Only overwrite if the current
    // value looks like a placeholder (matches the email prefix); otherwise
    // respect whatever they've already set elsewhere.
    const emailPrefix = foundingUser.email.split('@')[0]!;
    if (foundingUser.full_name === emailPrefix || !foundingUser.full_name) {
      await this.db
        .update(users)
        .set({ full_name: trimmedName, updated_at: new Date() })
        .where(eq(users.id, userId));
    }

    // Create the primary location FIRST so we can attach the founder
    // employee to it.
    const [primaryLocation] = await this.db
      .insert(locations)
      .values({
        tenant_id: tenant.id,
        name: dto.primaryLocation.name,
        city: dto.primaryLocation.city ?? null,
        state_code: dto.primaryLocation.stateCode ?? null,
        country_code: 'IN',
        timezone: dto.primaryLocation.timezone ?? 'Asia/Kolkata',
        is_active: true,
      })
      .returning();

    // Seed the default 'General' shift template (needed before the employee
    // row so attendance can resolve a shift later).
    const [defaultShift] = await this.db
      .insert(shiftTemplates)
      .values({
        tenant_id: tenant.id,
        name: 'General',
        description: 'Default 9-to-6 shift, Mon–Fri, IST.',
        start_time: '09:00',
        end_time: '18:00',
        is_overnight: false,
        break_minutes: 60,
        break_paid: false,
        working_days: [1, 2, 3, 4, 5],
        timezone: dto.primaryLocation.timezone ?? 'Asia/Kolkata',
        grace_period_minutes: 15,
        half_day_threshold_minutes: 240,
        full_day_threshold_minutes: 480,
        is_default: true,
        is_active: true,
      })
      .returning();

    // Seed the founder as employee EMP001.
    const [founderEmployee] = await this.db
      .insert(employees)
      .values({
        tenant_id: tenant.id,
        user_id: userId,
        employee_code: 'EMP001',
        first_name: firstName,
        last_name: lastName,
        work_email: foundingUser.email,
        location_id: primaryLocation.id,
        employment_type: 'full_time',
        date_of_joining: new Date().toISOString().slice(0, 10),
        status: 'active',
      })
      .returning();

    // Create the Owner membership, linked to the founder employee row.
    await this.db.insert(memberships).values({
      tenant_id: tenant.id,
      user_id: userId,
      employee_id: founderEmployee.id,
      role: 'owner',
      status: 'active',
      accepted_at: new Date(),
    });

    // Seed 11 Indian leave types
    await this.seedDefaultLeaveTypes(tenant.id);

    // Seed Indian national holidays for current year
    const currentYear = new Date().getFullYear();
    const nationalHolidays = getIndianNationalHolidays(currentYear);

    if (nationalHolidays.length > 0) {
      await this.db.insert(holidays).values(
        nationalHolidays.map((h) => ({
          tenant_id: tenant.id,
          holiday_date: h.date,
          name: h.name,
          type: h.type,
          is_recurring: true,
        })),
      );
    }

    // Write audit event
    await this.auditService.log({
      tenantId: tenant.id,
      actorUserId: userId,
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: tenant.id,
      afterState: {
        name: tenant.name,
        slug: tenant.slug,
        ownerEmployeeId: founderEmployee.id,
        primaryLocationId: primaryLocation.id,
      },
    });

    this.logger.log(
      `Tenant created: ${tenant.slug} (${tenant.id}) by user ${userId} as Owner`,
    );

    this.analytics.capture(
      userId,
      SERVER_EVENTS.TENANT_SIGNUP_COMPLETED,
      { tenantId: tenant.id, slug: tenant.slug },
      { tenant: tenant.id },
    );
    // PRD v4 §6 F1 — first-party funnel event ('signed_up' aliases the
    // existing tenant_signup_completed).
    this.analytics.track({
      event: 'signed_up',
      tenantId: tenant.id,
      userId,
      source: 'api',
    });

    const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
    await this.notificationsService
      .sendEmail('welcome-tenant', foundingUser.email, {
        ownerName: foundingUser.full_name || foundingUser.email,
        tenantName: tenant.name,
        dashboardUrl: `${appUrl}/dashboard`,
      })
      .catch(() => undefined);

    // FAM ping: every new workspace lands in the verification queue — tell
    // the platform admins so they can actually review it. tenant_id NULL is
    // deliberate: the notifications tenantScope keeps platform rows visible
    // in the FAM shell regardless of the admin's JWT tenant. users is a
    // platform-global table (no tenant_id) — the is_platform_admin predicate
    // IS the scope for this service-role read. Best-effort: a notification
    // hiccup must never fail signup (house rule 6).
    try {
      const platformAdmins = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.is_platform_admin, true), eq(users.status, 'active')));
      await Promise.all(
        platformAdmins.map((a) =>
          this.notificationsService
            .createInAppNotification(
              a.id,
              'tenant.signup',
              `New workspace signup: ${tenant.name} (${tenant.slug}) — pending verification.`,
              `/fam/verify?tenant=${tenant.id}`,
              null,
              { groupKey: `tenant.signup:${tenant.id}` },
            )
            .catch(() => undefined),
        ),
      );
    } catch (e) {
      this.logger.warn(
        `FAM signup notification failed: ${(e as Error).message}`,
      );
    }

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      trialEndsAt: tenant.trial_ends_at,
      primaryLocationId: primaryLocation.id,
      defaultShiftId: defaultShift.id,
      ownerEmployeeId: founderEmployee.id,
    };
  }

  async updateTenantDetails(tenantId: string, dto: UpdateTenantDetailsDto) {
    // Extract state code from GSTIN (first 2 digits = state code)
    let stateCode: string | undefined;
    if (dto.gstin) {
      stateCode = dto.gstin.substring(0, 2);
    }

    const [updated] = await this.db
      .update(tenants)
      .set({
        legal_name: dto.legalName,
        gstin: dto.gstin,
        pan: dto.pan,
        cin: dto.cin,
        state_code: stateCode,
        address_line1: dto.addressLine1,
        address_line2: dto.addressLine2,
        city: dto.city,
        postal_code: dto.postalCode,
        updated_at: new Date(),
      })
      .where(eq(tenants.id, tenantId))
      .returning();

    return updated;
  }

  async createDepartments(tenantId: string, dto: CreateDepartmentsDto) {
    if (!dto.names || dto.names.length === 0) {
      throw new BadRequestException('Please provide at least one department name');
    }

    const inserted = await this.db
      .insert(departments)
      .values(
        dto.names.map((name, index) => ({
          tenant_id: tenantId,
          name,
          display_order: index,
        })),
      )
      .onConflictDoNothing()
      .returning();

    return inserted;
  }

  async getChecklist(tenantId: string) {
    // Compute checklist state from DB
    const [tenantData] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const [deptCount] = await this.db
      .select({ count: departments.id })
      .from(departments)
      .where(eq(departments.tenant_id, tenantId))
      .limit(1);

    const [employeeCount] = await this.db
      .select({ count: employees.id })
      .from(employees)
      .where(eq(employees.tenant_id, tenantId))
      .limit(1);

    const hasCompanyDetails = Boolean(
      tenantData?.legal_name || tenantData?.gstin,
    );
    const hasDepartments = deptCount?.count !== undefined;
    const hasEmployeeRecord = employeeCount?.count !== undefined;

    return {
      tasks: [
        {
          id: 'company-details',
          title: 'Complete company details',
          description: 'Add your legal name, GSTIN, PAN, and address',
          completed: hasCompanyDetails,
        },
        {
          id: 'departments',
          title: 'Create departments',
          description: 'Set up your organizational departments',
          completed: hasDepartments,
        },
        {
          id: 'employees',
          title: 'Add your first employee',
          description: 'Invite your first team member',
          completed: hasEmployeeRecord,
        },
        {
          id: 'working-hours',
          title: 'Configure working hours',
          description: 'Set default working hours and shifts',
          completed: Boolean(tenantData?.default_work_start),
        },
        {
          id: 'logo',
          title: 'Upload company logo',
          description: 'Add your company logo for branding',
          completed: Boolean(tenantData?.logo_url),
        },
      ],
      completedCount: [
        hasCompanyDetails,
        hasDepartments,
        hasEmployeeRecord,
        Boolean(tenantData?.default_work_start),
        Boolean(tenantData?.logo_url),
      ].filter(Boolean).length,
      totalCount: 5,
    };
  }

  async markChecklistItem(tenantId: string, taskId: string) {
    // In a real implementation, this would store completion state
    // For now, we'll return success (checklist is computed from actual data)
    return { taskId, completed: true };
  }

  async seedDefaultLeaveTypes(tenantId: string): Promise<void> {
    await this.db
      .insert(leaveTypes)
      .values(
        INDIAN_LEAVE_TYPES.map((lt, index) => ({
          tenant_id: tenantId,
          name: lt.name,
          code: lt.code,
          description: lt.description,
          default_quota_days: lt.default_quota_days,
          is_paid: lt.is_paid,
          is_lop: lt.is_lop ?? false,
          allow_half_day: lt.allow_half_day,
          accrual_method: lt.accrual_method,
          carry_forward_allowed: lt.carry_forward_allowed ?? false,
          max_carry_forward_days: lt.max_carry_forward_days ?? 0,
          encashable: lt.encashable ?? false,
          min_tenure_days: lt.min_tenure_days ?? 0,
          applicable_genders: lt.applicable_genders ?? null,
          requires_attachment: lt.requires_attachment ?? false,
          attachment_after_days: lt.attachment_after_days ?? 3,
          color: lt.color,
          display_order: index,
        })),
      )
      .onConflictDoNothing();
  }
}
