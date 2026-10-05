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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { JwtPayload } from '@flicks/shared/types';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { AssetsService } from './assets.service';
import {
  AssignAssetDto,
  CreateAssetDto,
  ListAssetsQueryDto,
  ReturnAssetDto,
  UpdateAssetDto,
} from './assets.dto';

// 10 photo uploads per minute per IP — twice the avatar burst, HR registers
// a batch of laptops in one sitting.
const PHOTO_THROTTLE = { long: { ttl: 60_000, limit: 10 } };
// Multer cap sits above the 8 MB media rule so MediaService answers with its
// friendly 400 instead of multer's generic "File too large".
const PHOTO_MULTER_LIMIT_BYTES = 9 * 1024 * 1024;

/**
 * Company asset register (Round P R4) — all under /api/v1/assets.
 *
 * Management routes are @Roles('admin') (the RolesGuard hierarchy admits
 * owner ≥ admin; platform admins bypass). The self-service routes — `me` and
 * `:id/acknowledge` — need only an authenticated tenant member: JwtAuthGuard
 * verifies the token, and the service resolves the caller through a LIVE
 * membership (active, not expired) inside the transaction. The static paths
 * (`summary`, `next-tag`, `export.csv`, `me`, `by-employee/:employeeId`) are
 * declared ABOVE the `:id` routes so Express never reads them as an id.
 */
@ApiTags('Assets')
@ApiBearerAuth('access-token')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  // ─── Register (admin) ──────────────────────────────────────────────────────

  @Get()
  @Roles('admin')
  @ApiOperation({
    summary: 'The register — live rows, assigned first then by tag; ?status&category&employee_id&q&limit&offset',
  })
  @ApiResponse({ status: 200, description: '{ data: Asset[], total }' })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListAssetsQueryDto) {
    return this.assets.list(user.tenantId, query, user.sub);
  }

  @Get('summary')
  @Roles('admin')
  @ApiOperation({ summary: 'Counts by status + open assignments awaiting acknowledgement' })
  summary(@CurrentUser() user: JwtPayload) {
    return this.assets.summary(user.tenantId, user.sub);
  }

  @Get('next-tag')
  @Roles('admin')
  @ApiOperation({ summary: 'Next free AST-NNNN (over every tag ever used, deleted rows included)' })
  nextTag(@CurrentUser() user: JwtPayload) {
    return this.assets.nextTag(user.tenantId, user.sub);
  }

  @Get('export.csv')
  @Roles('admin')
  @ApiOperation({ summary: 'The whole register as CSV (UTF-8 BOM, formula-safe)' })
  async exportCsv(@CurrentUser() user: JwtPayload, @Res({ passthrough: true }) res: Response) {
    const csv = await this.assets.exportCsv(user.tenantId, user.sub);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="assets-${day}.csv"`);
    return csv;
  }

  // ─── Self-service (declared above ":id") ──────────────────────────────────

  @Get('me')
  @ApiOperation({ summary: 'What I currently hold (any member; seats without an employee record get [])' })
  @ApiResponse({ status: 200, description: '{ data: MyAsset[] }' })
  me(@CurrentUser() user: JwtPayload) {
    return this.assets.myAssets(user.tenantId, user.sub);
  }

  @Get('by-employee/:employeeId')
  @Roles('admin')
  @ApiOperation({ summary: 'One employee: what they hold now + what they returned (newest first)' })
  @ApiResponse({ status: 404, description: 'Employee not in this tenant' })
  byEmployee(@CurrentUser() user: JwtPayload, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.assets.byEmployee(user.tenantId, employeeId, user.sub);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Register a piece of equipment (blank asset_tag → next AST-NNNN)' })
  @ApiResponse({ status: 201, description: '{ data: Asset }' })
  @ApiResponse({ status: 409, description: 'ASSET_TAG_TAKEN' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateAssetDto) {
    return this.assets.create(user.tenantId, user.sub, dto);
  }

  // ─── One asset ─────────────────────────────────────────────────────────────

  @Get(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'One asset with its full assignment history' })
  @ApiResponse({ status: 200, description: '{ data: AssetDetail }' })
  get(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.get(user.tenantId, id, user.sub);
  }

  @Patch(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Edit the entry; status moves only while nobody holds it (409 ASSET_ASSIGNED)' })
  @ApiResponse({ status: 409, description: 'ASSET_ASSIGNED | ASSET_TAG_TAKEN' })
  update(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssetDto) {
    return this.assets.update(user.tenantId, user.sub, id, dto);
  }

  @Post(':id/photo')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @Throttle(PHOTO_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: PHOTO_MULTER_LIMIT_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload / replace the photo (JPG/PNG/WebP ≤ 8 MB, re-encoded to 256 + 64 px; 503 when storage is unconfigured)' })
  uploadPhoto(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file?.buffer) throw new BadRequestException('Attach the photo as "file"');
    return this.assets.uploadPhoto(user.tenantId, user.sub, id, file.buffer);
  }

  @Post(':id/photo/remove')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the photo' })
  removePhoto(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.removePhoto(user.tenantId, user.sub, id);
  }

  @Post(':id/assign')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hand the asset to an employee (in-app + email nudge to acknowledge)' })
  @ApiResponse({ status: 400, description: 'The person has left the company' })
  @ApiResponse({ status: 409, description: 'ASSET_ALREADY_ASSIGNED | ASSET_UNAVAILABLE' })
  assign(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignAssetDto) {
    return this.assets.assign(user.tenantId, user.sub, id, dto);
  }

  @Post(':id/return')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record the return (condition it came back in; next status defaults to In stock)' })
  @ApiResponse({ status: 409, description: 'ASSET_NOT_ASSIGNED' })
  returnAsset(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnAssetDto) {
    return this.assets.returnAsset(user.tenantId, user.sub, id, dto);
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'I received this (holder only; idempotent)' })
  @ApiResponse({ status: 200, description: '{ data: { asset_id, acknowledged_at } }' })
  @ApiResponse({ status: 403, description: 'Not the holder' })
  acknowledge(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.acknowledge(user.tenantId, user.sub, id);
  }

  @Post(':id/delete')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (the tag becomes reusable); 409 ASSET_ASSIGNED while somebody holds it' })
  remove(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.remove(user.tenantId, user.sub, id);
  }
}
