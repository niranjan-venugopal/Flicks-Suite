import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import * as FileType from 'file-type';
import { eq } from 'drizzle-orm';
import { users, tenants } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { R2Service } from '../../core/storage/r2.service';
import { AuditService } from '../audit/audit.service';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB (§4.1)
const MIN_DIM = 128;
const MAX_DIM = 4096;
const SIZES = [256, 64] as const;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface ProcessedMedia {
  key256: string;
  key64: string;
}

/**
 * Server-authoritative image pipeline (PRD v4 §4). The client uploads the
 * cropped square; the server judges the file by MAGIC BYTES (never the
 * extension or client MIME), rejects SVG outright (XSS surface), re-encodes
 * with sharp to WebP q80 at 256px + 64px (EXIF/polyglots stripped; logos keep
 * alpha), stores under private UUID-versioned R2 keys, and deletes the
 * previous objects on replace/remove.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly r2: R2Service,
    private readonly audit: AuditService,
  ) {}

  /** Validate by magic bytes + dimensions; returns the sharp pipeline input. */
  private async validate(buffer: Buffer): Promise<void> {
    if (!buffer?.length) throw new BadRequestException('Empty upload');
    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException('File is too large — maximum size is 8 MB.');
    }
    const kind = await FileType.fromBuffer(buffer);
    if (!kind || !ALLOWED_MIME.has(kind.mime)) {
      throw new BadRequestException(
        'That file type isn’t supported — upload a JPG, PNG or WebP. SVG files are not accepted.',
      );
    }
    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w < MIN_DIM || h < MIN_DIM) {
      throw new BadRequestException(
        `Image is too small — photos need to be at least ${MIN_DIM} × ${MIN_DIM} px.`,
      );
    }
    if (w > MAX_DIM || h > MAX_DIM) {
      throw new BadRequestException(
        `Image is too large — maximum ${MAX_DIM} px on a side.`,
      );
    }
  }

  /** Re-encode to WebP q80 at 256+64 and upload under the given prefix. */
  private async process(
    buffer: Buffer,
    prefix: string,
    keepAlpha: boolean,
  ): Promise<ProcessedMedia> {
    const id = randomUUID();
    const keys: Record<number, string> = {};
    for (const size of SIZES) {
      let pipe = sharp(buffer)
        .rotate() // honor EXIF orientation, then strip metadata by re-encode
        .resize(size, size, { fit: 'cover' });
      if (!keepAlpha) pipe = pipe.flatten({ background: '#ffffff' });
      const out = await pipe.webp({ quality: 80 }).toBuffer();
      const key = `${prefix}/${id}_${size}.webp`;
      await this.r2.putObject(key, out, 'image/webp', 'private, max-age=86400, immutable');
      keys[size] = key;
    }
    return { key256: keys[256], key64: keys[64] };
  }

  /** Both size variants for a stored 256 key. */
  private variants(key256: string): string[] {
    return [key256, key256.replace('_256.webp', '_64.webp')];
  }

  // ─── Avatars ───────────────────────────────────────────────────────────────

  async uploadAvatar(userId: string, tenantId: string, buffer: Buffer) {
    await this.validate(buffer);
    const [user] = await this.dbAdmin
      .select({ avatar_key: users.avatar_key })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const media = await this.process(buffer, `users/${userId}/avatar`, false);
    await this.dbAdmin
      .update(users)
      .set({ avatar_key: media.key256, avatar_updated_at: new Date() })
      .where(eq(users.id, userId));
    if (user?.avatar_key) await this.r2.deleteObjects(this.variants(user.avatar_key));
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'media.avatar_updated',
      resourceType: 'user',
      resourceId: userId,
    });
    return { data: { avatar_url: await this.r2.signedGetUrl(media.key256) } };
  }

  async removeAvatar(userId: string, tenantId: string) {
    const [user] = await this.dbAdmin
      .select({ avatar_key: users.avatar_key })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    await this.dbAdmin
      .update(users)
      .set({ avatar_key: null, avatar_url: null, avatar_updated_at: new Date() })
      .where(eq(users.id, userId));
    if (user?.avatar_key) await this.r2.deleteObjects(this.variants(user.avatar_key));
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'media.avatar_removed',
      resourceType: 'user',
      resourceId: userId,
    });
    return { data: { removed: true } };
  }

  // ─── Company logo (Owner/Admin) ────────────────────────────────────────────

  async uploadLogo(userId: string, tenantId: string, buffer: Buffer) {
    await this.validate(buffer);
    const [tenant] = await this.dbAdmin
      .select({ logo_key: tenants.logo_key })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    // Logos keep alpha (§4.1) — PNG/WebP transparency survives the re-encode.
    const media = await this.process(buffer, `tenants/${tenantId}/logo`, true);
    await this.dbAdmin
      .update(tenants)
      .set({ logo_key: media.key256, logo_updated_at: new Date() })
      .where(eq(tenants.id, tenantId));
    if (tenant?.logo_key) await this.r2.deleteObjects(this.variants(tenant.logo_key));
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'media.logo_updated',
      resourceType: 'tenant',
      resourceId: tenantId,
    });
    return { data: { logo_url: await this.r2.signedGetUrl(media.key256) } };
  }

  async removeLogo(userId: string, tenantId: string) {
    const [tenant] = await this.dbAdmin
      .select({ logo_key: tenants.logo_key })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    await this.dbAdmin
      .update(tenants)
      .set({ logo_key: null, logo_updated_at: new Date() })
      .where(eq(tenants.id, tenantId));
    if (tenant?.logo_key) await this.r2.deleteObjects(this.variants(tenant.logo_key));
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'media.logo_removed',
      resourceType: 'tenant',
      resourceId: tenantId,
    });
    return { data: { removed: true } };
  }

  // ─── Generic building blocks (round E — project logos live in the PM
  //     module, which owns its row write, sync refs and audit) ────────────────

  /** Validate + re-encode + upload under the prefix; caller owns the row. */
  async processImage(buffer: Buffer, prefix: string, keepAlpha = true): Promise<ProcessedMedia> {
    await this.validate(buffer);
    return this.process(buffer, prefix, keepAlpha);
  }

  /** Delete both stored variants of a 256 key (replace/remove flows). */
  async deleteImage(key256: string): Promise<void> {
    await this.r2.deleteObjects(this.variants(key256));
  }

  // ─── Signed-URL serialization helpers ──────────────────────────────────────

  /** Signed URL for a stored key, or the legacy URL fallback (§4/D6). */
  async servedUrl(
    key: string | null,
    legacyUrl: string | null,
    size: 256 | 64 = 256,
  ): Promise<string | null> {
    if (key && this.r2.isConfigured()) {
      const k = size === 64 ? key.replace('_256.webp', '_64.webp') : key;
      try {
        return await this.r2.signedGetUrl(k);
      } catch (err) {
        this.logger.warn(
          `signedGetUrl failed for ${k}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return legacyUrl;
  }
}
