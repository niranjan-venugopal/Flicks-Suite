import {
  Injectable,
  Logger,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { eq, and, count } from 'drizzle-orm';
import {
  tenants,
  locations,
  departments,
  memberships,
} from '@flicks/db';
import {
  DB_TENANT,
  DB_SERVICE_ROLE,
} from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import type {
  CreateDepartmentDto,
  UpdateDepartmentDto,
  CreateLocationDto,
  UpdateLocationDto,
  UpdateWorkingHoursDto,
  CreateDesignationDto,
  UpdateOrganizationDto,
} from './settings.dto';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
  ) {}

  // ─── Organization (tenant profile) ─────────────────────────────────────────

  async getOrganization(tenantId: string) {
    const [tenant] = await this.dbAdmin
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const [locationCount] = await this.dbAdmin
      .select({ value: count() })
      .from(locations)
      .where(
        and(eq(locations.tenant_id, tenantId), eq(locations.is_active, true)),
      );

    const [departmentCount] = await this.dbAdmin
      .select({ value: count() })
      .from(departments)
      .where(
        and(
          eq(departments.tenant_id, tenantId),
          eq(departments.is_active, true),
        ),
      );

    const [memberCount] = await this.dbAdmin
      .select({ value: count() })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
        ),
      );

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      legalName: tenant.legal_name,
      gstin: tenant.gstin,
      pan: tenant.pan,
      cin: tenant.cin,
      industry: tenant.industry,
      sizeBand: tenant.size_band,
      countryCode: tenant.country_code,
      stateCode: tenant.state_code,
      city: tenant.city,
      addressLine1: tenant.address_line1,
      addressLine2: tenant.address_line2,
      postalCode: tenant.postal_code,
      timezone: tenant.timezone,
      currency: tenant.currency,
      fiscalYearStartMonth: tenant.fiscal_year_start_month,
      dateFormat: tenant.date_format,
      logoUrl: tenant.logo_url,
      brandColor: tenant.brand_color,
      status: tenant.status,
      trialEndsAt: tenant.trial_ends_at,
      verifiedAt: tenant.verified_at,
      createdAt: tenant.created_at,
      counts: {
        locations: locationCount?.value ?? 0,
        departments: departmentCount?.value ?? 0,
        activeMembers: memberCount?.value ?? 0,
      },
    };
  }

  async updateOrganization(
    tenantId: string,
    actorUserId: string,
    dto: UpdateOrganizationDto,
  ) {
    const [existing] = await this.dbAdmin
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!existing) {
      throw new NotFoundException('Tenant not found');
    }

    // GSTIN's first 2 chars are the state code — keep stateCode in sync if GSTIN changes.
    const derivedStateCode = dto.gstin
      ? dto.gstin.substring(0, 2)
      : dto.stateCode;

    const [updated] = await this.dbAdmin
      .update(tenants)
      .set({
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.legalName !== undefined && { legal_name: dto.legalName }),
        ...(dto.gstin !== undefined && { gstin: dto.gstin }),
        ...(dto.pan !== undefined && { pan: dto.pan }),
        ...(dto.cin !== undefined && { cin: dto.cin }),
        ...(dto.industry !== undefined && { industry: dto.industry }),
        ...(dto.sizeBand !== undefined && { size_band: dto.sizeBand }),
        ...(dto.addressLine1 !== undefined && {
          address_line1: dto.addressLine1,
        }),
        ...(dto.addressLine2 !== undefined && {
          address_line2: dto.addressLine2,
        }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(derivedStateCode !== undefined && {
          state_code: derivedStateCode,
        }),
        ...(dto.postalCode !== undefined && { postal_code: dto.postalCode }),
        updated_at: new Date(),
      })
      .where(eq(tenants.id, tenantId))
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'tenant.updated',
      resourceType: 'tenant',
      resourceId: tenantId,
      beforeState: {
        name: existing.name,
        legalName: existing.legal_name,
        gstin: existing.gstin,
        pan: existing.pan,
        industry: existing.industry,
        sizeBand: existing.size_band,
      },
      afterState: {
        name: updated.name,
        legalName: updated.legal_name,
        gstin: updated.gstin,
        pan: updated.pan,
        industry: updated.industry,
        sizeBand: updated.size_band,
      },
    });

    return this.getOrganization(tenantId);
  }

  // ─── Departments ───────────────────────────────────────────────────────────

  /**
   * Lists all departments for the tenant.
   * TODO: select from departments where tenant_id = $1 order by name.
   */
  async listDepartments(tenantId: string) {
    return {
      data: [] as Array<{
        id: string;
        name: string;
        code: string | null;
        parentId: string | null;
        isActive: boolean;
      }>,
      total: 0,
    };
  }

  /**
   * Creates a new department.
   * TODO: insert into departments; ensure unique (tenant_id, name).
   */
  async createDepartment(
    tenantId: string,
    actorUserId: string,
    dto: CreateDepartmentDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'department.created',
      resourceType: 'department',
      afterState: { name: dto.name, code: dto.code },
    });

    return {
      id: '',
      name: dto.name,
      code: dto.code ?? null,
      parentId: dto.parentId ?? null,
      isActive: true,
    };
  }

  /**
   * Updates an existing department.
   * TODO: update departments set ... where id and tenant_id.
   */
  async updateDepartment(
    departmentId: string,
    tenantId: string,
    actorUserId: string,
    dto: UpdateDepartmentDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'department.updated',
      resourceType: 'department',
      resourceId: departmentId,
      afterState: dto as Record<string, unknown>,
    });

    return { id: departmentId, ...dto };
  }

  // ─── Locations ─────────────────────────────────────────────────────────────

  /**
   * Lists all locations for the tenant.
   * TODO: select from locations where tenant_id and is_active.
   */
  async listLocations(tenantId: string) {
    return {
      data: [] as Array<{
        id: string;
        name: string;
        city: string | null;
        timezone: string;
        isActive: boolean;
      }>,
      total: 0,
    };
  }

  /**
   * Creates a new location with optional geofence + IP allowlist.
   * TODO: insert into locations.
   */
  async createLocation(
    tenantId: string,
    actorUserId: string,
    dto: CreateLocationDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'location.created',
      resourceType: 'location',
      afterState: {
        name: dto.name,
        city: dto.city,
        countryCode: dto.countryCode,
      },
    });

    return {
      id: '',
      name: dto.name,
      city: dto.city ?? null,
      timezone: dto.timezone ?? 'Asia/Kolkata',
      isActive: true,
    };
  }

  /**
   * Updates an existing location.
   * TODO: update locations where id and tenant_id.
   */
  async updateLocation(
    locationId: string,
    tenantId: string,
    actorUserId: string,
    dto: UpdateLocationDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'location.updated',
      resourceType: 'location',
      resourceId: locationId,
      afterState: dto as Record<string, unknown>,
    });

    return { id: locationId, ...dto };
  }

  // ─── Designations ──────────────────────────────────────────────────────────

  /**
   * Lists tenant designations.
   * TODO: select from designations.
   */
  async listDesignations(tenantId: string) {
    return {
      data: [] as Array<{
        id: string;
        title: string;
        level: number | null;
        departmentId: string | null;
      }>,
      total: 0,
    };
  }

  /**
   * Creates a new designation.
   * TODO: insert into designations.
   */
  async createDesignation(
    tenantId: string,
    actorUserId: string,
    dto: CreateDesignationDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'designation.created',
      resourceType: 'designation',
      afterState: { title: dto.title, level: dto.level },
    });

    return {
      id: '',
      title: dto.title,
      level: dto.level ?? null,
      departmentId: dto.departmentId ?? null,
    };
  }

  // ─── Working hours ─────────────────────────────────────────────────────────

  /**
   * Returns the tenant's default working hours configuration.
   * TODO: select working_days, default_work_start, default_work_end, timezone from tenants.
   */
  async getWorkingHours(tenantId: string) {
    return {
      workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      startTime: '09:00',
      endTime: '18:00',
      timezone: 'Asia/Kolkata',
    };
  }

  /**
   * Updates tenant default working hours (admin only).
   * TODO: update tenants set working_days/default_work_start/default_work_end/timezone.
   */
  async updateWorkingHours(
    tenantId: string,
    actorUserId: string,
    dto: UpdateWorkingHoursDto,
  ) {
    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'tenant.working_hours.updated',
      resourceType: 'tenant',
      resourceId: tenantId,
      afterState: {
        workingDays: dto.workingDays,
        startTime: dto.startTime,
        endTime: dto.endTime,
        timezone: dto.timezone,
      },
    });

    return {
      workingDays: dto.workingDays,
      startTime: dto.startTime,
      endTime: dto.endTime,
      timezone: dto.timezone ?? 'Asia/Kolkata',
    };
  }
}
