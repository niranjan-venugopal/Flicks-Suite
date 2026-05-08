import { Injectable, Logger, Inject } from '@nestjs/common';
import { DB_TENANT } from '../../core/database/database.module';
import type { Db } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import type {
  CreateDepartmentDto,
  UpdateDepartmentDto,
  CreateLocationDto,
  UpdateLocationDto,
  UpdateWorkingHoursDto,
  CreateDesignationDto,
} from './settings.dto';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    private readonly auditService: AuditService,
  ) {}

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
