import {
  BadRequestException,
  Body,
  CallHandler,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import type Redis from 'ioredis';
import type { Request, Response } from 'express';
import type { JwtPayload } from '@flicks/shared/types';
import { PmGrantGuard } from '../../core/auth/guards/pm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { FlagEvalService } from '../../core/flags/flag-eval.service';
import { REDIS_CLIENT } from '../../core/redis/redis.module';
import {
  PmFilesService,
  PM_FILE_MAX_BYTES,
  PM_FILES_PER_REQUEST,
  type PmFileKind,
  type PmFileObjectType,
} from './files.service';

class UploadFilesDto {
  @IsIn(['issue', 'comment', 'draft']) object_type!: PmFileObjectType;
  @IsUUID() object_id!: string;
  @IsOptional() @IsIn(['attachment', 'inline']) kind?: PmFileKind;
}

export const PM_UPLOADS_PER_MIN = 30;
/** Multer per-file cap sits just above the service's 25 MB so the service's message wins for the common case. */
const MULTER_FILE_BYTES = 26 * 1024 * 1024;
/** Whole-request ceiling checked on Content-Length BEFORE any part is buffered. */
const REQUEST_BYTES_CEILING = PM_FILES_PER_REQUEST * MULTER_FILE_BYTES + 1024 * 1024;

/**
 * Multer/busboy limit errors arrive as Nest exceptions whose text is the raw
 * multer message ("File too large", "Too many files", "Unexpected field").
 * Map them to the 413s + copy a person can act on; anything else passes.
 */
export function mapUploadError(err: unknown): unknown {
  if (!(err instanceof HttpException)) return err;
  const msg = String((err.getResponse() as { message?: string })?.message ?? err.message ?? '');
  if (/file too large/i.test(msg)) {
    return new PayloadTooLargeException(`One of the files is larger than 25 MB — attach files up to ${PM_FILE_MAX_BYTES / (1024 * 1024)} MB each.`);
  }
  if (/too many files|unexpected field/i.test(msg)) {
    return new PayloadTooLargeException(`Up to ${PM_FILES_PER_REQUEST} files per upload — send them in the "files" field.`);
  }
  if (/too many parts|too many fields|field value too long|field name too long/i.test(msg)) {
    return new BadRequestException('Upload form has too many fields.');
  }
  return err;
}

/**
 * Wraps Nest's FilesInterceptor so that (a) the kill-switch flag and the
 * whole-request size are checked BEFORE multer buffers up to 10 × 26 MiB,
 * and (b) multer's limit errors become readable 413s. Guards (auth, grant,
 * per-user throttle) have already run by the time an interceptor executes.
 */
@Injectable()
export class PmUploadInterceptor implements NestInterceptor {
  private readonly inner: NestInterceptor = new (FilesInterceptor('files', PM_FILES_PER_REQUEST, {
    limits: { fileSize: MULTER_FILE_BYTES, files: PM_FILES_PER_REQUEST, fields: 5, fieldSize: 256, parts: 16 },
  }))();

  constructor(private readonly flags: FlagEvalService) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const tenantId = req.user?.tenantId;
    if (tenantId && !(await this.flags.isEnabled('pm_attachments', tenantId))) {
      throw new BadRequestException({ code: 'ATTACHMENTS_DISABLED', message: 'Attachments are switched off for this workspace' });
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > REQUEST_BYTES_CEILING) {
      throw new PayloadTooLargeException(`That upload is too large — up to ${PM_FILES_PER_REQUEST} files of 25 MB each per request.`);
    }
    try {
      return await this.inner.intercept(context, next);
    } catch (err) {
      throw mapUploadError(err);
    }
  }
}

/**
 * Per-USER upload throttle (30/min) — mirrors PmSyncThrottleGuard: Redis
 * INCR/EXPIRE across processes, in-process window when Redis is unreachable.
 * The global ThrottlerGuard is IP-based, which would rate-limit a whole
 * office NAT together.
 */
