import {
  BadRequestException,
  Body,
  Controller,
  Get,
  GoneException,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { PM_MUTATION_OPS, PM_MUTATE_BATCH_CAP } from '@flicks/shared/pm';
import { PmGrantGuard } from '../../../core/auth/guards/pm-grant.guard';
import { RequireGrant } from '../../../core/auth/decorators/require-grant.decorator';
import { CurrentUser } from '../../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { PmSyncService } from './sync.service';
import { PmMutationExecutor } from './mutation-executor.service';
import { FlagEvalService } from '../../../core/flags/flag-eval.service';

class MutationItemDto {
  @IsUUID() clientMutationId!: string;
  @IsIn(PM_MUTATION_OPS as unknown as string[]) op!: string;
  @IsUUID() id!: string;
  // Nested JSON — @Type(() => Object) required or the ValidationPipe rewrites
  // nested values to [] (house gotcha).
  @IsOptional() @IsObject() @Type(() => Object) fields?: Record<string, unknown>;
}

class MutateDto {
  @IsArray()
  @ArrayMaxSize(PM_MUTATE_BATCH_CAP)
  @ValidateNested({ each: true })
  @Type(() => MutationItemDto)
  items!: MutationItemDto[];
}

/**
 * FSE transport (PRD v6 §3.3–3.5). All three endpoints run behind the full
 * guard chain + PmGrantGuard; when the pm_sync_engine kill-switch is OFF they
 * refuse with 409 SYNC_DISABLED and the client falls back to plain REST.
 */
@ApiTags('pm-sync')
@Controller('pm/sync')
@UseGuards(PmGrantGuard)
export class PmSyncController {
  constructor(
    private readonly sync: PmSyncService,
    private readonly executor: PmMutationExecutor,
    private readonly flags: FlagEvalService,
  ) {}

  private async assertEngineOn(tenantId: string) {
    if (!(await this.flags.isEnabled('pm_sync_engine', tenantId))) {
      throw new BadRequestException({ code: 'SYNC_DISABLED', message: 'Sync engine is disabled for this workspace' });
    }
  }

  @Get('bootstrap')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'FSE bootstrap — instant models as NDJSON (§3.3)' })
  async bootstrap(@CurrentUser() user: JwtPayload, @Res() res: Response) {
    await this.assertEngineOn(user.tenantId);
    const lines = await this.sync.bootstrap(user.tenantId, user.sub);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.send(lines.join('\n'));
  }

  @Get('delta')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'FSE delta — row snapshots touched past the cursor (§3.4)' })
  async delta(@CurrentUser() user: JwtPayload, @Query('since') since?: string) {
    await this.assertEngineOn(user.tenantId);
    const cursor = Number(since ?? 0);
    if (!Number.isFinite(cursor) || cursor < 0) throw new BadRequestException('since must be a non-negative number');
    const result = await this.sync.delta(user.tenantId, user.sub, cursor);
    if ('reBootstrap' in result && result.reBootstrap) {
      throw new GoneException({ code: 'RE_BOOTSTRAP', latest_seq: result.latest_seq });
    }
    return result;
  }

  @Post('mutate')
  @RequireGrant('pm', 'edit')
  @Throttle({ medium: { ttl: 60_000, limit: 240 } }) // request-level; per-item guard lands Sprint 33
  @ApiOperation({ summary: 'FSE mutate — optimistic batch, idempotent, validated (§3.5)' })
  async mutate(@CurrentUser() user: JwtPayload, @Body() dto: MutateDto) {
    await this.assertEngineOn(user.tenantId);
    return this.executor.execute(user.tenantId, user.sub, dto.items as never);
  }
}
