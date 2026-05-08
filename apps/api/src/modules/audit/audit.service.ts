import { Injectable, Logger, Inject } from '@nestjs/common';
import { eq, and, gte, lte, ilike, desc } from 'drizzle-orm';
import { DB_TENANT, DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { auditLog, auditLogPlatform } from '@flicks/db/schema';

export interface AuditLogDto {
  tenantId: string;
  actorUserId?: string;
  actorEmployeeId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformAuditLogDto {
  actorUserId?: string;
  action: string;
  targetTenantId?: string;
  targetUserId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditSearchFilters {
  resourceType?: string;
  action?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
  ) {}

  async log(dto: AuditLogDto): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        tenant_id: dto.tenantId,
        actor_user_id: dto.actorUserId,
        actor_employee_id: dto.actorEmployeeId,
        action: dto.action,
        resource_type: dto.resourceType,
        resource_id: dto.resourceId,
        before_state: dto.beforeState ?? null,
        after_state: dto.afterState ?? null,
        ip_address: dto.ipAddress,
        user_agent: dto.userAgent,
        metadata: dto.metadata ?? null,
      });
    } catch (err) {
      this.logger.warn('Failed to write audit log:', err);
    }
  }

  async logPlatform(dto: PlatformAuditLogDto): Promise<void> {
    try {
      await this.dbAdmin.insert(auditLogPlatform).values({
        actor_user_id: dto.actorUserId,
        action: dto.action,
        target_tenant_id: dto.targetTenantId,
        target_user_id: dto.targetUserId,
        metadata: dto.metadata ?? null,
        ip_address: dto.ipAddress,
        user_agent: dto.userAgent,
      });
    } catch (err) {
      this.logger.warn('Failed to write platform audit log:', err);
    }
  }

  async search(
    tenantId: string,
    filters: AuditSearchFilters,
  ) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = (page - 1) * limit;

    const conditions = [eq(auditLog.tenant_id, tenantId)];

    if (filters.resourceType) {
      conditions.push(eq(auditLog.resource_type, filters.resourceType));
    }
    if (filters.action) {
      conditions.push(eq(auditLog.action, filters.action));
    }
    if (filters.actorUserId) {
      conditions.push(eq(auditLog.actor_user_id, filters.actorUserId));
    }
    if (filters.from) {
      conditions.push(gte(auditLog.created_at, filters.from));
    }
    if (filters.to) {
      conditions.push(lte(auditLog.created_at, filters.to));
    }

    const [logs, countResult] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.created_at))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: auditLog.id })
        .from(auditLog)
        .where(and(...conditions)),
    ]);

    return {
      data: logs,
      pagination: {
        page,
        limit,
        total: countResult.length,
      },
    };
  }
}
