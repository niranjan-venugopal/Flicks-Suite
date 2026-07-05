import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Cloudflare R2 storage (PRD v4 §10 — single storage backend). Thin S3 client
 * over the existing R2_* config; replaces the string-concat placeholder that
 * predated it. Degrades safely when unconfigured (local/CI): isConfigured()
 * is false and calls throw a clear 503, so features gate themselves.
 *
 * Conventions (free-tier optimized): private buckets only; per-user/tenant
 * prefixes; UUID-versioned keys; short-lived signed GET URLs (immutable
 * caching upstream); delete-on-replace to bound storage.
 */
@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const accountId = this.config.get<string>('R2_ACCOUNT_ID');
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY');
    this.bucket = this.config.get<string>('R2_BUCKET_NAME', 'flicks-suite-uploads');
    this.client =
      accountId && accessKeyId && secretAccessKey
        ? new S3Client({
            region: 'auto',
            endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId, secretAccessKey },
          })
        : null;
    if (!this.client) {
      this.logger.log('R2 not configured — storage features disabled (dev/CI)');
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  private assertConfigured(): S3Client {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'File storage is not configured on this server (R2_* env missing).',
      );
    }
    return this.client;
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<void> {
    const client = this.assertConfigured();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
      }),
    );
  }

  /** Presigned GET (default 24h). Keys are UUID-versioned → immutable-cacheable. */
  async signedGetUrl(key: string, ttlSeconds = 24 * 60 * 60): Promise<string> {
    const client = this.assertConfigured();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  async deleteObject(key: string): Promise<void> {
    const client = this.assertConfigured();
    await client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** Best-effort bulk delete (replace/remove flows); never throws. */
  async deleteObjects(keys: string[]): Promise<void> {
    if (!keys.length || !this.client) return;
    try {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `R2 bulk delete failed (continuing): ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /** List keys under a prefix with their ages — used by the exports prune job. */
  async listObjects(
    prefix: string,
  ): Promise<Array<{ key: string; lastModified?: Date }>> {
    const client = this.assertConfigured();
    const out: Array<{ key: string; lastModified?: Date }> = [];
    let token: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}
