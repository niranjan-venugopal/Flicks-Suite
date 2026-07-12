import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { apiKeys } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { API_KEY_SCOPES, type ApiKeyScope } from '@flicks/shared/constants';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { AuditService } from '../audit/audit.service';

/**
 * Public-API keys (PRD v5 §11). Key = 'flk_live_' + 32 random bytes
 * (base64url). Only the SHA-256 hex ever hits the database; the display
 * prefix is the first 12 visible characters. The table is REVOKEd from the
 * app role — all access flows through here with explicit tenant scoping.
 */
const VALID_SCOPES = new Set<string>(API_KEY_SCOPES);
const MAX_KEYS = 10;

export interface ApiKeyContext {
  keyId: string;
  tenantId: string;
  scopes: ApiKeyScope[];
}

@Injectable()
export class ApiKeysService {
  /** last_used_at write throttle: keyId → epoch ms of last stamp. */
  private readonly lastUsedStamped = new Map<string, number>();

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly audit: AuditService,
  ) {}

  private hash(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  async list(tenantId: string) {
    const rows = await this.dbAdmin
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        key_prefix: apiKeys.key_prefix,
        scopes: apiKeys.scopes,
        last_used_at: apiKeys.last_used_at,
        revoked_at: apiKeys.revoked_at,
        created_at: apiKeys.created_at,
      })
      .from(apiKeys)
      .where(eq(apiKeys.tenant_id, tenantId))
      .orderBy(desc(apiKeys.created_at));
    return { data: rows };
  }

  async create(tenantId: string, userId: string, dto: { name: string; scopes: string[] }) {
    const scopes = [...new Set(dto.scopes ?? [])];
    if (!dto.name?.trim()) throw new BadRequestException('Name is required');
    if (scopes.length === 0) throw new BadRequestException('Select at least one scope');
    const unknown = scopes.filter((s) => !VALID_SCOPES.has(s));
    if (unknown.length) throw new BadRequestException(`Unknown scopes: ${unknown.join(', ')}`);

    const active = await this.dbAdmin
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, tenantId), isNull(apiKeys.revoked_at)));
    if (active.length >= MAX_KEYS) {
      throw new BadRequestException(`Limit: ${MAX_KEYS} active API keys per workspace`);
    }

    const rawKey = `flk_live_${randomBytes(32).toString('base64url')}`;
    const [row] = await this.dbAdmin
      .insert(apiKeys)
      .values({
        tenant_id: tenantId,
        name: dto.name.trim(),
        key_hash: this.hash(rawKey),
        key_prefix: `${rawKey.slice(0, 12)}…`,
        scopes,
        created_by: userId,
      })
      .returning({ id: apiKeys.id, key_prefix: apiKeys.key_prefix, created_at: apiKeys.created_at });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'api_keys.created',
      resourceType: 'api_key',
      resourceId: row!.id,
      metadata: { name: dto.name.trim(), scopes },
    });
    // The ONLY time the plaintext key leaves the server.
    return { data: { id: row!.id, name: dto.name.trim(), scopes, key: rawKey, key_prefix: row!.key_prefix, created_at: row!.created_at } };
  }

  async revoke(tenantId: string, userId: string, id: string) {
    const [row] = await this.dbAdmin
      .update(apiKeys)
      .set({ revoked_at: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.tenant_id, tenantId), isNull(apiKeys.revoked_at)))
      .returning({ id: apiKeys.id });
    if (!row) throw new NotFoundException('API key not found (or already revoked)');
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'api_keys.revoked',
      resourceType: 'api_key',
      resourceId: id,
    });
    return { data: { revoked: true } };
  }

  /** Bearer-key verification for the public API guard. Null = invalid. */
  async verify(rawKey: string): Promise<ApiKeyContext | null> {
    if (!rawKey?.startsWith('flk_live_')) return null;
    const [row] = await this.dbAdmin
      .select({
        id: apiKeys.id,
        tenant_id: apiKeys.tenant_id,
        scopes: apiKeys.scopes,
        revoked_at: apiKeys.revoked_at,
      })
      .from(apiKeys)
      .where(eq(apiKeys.key_hash, this.hash(rawKey)))
      .limit(1);
    if (!row || row.revoked_at) return null;

    // Stamp last_used_at at most once a minute per key (avoid hot-path writes).
    const now = Date.now();
    const last = this.lastUsedStamped.get(row.id) ?? 0;
    if (now - last > 60_000) {
      this.lastUsedStamped.set(row.id, now);
      void this.dbAdmin
        .update(apiKeys)
        .set({ last_used_at: new Date() })
        .where(eq(apiKeys.id, row.id))
        .then(() => undefined)
        .catch(() => undefined);
    }
    return { keyId: row.id, tenantId: row.tenant_id, scopes: row.scopes as ApiKeyContext['scopes'] };
  }
}
