import {
  Injectable,
  Logger,
  Inject,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { eq, and, asc, count, sql } from 'drizzle-orm';
import {
  tenants,
  locations,
  departments,
  designations,
  employees,
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
  UpdateDesignationDto,
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

  async listDepartments(tenantId: string) {
    const rows = await this.dbAdmin
      .select({
        id: departments.id,
        name: departments.name,
        code: departments.code,
        parentId: departments.parent_id,
        headEmployeeId: departments.head_employee_id,
        description: departments.description,
        isActive: departments.is_active,
        createdAt: departments.created_at,
        // headcount = active employees in this department
        headcount: sql<number>`(
          SELECT COUNT(*)::int FROM ${employees}
          WHERE ${employees.tenant_id} = ${departments.tenant_id}
            AND ${employees.department_id} = ${departments.id}
            AND ${employees.status} = 'active'
        )`.as('headcount'),
      })
      .from(departments)
      .where(eq(departments.tenant_id, tenantId))
      .orderBy(asc(departments.name));

    return { data: rows, total: rows.length };
  }

  async createDepartment(
    tenantId: string,
    actorUserId: string,
    dto: CreateDepartmentDto,
  ) {
    try {
      const [row] = await this.dbAdmin
        .insert(departments)
        .values({
          tenant_id: tenantId,
          name: dto.name,
          code: dto.code ?? null,
          parent_id: dto.parentId ?? null,
          head_employee_id: dto.headEmployeeId ?? null,
          description: dto.description ?? null,
        })
        .returning();

      await this.auditService.log({
        tenantId,
        actorUserId,
        action: 'department.created',
        resourceType: 'department',
        resourceId: row.id,
        afterState: {
          name: row.name,
          code: row.code,
          parentId: row.parent_id,
          headEmployeeId: row.head_employee_id,
        },
      });

      return {
        id: row.id,
        name: row.name,
        code: row.code,
        parentId: row.parent_id,
        headEmployeeId: row.head_employee_id,
        description: row.description,
        isActive: row.is_active,
        createdAt: row.created_at,
        headcount: 0,
      };
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictException(
          `A department named "${dto.name}" already exists.`,
        );
      }
      throw err;
    }
  }

  async updateDepartment(
    departmentId: string,
    tenantId: string,
    actorUserId: string,
    dto: UpdateDepartmentDto,
  ) {
    const [before] = await this.dbAdmin
      .select()
      .from(departments)
      .where(
        and(
          eq(departments.id, departmentId),
          eq(departments.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!before) {
      throw new NotFoundException('Department not found');
    }

    try {
      const [after] = await this.dbAdmin
        .update(departments)
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.headEmployeeId !== undefined && {
            head_employee_id: dto.headEmployeeId,
          }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.isActive !== undefined && { is_active: dto.isActive }),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(departments.id, departmentId),
            eq(departments.tenant_id, tenantId),
          ),
        )
        .returning();

      await this.auditService.log({
        tenantId,
        actorUserId,
        action: 'department.updated',
        resourceType: 'department',
        resourceId: departmentId,
        beforeState: {
          name: before.name,
          isActive: before.is_active,
          headEmployeeId: before.head_employee_id,
        },
        afterState: {
          name: after.name,
          isActive: after.is_active,
          headEmployeeId: after.head_employee_id,
        },
      });

      return {
        id: after.id,
        name: after.name,
        code: after.code,
        parentId: after.parent_id,
        headEmployeeId: after.head_employee_id,
        description: after.description,
        isActive: after.is_active,
      };
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictException(
          `A department named "${dto.name}" already exists.`,
        );
      }
      throw err;
    }
  }

  // ─── Locations ─────────────────────────────────────────────────────────────

  async listLocations(tenantId: string) {
    const rows = await this.dbAdmin
      .select({
        id: locations.id,
        name: locations.name,
        addressLine1: locations.address_line1,
        addressLine2: locations.address_line2,
        city: locations.city,
        stateCode: locations.state_code,
        postalCode: locations.postal_code,
        countryCode: locations.country_code,
        timezone: locations.timezone,
        geofenceLat: locations.geofence_lat,
        geofenceLng: locations.geofence_lng,
        geofenceRadiusM: locations.geofence_radius_m,
        ipAllowlist: locations.ip_allowlist,
        isActive: locations.is_active,
        createdAt: locations.created_at,
        headcount: sql<number>`(
          SELECT COUNT(*)::int FROM ${employees}
          WHERE ${employees.tenant_id} = ${locations.tenant_id}
            AND ${employees.location_id} = ${locations.id}
            AND ${employees.status} = 'active'
        )`.as('headcount'),
      })
      .from(locations)
      .where(eq(locations.tenant_id, tenantId))
      .orderBy(asc(locations.name));

    return { data: rows, total: rows.length };
  }

  async createLocation(
    tenantId: string,
    actorUserId: string,
    dto: CreateLocationDto,
  ) {
    const stateCode =
      dto.stateCode ?? (dto.countryCode === 'IN' ? null : null);

    const [row] = await this.dbAdmin
      .insert(locations)
      .values({
        tenant_id: tenantId,
        name: dto.name,
        address_line1: dto.addressLine1 ?? null,
        address_line2: dto.addressLine2 ?? null,
        city: dto.city ?? null,
        state_code: stateCode,
        postal_code: dto.postalCode ?? null,
        country_code: dto.countryCode ?? 'IN',
        timezone: dto.timezone ?? 'Asia/Kolkata',
        geofence_lat: dto.geofenceLat ?? null,
        geofence_lng: dto.geofenceLng ?? null,
        geofence_radius_m: dto.geofenceRadiusM ?? null,
        ip_allowlist: dto.ipAllowlist ?? null,
      })
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'location.created',
      resourceType: 'location',
      resourceId: row.id,
      afterState: {
        name: row.name,
        city: row.city,
        countryCode: row.country_code,
      },
    });

    return {
      id: row.id,
      name: row.name,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      stateCode: row.state_code,
      postalCode: row.postal_code,
      countryCode: row.country_code,
      timezone: row.timezone,
      geofenceLat: row.geofence_lat,
      geofenceLng: row.geofence_lng,
      geofenceRadiusM: row.geofence_radius_m,
      ipAllowlist: row.ip_allowlist,
      isActive: row.is_active,
      createdAt: row.created_at,
      headcount: 0,
    };
  }

  async updateLocation(
    locationId: string,
    tenantId: string,
    actorUserId: string,
    dto: UpdateLocationDto,
  ) {
    const [before] = await this.dbAdmin
      .select()
      .from(locations)
      .where(
        and(eq(locations.id, locationId), eq(locations.tenant_id, tenantId)),
      )
      .limit(1);

    if (!before) {
      throw new NotFoundException('Location not found');
    }

    const [after] = await this.dbAdmin
      .update(locations)
      .set({
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.addressLine1 !== undefined && {
          address_line1: dto.addressLine1,
        }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(dto.postalCode !== undefined && { postal_code: dto.postalCode }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      })
      .where(
        and(eq(locations.id, locationId), eq(locations.tenant_id, tenantId)),
      )
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'location.updated',
      resourceType: 'location',
      resourceId: locationId,
      beforeState: {
        name: before.name,
        city: before.city,
        isActive: before.is_active,
      },
      afterState: {
        name: after.name,
        city: after.city,
        isActive: after.is_active,
      },
    });

    return {
      id: after.id,
      name: after.name,
      city: after.city,
      timezone: after.timezone,
      isActive: after.is_active,
    };
  }

  // ─── Designations ──────────────────────────────────────────────────────────

  async listDesignations(tenantId: string) {
    const rows = await this.dbAdmin
      .select({
        id: designations.id,
        title: designations.title,
        level: designations.level,
        departmentId: designations.department_id,
        departmentName: departments.name,
        isActive: designations.is_active,
        createdAt: designations.created_at,
        headcount: sql<number>`(
          SELECT COUNT(*)::int FROM ${employees}
          WHERE ${employees.tenant_id} = ${designations.tenant_id}
            AND ${employees.designation_id} = ${designations.id}
            AND ${employees.status} = 'active'
        )`.as('headcount'),
      })
      .from(designations)
      .leftJoin(departments, eq(designations.department_id, departments.id))
      .where(eq(designations.tenant_id, tenantId))
      .orderBy(asc(designations.level), asc(designations.title));

    return { data: rows, total: rows.length };
  }

  async createDesignation(
    tenantId: string,
    actorUserId: string,
    dto: CreateDesignationDto,
  ) {
    const [row] = await this.dbAdmin
      .insert(designations)
      .values({
        tenant_id: tenantId,
        title: dto.title,
        level: dto.level ?? null,
        department_id: dto.departmentId ?? null,
      })
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'designation.created',
      resourceType: 'designation',
      resourceId: row.id,
      afterState: {
        title: row.title,
        level: row.level,
        departmentId: row.department_id,
      },
    });

    return {
      id: row.id,
      title: row.title,
      level: row.level,
      departmentId: row.department_id,
      isActive: row.is_active,
      createdAt: row.created_at,
      headcount: 0,
    };
  }

  async updateDesignation(
    designationId: string,
    tenantId: string,
    actorUserId: string,
    dto: UpdateDesignationDto,
  ) {
    const [before] = await this.dbAdmin
      .select()
      .from(designations)
      .where(
        and(
          eq(designations.id, designationId),
          eq(designations.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!before) {
      throw new NotFoundException('Designation not found');
    }

    const [after] = await this.dbAdmin
      .update(designations)
      .set({
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.level !== undefined && { level: dto.level }),
        ...(dto.departmentId !== undefined && {
          department_id: dto.departmentId,
        }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      })
      .where(
        and(
          eq(designations.id, designationId),
          eq(designations.tenant_id, tenantId),
        ),
      )
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'designation.updated',
      resourceType: 'designation',
      resourceId: designationId,
      beforeState: {
        title: before.title,
        level: before.level,
        isActive: before.is_active,
      },
      afterState: {
        title: after.title,
        level: after.level,
        isActive: after.is_active,
      },
    });

    return {
      id: after.id,
      title: after.title,
      level: after.level,
      departmentId: after.department_id,
      isActive: after.is_active,
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
