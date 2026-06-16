import { Injectable, Logger, Inject } from '@nestjs/common';
import { eq, and, gte, lte, ilike, desc, sql } from 'drizzle-orm';
import { DB_TENANT, DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { auditLog, auditLogPlatform, users } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';

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

// Keys whose values must never be persisted in clear text inside audit
// before/after state or metadata (defence-in-depth — most of these are already
// encrypted columns, but DTO snapshots can carry raw values).
const SENSITIVE_KEY = /pan|account_number|bank_account|ifsc|swift|password|secret|token|otp|api[_-]?key|webhook|cvv|card_number/i;

/** Recursively mask sensitive string/number values, keeping the last 4 chars. */
function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        const s = String(v);
        out[k] = s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
      } else {
        out[k] = maskSensitive(v);
      }
    }
    return out;
  }
  return value;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly databaseService: DatabaseService,
  ) {}

  async log(dto: AuditLogDto): Promise<void> {
    try {
      // Audit rows live in a tenant-scoped table with RLS; write inside
      // a transaction with app.tenant_id set so the policy admits the row.
      // Coerce empty strings to null for nullable uuid columns.
      const nullIfEmpty = (v?: string) =>
        v === undefined || v === '' ? null : v;
      await this.databaseService.withTenant(dto.tenantId, (tx) =>
        tx.insert(auditLog).values({
          tenant_id: dto.tenantId,
          actor_user_id: nullIfEmpty(dto.actorUserId),
          actor_employee_id: nullIfEmpty(dto.actorEmployeeId),
          action: dto.action,
          resource_type: dto.resourceType,
          resource_id: nullIfEmpty(dto.resourceId),
          before_state: (maskSensitive(dto.beforeState) as Record<string, unknown>) ?? null,
          after_state: (maskSensitive(dto.afterState) as Record<string, unknown>) ?? null,
          ip_address: dto.ipAddress,
          user_agent: dto.userAgent,
          metadata: (maskSensitive(dto.metadata) as Record<string, unknown>) ?? null,
        }),
      );
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

    const [logs, totalRow] = await this.databaseService.withTenant(
      tenantId,
      async (tx) =>
        Promise.all([
          tx
            .select({
              id: auditLog.id,
              actorUserId: auditLog.actor_user_id,
              actorName: users.full_name,
              actorEmail: users.email,
              action: auditLog.action,
              resourceType: auditLog.resource_type,
              resourceId: auditLog.resource_id,
              beforeState: auditLog.before_state,
              afterState: auditLog.after_state,
              ipAddress: auditLog.ip_address,
              userAgent: auditLog.user_agent,
              createdAt: auditLog.created_at,
            })
            .from(auditLog)
            .leftJoin(users, eq(auditLog.actor_user_id, users.id))
            .where(and(...conditions))
            .orderBy(desc(auditLog.created_at))
            .limit(limit)
            .offset(offset),
          tx
            .select({ n: sql<number>`COUNT(*)::int` })
            .from(auditLog)
            .where(and(...conditions)),
        ]),
    );

    return {
      data: logs,
      pagination: {
        page,
        limit,
        total: Number(totalRow[0]?.n ?? 0),
      },
    };
  }
}
