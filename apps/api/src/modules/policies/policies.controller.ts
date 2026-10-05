import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { JwtPayload } from '@flicks/shared/types';
import { PoliciesGrantGuard } from '../../core/auth/guards/policies-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { BillingExempt } from '../../core/auth/decorators/billing-exempt.decorator';
import { PoliciesService } from './policies.service';
import { AcknowledgePolicyDto, CreatePolicyDto, PublishPolicyDto, UpdatePolicyDto } from './policies.dto';

// Same burst guard as media uploads: 5 per minute per IP.
const UPLOAD_THROTTLE = { long: { ttl: 60_000, limit: 5 } };
// Multer cap sits above the 10 MB rule so the service can answer with the
// friendly 400 instead of multer's generic "File too large".
const MULTER_LIMIT_BYTES = 11 * 1024 * 1024;

/**
 * Company policies (Round P R3) — all under /api/v1/policies.
 *
 * The class-level PoliciesGrantGuard enforces the FAM module toggle and
 * membership liveness on EVERY route; the management routes additionally
 * carry @RequireGrant('policies', 'view' | 'edit') (Owner/Admin by role,
 * anyone else via Settings → Access). The self-service routes (`pending`,
 * `me/history`, `:id`, `:id/acknowledge`) need only a live tenant member —
 * they are declared ABOVE the `:id` routes so Express never reads
 * "pending" as an id.
 */
@ApiTags('Policies')
@ApiBearerAuth('access-token')
@Controller('policies')
@UseGuards(PoliciesGrantGuard)
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  // ─── Management ────────────────────────────────────────────────────────────

  @Get()
  @RequireGrant('policies', 'view')
  @ApiOperation({ summary: 'All policies with signed / pending counts for the current version' })
  list(@CurrentUser() user: JwtPayload) {
    return this.policies.list(user.tenantId, user.sub);
  }

  @Post()
  @RequireGrant('policies', 'edit')
  @ApiOperation({ summary: 'Create a draft policy (rich text or PDF shell)' })
  @ApiResponse({ status: 201, description: '{ data: PolicyDetail }' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreatePolicyDto) {
    return this.policies.create(user.tenantId, user.sub, dto);
  }

  // ─── Self-service (declared above ":id") ──────────────────────────────────

  @Get('pending')
  @ApiOperation({
    summary: 'Policies I still have to agree to (published, required, applicable to my role, no ack for the current version), oldest first',
  })
  pending(@CurrentUser() user: JwtPayload) {
    return this.policies.pendingForUser(user.tenantId, user.sub);
  }

  @Get('me/history')
  @ApiOperation({ summary: 'Every policy version I acknowledged, newest first' })
  history(@CurrentUser() user: JwtPayload) {
    return this.policies.myHistory(user.tenantId, user.sub);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One policy — any status for a policies:view holder; published + applicable only for everyone else (else 404)',
  })
  get(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.policies.get(
      { userId: user.sub, tenantId: user.tenantId, membershipId: user.membershipId, role: user.role },
      id,
    );
  }

  @Patch(':id')
  @RequireGrant('policies', 'edit')
  @ApiOperation({ summary: 'Edit a policy (never moves the version — re-publish with the flag for that)' })
  update(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePolicyDto) {
    return this.policies.update(user.tenantId, user.sub, id, dto);
  }

  @Post(':id/file')
  @RequireGrant('policies', 'edit')
  @HttpCode(HttpStatus.OK)
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MULTER_LIMIT_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload / replace the policy PDF (magic-byte checked, ≤ 10 MB; 503 when storage is unconfigured)' })
  uploadFile(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file?.buffer) throw new BadRequestException('Attach the PDF as "file"');
    return this.policies.uploadFile(user.tenantId, user.sub, id, {
      buffer: file.buffer,
      originalname: file.originalname,
    });
  }

  @Post(':id/publish')
  @RequireGrant('policies', 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish (draft → published) or re-publish; { require_reacknowledgement: true } bumps the version so everyone agrees again',
  })
  @ApiResponse({ status: 200, description: '{ data: PolicyDetail, notified }' })
  @ApiResponse({ status: 400, description: 'Nothing to publish (no text / no PDF) or archived' })
  publish(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PublishPolicyDto) {
    return this.policies.publish(user.tenantId, user.sub, id, dto ?? {});
  }

  @Post(':id/archive')
  @RequireGrant('policies', 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive — disappears from everyone’s pending list; acknowledgements stay as history' })
  archive(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.policies.archive(user.tenantId, user.sub, id);
  }

  @Get(':id/acknowledgements')
  @RequireGrant('policies', 'view')
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  @ApiOperation({ summary: 'Who signed / who is pending for the current version (?format=csv for a download)' })
  async acknowledgements(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (format === 'csv') {
      const csv = await this.policies.acknowledgementsCsv(user.tenantId, id, user.sub);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="policy-acknowledgements.csv"');
      return csv;
    }
    return this.policies.acknowledgements(user.tenantId, id, user.sub);
  }

  @Post(':id/remind')
  @RequireGrant('policies', 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remind everyone still pending (in-app + email) — at most once per hour per policy' })
  @ApiResponse({ status: 200, description: '{ data: { reminded } }' })
  @ApiResponse({ status: 429, description: 'REMIND_TOO_SOON' })
  remind(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.policies.remind(user.tenantId, user.sub, id);
  }

  // Billing-exempt like consent writes: the gate must never trap a member of
  // a billing-locked workspace behind a policy they cannot agree to.
  @Post(':id/acknowledge')
  @BillingExempt()
  @ApiOperation({ summary: 'I have read and agree (idempotent; 409 POLICY_VERSION_STALE when the version moved)' })
  @ApiResponse({ status: 201, description: '{ data: { policy_id, version, acknowledged_at } }' })
  acknowledge(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcknowledgePolicyDto,
    @Req() req: Request,
  ) {
    return this.policies.acknowledge(user.tenantId, user.sub, id, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
