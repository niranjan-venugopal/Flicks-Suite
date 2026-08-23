import {
  Injectable,
  Logger,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { stateCodeFromGstin } from '@flicks/shared/constants';
import { eq, and, asc, count, ne, sql } from 'drizzle-orm';
import {
  tenants,
  locations,
  departments,
  designations,
  employees,
  memberships,
  membershipGrants,
  users,
  shiftTemplates,
  employeeShifts,
  leaveTypes,
  leaveRequests,
  holidays,
} from '@flicks/db';
import {
  DB_TENANT,
  DB_SERVICE_ROLE,
} from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { MediaService } from '../media/media.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import type {
  CreateDepartmentDto,
  UpdateDepartmentDto,
  CreateLocationDto,
  UpdateLocationDto,
  UpdateWorkingHoursDto,
  CreateDesignationDto,
  UpdateDesignationDto,
  CreateShiftTemplateDto,
  UpdateShiftTemplateDto,
  CreateLeavePolicyDto,
  UpdateLeavePolicyDto,
  UpdateMemberRoleDto,
  UpdateOrganizationDto,
} from './settings.dto';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
    private readonly mediaService: MediaService,
    private readonly domainEvents: DomainEventsService,
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
      // Signed URL for the uploaded logo (logo_key), else the legacy URL (§4/D7)
      logoUrl: await this.mediaService.servedUrl(
        tenant.logo_key,
        tenant.logo_url,
      ),
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

    // GSTIN's first 2 digits are the NUMERIC GST state code — map it to the
    // two-letter abbreviation the UI uses (storing the raw digits left the
    // State field permanently on "Select…"). Unrecognised prefix → fall back
    // to whatever the caller supplied.
    const derivedStateCode = dto.gstin
      ? stateCodeFromGstin(dto.gstin) ?? dto.stateCode
      : dto.stateCode;

    const [updated] = await this.dbAdmin
      .update(tenants)
      .set({
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.legalName !== undefined && { legal_name: dto.legalName }),
        // '' clears an Indian statutory ID (global tenants) — store NULL.
        ...(dto.gstin !== undefined && { gstin: dto.gstin || null }),
        ...(dto.pan !== undefined && { pan: dto.pan || null }),
        ...(dto.cin !== undefined && { cin: dto.cin || null }),
        ...(dto.countryCode !== undefined && { country_code: dto.countryCode }),
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
    const stateCode = dto.stateCode ?? null;

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
        ...(dto.addressLine2 !== undefined && {
          address_line2: dto.addressLine2,
        }),
        ...(dto.city !== undefined && { city: dto.city }),
        // '' clears the state (country switches drop the old GST code)
        ...(dto.stateCode !== undefined && {
          state_code: dto.stateCode || null,
        }),
        ...(dto.countryCode !== undefined && {
          country_code: dto.countryCode,
        }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
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

  /**
   * Impact preview shown before deleting a location: how many employees
   * would need moving, how many location-specific holidays go with it, and
   * which locations can receive the employees (CRM §19.7 reassign pattern).
   */
  async locationDeletePreview(locationId: string, tenantId: string) {
    const [loc] = await this.dbAdmin
      .select({
        id: locations.id,
        name: locations.name,
        isActive: locations.is_active,
      })
      .from(locations)
      .where(
        and(eq(locations.id, locationId), eq(locations.tenant_id, tenantId)),
      )
      .limit(1);
    if (!loc) throw new NotFoundException('Location not found');

    // ALL statuses — inactive employees still reference the row.
    const [emp] = await this.dbAdmin
      .select({ value: count() })
      .from(employees)
      .where(
        and(
          eq(employees.tenant_id, tenantId),
          eq(employees.location_id, locationId),
        ),
      );
    const [hol] = await this.dbAdmin
      .select({ value: count() })
      .from(holidays)
      .where(
        and(
          eq(holidays.tenant_id, tenantId),
          eq(holidays.location_id, locationId),
        ),
      );
    const otherLocations = await this.dbAdmin
      .select({ id: locations.id, name: locations.name, city: locations.city })
      .from(locations)
      .where(
        and(
          eq(locations.tenant_id, tenantId),
          eq(locations.is_active, true),
          ne(locations.id, locationId),
        ),
      )
      .orderBy(asc(locations.name));

    return {
      id: loc.id,
      name: loc.name,
      isActive: loc.isActive,
      employees: emp?.value ?? 0,
      holidays: hol?.value ?? 0,
      otherLocations,
    };
  }

  /**
   * Guarded hard delete. Only deactivated locations are deletable; assigned
   * employees must be transferred to another active location as part of the
   * same transaction (they then follow the destination's holiday calendar
   * automatically — holidays are scoped by employees.location_id). The
   * location's own holidays are deleted explicitly: the FK is ON DELETE SET
   * NULL and a NULL location on a holiday means "company-wide", so leaving
   * them behind would silently grant them to everyone. Attendance punches
   * keep their rows (their location tag nulls — historical record intact).
   */
  async deleteLocation(
    locationId: string,
    tenantId: string,
    actorUserId: string,
    transferTo?: string,
  ) {
    const result = await this.dbAdmin.transaction(async (tx) => {
      const [loc] = await tx
        .select()
        .from(locations)
        .where(
          and(eq(locations.id, locationId), eq(locations.tenant_id, tenantId)),
        )
        .limit(1);
      if (!loc) throw new NotFoundException('Location not found');
      if (loc.is_active) {
        throw new ConflictException(
          'Deactivate the location before deleting it.',
        );
      }

      const [emp] = await tx
        .select({ value: count() })
        .from(employees)
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            eq(employees.location_id, locationId),
          ),
        );
      const assigned = emp?.value ?? 0;

      let movedEmployees = 0;
      if (assigned > 0) {
        if (!transferTo) {
          throw new ConflictException(
            `${assigned} employee${assigned === 1 ? ' is' : 's are'} assigned to this location. Choose a location to move them to first.`,
          );
        }
        if (transferTo === locationId) {
          throw new BadRequestException(
            'Pick a different location to receive the employees',
          );
        }
        const [target] = await tx
          .select({ id: locations.id, isActive: locations.is_active })
          .from(locations)
          .where(
            and(
              eq(locations.id, transferTo),
              eq(locations.tenant_id, tenantId),
            ),
          )
          .limit(1);
        if (!target || !target.isActive) {
          throw new BadRequestException(
            'transferTo must be an active location in this workspace',
          );
        }
        const moved = await tx
          .update(employees)
          .set({ location_id: transferTo, updated_at: new Date() })
          .where(
            and(
              eq(employees.tenant_id, tenantId),
              eq(employees.location_id, locationId),
            ),
          )
          .returning({ id: employees.id });
        movedEmployees = moved.length;
      }

      const deletedHolidays = await tx
        .delete(holidays)
        .where(
          and(
            eq(holidays.tenant_id, tenantId),
            eq(holidays.location_id, locationId),
          ),
        )
        .returning({ id: holidays.id });

      await tx
        .delete(locations)
        .where(
          and(eq(locations.id, locationId), eq(locations.tenant_id, tenantId)),
        );

      return {
        name: loc.name,
        movedEmployees,
        deletedHolidays: deletedHolidays.length,
      };
    });

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'location.deleted',
      resourceType: 'location',
      resourceId: locationId,
      beforeState: { name: result.name },
      afterState: {
        movedEmployees: result.movedEmployees,
        deletedHolidays: result.deletedHolidays,
        transferTo: transferTo ?? null,
      },
    });

    return {
      deleted: true,
      movedEmployees: result.movedEmployees,
      deletedHolidays: result.deletedHolidays,
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

  // ─── Working hours / shift templates ───────────────────────────────────────

  async listShifts(tenantId: string) {
    const rows = await this.dbAdmin
      .select({
        id: shiftTemplates.id,
        name: shiftTemplates.name,
        description: shiftTemplates.description,
        startTime: shiftTemplates.start_time,
        endTime: shiftTemplates.end_time,
        isOvernight: shiftTemplates.is_overnight,
        breakMinutes: shiftTemplates.break_minutes,
        breakPaid: shiftTemplates.break_paid,
        workingDays: shiftTemplates.working_days,
        timezone: shiftTemplates.timezone,
        gracePeriodMinutes: shiftTemplates.grace_period_minutes,
        halfDayThresholdMinutes: shiftTemplates.half_day_threshold_minutes,
        fullDayThresholdMinutes: shiftTemplates.full_day_threshold_minutes,
        isDefault: shiftTemplates.is_default,
        isActive: shiftTemplates.is_active,
        createdAt: shiftTemplates.created_at,
        // assigned headcount = unique employees with an effective shift mapping
        assigned: sql<number>`(
          SELECT COUNT(DISTINCT ${employeeShifts.employee_id})::int FROM ${employeeShifts}
          WHERE ${employeeShifts.tenant_id} = ${shiftTemplates.tenant_id}
            AND ${employeeShifts.shift_template_id} = ${shiftTemplates.id}
            AND (${employeeShifts.effective_to} IS NULL OR ${employeeShifts.effective_to} >= CURRENT_DATE)
        )`.as('assigned'),
      })
      .from(shiftTemplates)
      .where(eq(shiftTemplates.tenant_id, tenantId))
      .orderBy(asc(shiftTemplates.name));

    return { data: rows, total: rows.length };
  }

  async createShift(
    tenantId: string,
    actorUserId: string,
    dto: CreateShiftTemplateDto,
  ) {
    // Only one default shift per tenant. If this one's default, clear others.
    if (dto.isDefault) {
      await this.dbAdmin
        .update(shiftTemplates)
        .set({ is_default: false })
        .where(eq(shiftTemplates.tenant_id, tenantId));
    }

    const [row] = await this.dbAdmin
      .insert(shiftTemplates)
      .values({
        tenant_id: tenantId,
        name: dto.name,
        description: dto.description ?? null,
        start_time: dto.startTime,
        end_time: dto.endTime,
        is_overnight: dto.isOvernight ?? false,
        break_minutes: dto.breakMinutes ?? 60,
        break_paid: dto.breakPaid ?? false,
        working_days: dto.workingDays,
        timezone: dto.timezone ?? 'Asia/Kolkata',
        grace_period_minutes: dto.gracePeriodMinutes ?? 15,
        is_default: dto.isDefault ?? false,
      })
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'shift_template.created',
      resourceType: 'shift_template',
      resourceId: row.id,
      afterState: {
        name: row.name,
        startTime: row.start_time,
        endTime: row.end_time,
        workingDays: row.working_days,
      },
    });

    return { ...row, assigned: 0 };
  }

  async updateShift(
    shiftId: string,
    tenantId: string,
    actorUserId: string,
    dto: UpdateShiftTemplateDto,
  ) {
    const [before] = await this.dbAdmin
      .select()
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.id, shiftId),
          eq(shiftTemplates.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!before) {
      throw new NotFoundException('Shift template not found');
    }

    // Promoting to default clears default on all siblings first.
    if (dto.isDefault === true && !before.is_default) {
      await this.dbAdmin
        .update(shiftTemplates)
        .set({ is_default: false })
        .where(eq(shiftTemplates.tenant_id, tenantId));
    }

    const [after] = await this.dbAdmin
      .update(shiftTemplates)
      .set({
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.startTime !== undefined && { start_time: dto.startTime }),
        ...(dto.endTime !== undefined && { end_time: dto.endTime }),
        ...(dto.isOvernight !== undefined && { is_overnight: dto.isOvernight }),
        ...(dto.breakMinutes !== undefined && {
          break_minutes: dto.breakMinutes,
        }),
        ...(dto.breakPaid !== undefined && { break_paid: dto.breakPaid }),
        ...(dto.workingDays !== undefined && {
          working_days: dto.workingDays,
        }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        ...(dto.gracePeriodMinutes !== undefined && {
          grace_period_minutes: dto.gracePeriodMinutes,
        }),
        ...(dto.isDefault !== undefined && { is_default: dto.isDefault }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      })
      .where(
        and(
          eq(shiftTemplates.id, shiftId),
          eq(shiftTemplates.tenant_id, tenantId),
        ),
      )
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'shift_template.updated',
      resourceType: 'shift_template',
      resourceId: shiftId,
      beforeState: {
        name: before.name,
        startTime: before.start_time,
        endTime: before.end_time,
        isActive: before.is_active,
      },
      afterState: {
        name: after.name,
        startTime: after.start_time,
        endTime: after.end_time,
        isActive: after.is_active,
      },
    });

    return after;
  }

  // ─── Leave policies (leave_types CRUD) ─────────────────────────────────────

  async listLeavePolicies(tenantId: string) {
    const year = new Date().getFullYear();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    // 1. The policies themselves
    const policies = await this.dbAdmin
      .select({
        id: leaveTypes.id,
        name: leaveTypes.name,
        code: leaveTypes.code,
        description: leaveTypes.description,
        defaultQuotaDays: leaveTypes.default_quota_days,
        accrualMethod: leaveTypes.accrual_method,
        carryForwardAllowed: leaveTypes.carry_forward_allowed,
        maxCarryForwardDays: leaveTypes.max_carry_forward_days,
        encashable: leaveTypes.encashable,
        isPaid: leaveTypes.is_paid,
        isLop: leaveTypes.is_lop,
        allowHalfDay: leaveTypes.allow_half_day,
        minNoticeDays: leaveTypes.min_notice_days,
        color: leaveTypes.color,
        displayOrder: leaveTypes.display_order,
        isActive: leaveTypes.is_active,
      })
      .from(leaveTypes)
      .where(eq(leaveTypes.tenant_id, tenantId))
      .orderBy(asc(leaveTypes.display_order), asc(leaveTypes.name));

    // 2. YTD usage per leave type — separate query, grouped + cast to text
    // so we get a stable string in JSON (no float-precision surprises).
    const usageRows = await this.dbAdmin
      .select({
        leaveTypeId: leaveRequests.leave_type_id,
        used: sql<string>`SUM(${leaveRequests.total_days})::text`,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenant_id, tenantId),
          eq(leaveRequests.status, 'approved'),
          sql`${leaveRequests.start_date} >= ${yearStart}::date`,
          sql`${leaveRequests.start_date} <= ${yearEnd}::date`,
        ),
      )
      .groupBy(leaveRequests.leave_type_id);

    const usageByType = new Map(
      usageRows.map((r) => [r.leaveTypeId, Number(r.used) || 0]),
    );

    return {
      data: policies.map((p) => ({
        ...p,
        approvedYtd: usageByType.get(p.id) ?? 0,
      })),
      total: policies.length,
    };
  }

  async createLeavePolicy(
    tenantId: string,
    actorUserId: string,
    dto: CreateLeavePolicyDto,
  ) {
    try {
      const [row] = await this.dbAdmin
        .insert(leaveTypes)
        .values({
          tenant_id: tenantId,
          name: dto.name,
          code: dto.code,
          description: dto.description ?? null,
          default_quota_days: dto.defaultQuotaDays,
          accrual_method: dto.accrualMethod ?? 'none',
          carry_forward_allowed: dto.carryForwardAllowed ?? false,
          max_carry_forward_days: dto.maxCarryForwardDays ?? 0,
          encashable: dto.encashable ?? false,
          is_paid: dto.isPaid ?? true,
          is_lop: dto.isLop ?? false,
          allow_half_day: dto.allowHalfDay ?? true,
          min_notice_days: dto.minNoticeDays ?? 0,
          color: dto.color ?? '#3E7BFA',
        })
        .returning();

      await this.auditService.log({
        tenantId,
        actorUserId,
        action: 'leave_policy.created',
        resourceType: 'leave_type',
        resourceId: row.id,
        afterState: {
          name: row.name,
          code: row.code,
          defaultQuotaDays: row.default_quota_days,
        },
      });

      return { ...row, approvedYtd: 0 };
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictException(
          `A leave policy with code "${dto.code}" already exists.`,
        );
      }
      throw err;
    }
  }

  async updateLeavePolicy(
    policyId: string,
    tenantId: string,
    actorUserId: string,
    dto: UpdateLeavePolicyDto,
  ) {
    const [before] = await this.dbAdmin
      .select()
      .from(leaveTypes)
      .where(
        and(
          eq(leaveTypes.id, policyId),
          eq(leaveTypes.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!before) {
      throw new NotFoundException('Leave policy not found');
    }

    const [after] = await this.dbAdmin
      .update(leaveTypes)
      .set({
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.defaultQuotaDays !== undefined && {
          default_quota_days: dto.defaultQuotaDays,
        }),
        ...(dto.accrualMethod !== undefined && {
          accrual_method: dto.accrualMethod,
        }),
        ...(dto.carryForwardAllowed !== undefined && {
          carry_forward_allowed: dto.carryForwardAllowed,
        }),
        ...(dto.maxCarryForwardDays !== undefined && {
          max_carry_forward_days: dto.maxCarryForwardDays,
        }),
        ...(dto.encashable !== undefined && { encashable: dto.encashable }),
        ...(dto.isPaid !== undefined && { is_paid: dto.isPaid }),
        ...(dto.allowHalfDay !== undefined && {
          allow_half_day: dto.allowHalfDay,
        }),
        ...(dto.minNoticeDays !== undefined && {
          min_notice_days: dto.minNoticeDays,
        }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      })
      .where(
        and(
          eq(leaveTypes.id, policyId),
          eq(leaveTypes.tenant_id, tenantId),
        ),
      )
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'leave_policy.updated',
      resourceType: 'leave_type',
      resourceId: policyId,
      beforeState: {
        name: before.name,
        defaultQuotaDays: before.default_quota_days,
        isActive: before.is_active,
      },
      afterState: {
        name: after.name,
        defaultQuotaDays: after.default_quota_days,
        isActive: after.is_active,
      },
    });

    return after;
  }

  // ─── Members (memberships / workspace access) ──────────────────────────────

  async listMembers(tenantId: string) {
    const rows = await this.dbAdmin
      .select({
        id: memberships.id,
        userId: memberships.user_id,
        employeeId: memberships.employee_id,
        role: memberships.role,
        status: memberships.status,
        // Auditor metadata (Invoicing v3, PRD §3) — non-billable seat info.
        isExternal: memberships.is_external,
        accessExpiresAt: memberships.access_expires_at,
        invitedAt: memberships.invited_at,
        acceptedAt: memberships.accepted_at,
        createdAt: memberships.created_at,
        // user
        email: users.email,
        fullName: users.full_name,
        avatarUrl: users.avatar_url,
        // employee (optional — invited-but-not-onboarded users may not have one)
        employeeCode: employees.employee_code,
        firstName: employees.first_name,
        lastName: employees.last_name,
        departmentId: employees.department_id,
        departmentName: departments.name,
        designationTitle: designations.title,
      })
      .from(memberships)
      .leftJoin(users, eq(memberships.user_id, users.id))
      .leftJoin(employees, eq(memberships.employee_id, employees.id))
      .leftJoin(departments, eq(employees.department_id, departments.id))
      .leftJoin(designations, eq(employees.designation_id, designations.id))
      .where(eq(memberships.tenant_id, tenantId))
      .orderBy(asc(memberships.created_at));

    // Module grants per membership (drives the auditor "Granted scope" pills
    // on Settings → Members). One extra query, merged in memory.
    const grantRows = rows.length
      ? await this.dbAdmin
          .select({
            membershipId: membershipGrants.membership_id,
            module: membershipGrants.module,
            accessLevel: membershipGrants.access_level,
            capabilities: membershipGrants.capabilities,
          })
          .from(membershipGrants)
          .where(eq(membershipGrants.tenant_id, tenantId))
      : [];
    const grantsByMembership = new Map<string, typeof grantRows>();
    for (const g of grantRows) {
      const list = grantsByMembership.get(g.membershipId) ?? [];
      list.push(g);
      grantsByMembership.set(g.membershipId, list);
    }

    const data = rows.map((r) => ({
      ...r,
      grants: (grantsByMembership.get(r.id) ?? []).map((g) => ({
        module: g.module,
        access_level: g.accessLevel,
        capabilities: g.capabilities ?? {},
      })),
    }));

    return { data, total: data.length };
  }

  async updateMemberRole(
    membershipId: string,
    tenantId: string,
    actorUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const [before] = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!before) {
      throw new NotFoundException('Member not found');
    }

    // Safeguard: cannot demote the only Owner — every tenant needs at least one.
    if (before.role === 'owner' && dto.role !== 'owner') {
      const [{ value: ownerCount }] = await this.dbAdmin
        .select({ value: count() })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.role, 'owner'),
            eq(memberships.status, 'active'),
          ),
        );

      if (ownerCount <= 1) {
        throw new ConflictException(
          'Cannot demote the only Owner. Promote another member to Owner first.',
        );
      }
    }

    const [after] = await this.dbAdmin
      .update(memberships)
      .set({ role: dto.role })
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: 'membership.role_changed',
      resourceType: 'membership',
      resourceId: membershipId,
      beforeState: { role: before.role },
      afterState: { role: after.role },
    });

    return after;
  }

  async setMemberStatus(
    membershipId: string,
    tenantId: string,
    actorUserId: string,
    status: 'active' | 'deactivated',
  ) {
    const [before] = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .limit(1);

    if (!before) {
      throw new NotFoundException('Member not found');
    }

    if (status === 'deactivated' && before.role === 'owner') {
      const [{ value: ownerCount }] = await this.dbAdmin
        .select({ value: count() })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.role, 'owner'),
            eq(memberships.status, 'active'),
          ),
        );

      if (ownerCount <= 1) {
        throw new ConflictException(
          'Cannot deactivate the only Owner. Promote another member to Owner first.',
        );
      }
    }

    const [after] = await this.dbAdmin
      .update(memberships)
      .set({ status })
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenant_id, tenantId),
        ),
      )
      .returning();

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: status === 'deactivated' ? 'membership.deactivated' : 'membership.reactivated',
      resourceType: 'membership',
      resourceId: membershipId,
      beforeState: { status: before.status },
      afterState: { status: after.status },
    });

    if (status === 'deactivated') {
      // PRD v5 §19.7 — the CRM offboarding-reassign guard subscribes to this.
      await this.domainEvents.publish({
        name: 'member.deactivated',
        tenantId,
        actorUserId,
        payload: { membership_id: membershipId, user_id: after.user_id },
      });
    }

    return after;
  }
}