@Injectable()
export class PmUploadThrottleGuard implements CanActivate {
  private readonly logger = new Logger(PmUploadThrottleGuard.name);
  private readonly local = new Map<string, { count: number; resetAt: number }>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user?: JwtPayload }>().user;
    if (!user?.tenantId) return true; // the auth guard rejects independently
    const key = `pm:upload:${user.tenantId}:${user.sub}`;
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 60);
    } catch {
      const now = Date.now();
      const slot = this.local.get(key);
      if (!slot || slot.resetAt < now) {
        this.local.set(key, { count: 1, resetAt: now + 60_000 });
        count = 1;
      } else {
        slot.count += 1;
        count = slot.count;
      }
    }
    if (count > PM_UPLOADS_PER_MIN) {
      this.logger.warn(`pm upload throttled user=${user.sub} count=${count}`);
      throw new HttpException(
        { code: 'RATE_LIMITED', message: `Upload rate limit: ${PM_UPLOADS_PER_MIN} uploads per minute` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

/**
 * Round L item 6 — PM attachments. Lives under the `pm` prefix so the guest
 * allowlist (GuestScopeGuard) applies and a guest may attach on the issues
 * of their invited projects; per-issue scoping is in PmFilesService.
 * Multipart, server-owned validation and keys (no client presigned PUTs).
 * The `pm_attachments` FAM flag is the kill-switch: off ⇒ uploads refuse
 * (existing files stay readable/removable).
 */
@ApiTags('pm')
@Controller('pm')
@UseGuards(PmGrantGuard)
export class PmFilesController {
  constructor(
    private readonly files: PmFilesService,
    private readonly flags: FlagEvalService,
  ) {}

  @Get('uploads/config')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'Attachment limits + whether storage is configured / the feature is on' })
  async config(@CurrentUser() user: JwtPayload) {
    return {
      data: {
        ...this.files.config(),
        enabled: await this.flags.isEnabled('pm_attachments', user.tenantId),
      },
    };
  }

  @Post('uploads')
  @RequireGrant('pm', 'edit')
  @UseGuards(PmUploadThrottleGuard)
  @UseInterceptors(PmUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload up to 10 files (≤25 MB each) onto an issue, a comment, or a draft' })
  async upload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UploadFilesDto,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    if (!files?.length) throw new BadRequestException('Attach at least one file as "files"');
    return this.files.upload(user.tenantId, user.sub, {
      objectType: dto.object_type,
      objectId: dto.object_id,
      kind: dto.kind ?? 'attachment',
      files: files.map((f) => ({ buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype, size: f.size })),
    });
  }

  @Get('issues/:id/files')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'Files of an issue and its comments (signed URLs, 1 h)' })
  listForIssue(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.files.listForIssue(user.tenantId, user.sub, id);
  }

  @Get('files/:id/url')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'JSON variant of the redirect: { data: { url } } — the web fetches this through the api client (silent refresh) and then navigates' })
  async url(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query('dl') dl: string | undefined) {
    const url = await this.files.signedUrlForRead(user.tenantId, user.sub, id, { download: dl === '1' || dl === 'true' });
    return { data: { url, expires_in: 15 * 60 } };
  }

  @Get('files/:id')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'Open a file — 302 to a 15-minute signed URL (?dl=1 downloads with the original name)' })
  async open(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('dl') dl: string | undefined,
    @Res() res: Response,
  ) {
    const url = await this.files.signedUrlForRead(user.tenantId, user.sub, id, {
      download: dl === '1' || dl === 'true',
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.redirect(302, url);
  }

  @Post('files/:id/delete')
  @RequireGrant('pm', 'edit')
  @ApiOperation({ summary: 'Remove a file (uploader or Owner/Admin) — soft delete' })
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.files.softDelete(user.tenantId, user.sub, id);
  }
}
