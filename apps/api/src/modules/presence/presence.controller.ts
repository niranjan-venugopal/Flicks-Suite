import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import {
  PresenceService,
  MANUAL_STATUSES,
  type ManualStatus,
} from './presence.service';
import { PresenceGateway } from '../../gateways/presence.gateway';

class SetStatusDto {
  @IsIn(MANUAL_STATUSES)
  status!: ManualStatus;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  message?: string;

  /** ISO timestamp; omitted/null = Never clears. */
  @IsOptional()
  @IsISO8601()
  expires_at?: string;
}

/**
 * Presence & status API (PRD v4 §5). Writes are own-status only (RLS-backed);
 * reads are batched and tenant-scoped. Every write emits `presence.changed`
 * so the gateway re-broadcasts org-wide ≤5s.
 */
@ApiTags('Presence')
@ApiBearerAuth('access-token')
@Controller()
export class PresenceController {
  constructor(
    private readonly presence: PresenceService,
    private readonly gateway: PresenceGateway,
    private readonly events: EventEmitter2,
  ) {}

  @Put('me/status')
  @ApiOperation({ summary: 'Set my manual status (message ≤80, optional expiry)' })
  async setStatus(@Body() dto: SetStatusDto, @CurrentUser() user: JwtPayload) {
    const res = await this.presence.setStatus(user.tenantId, user.sub, dto);
    this.events.emit('presence.changed', {
      tenantId: user.tenantId,
      userId: user.sub,
      expiresAt: dto.expires_at ?? null,
    });
    return res;
  }

  @Delete('me/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset my status (auto states take over)' })
  async clearStatus(@CurrentUser() user: JwtPayload) {
    const res = await this.presence.clearStatus(user.tenantId, user.sub);
    this.events.emit('presence.changed', {
      tenantId: user.tenantId,
      userId: user.sub,
    });
    return res;
  }

  @Get('presence')
  @ApiOperation({ summary: 'Batched presence for userIds[] (tenant-scoped)' })
  async batch(
    @Query('userIds') userIds: string | string[] | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const ids = (Array.isArray(userIds) ? userIds : userIds ? [userIds] : [])
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 200);
    const resolved = await this.presence.resolve(
      user.tenantId,
      ids,
      await this.gateway.buildActivity(user.tenantId, ids),
    );
    return { data: resolved };
  }
}
