import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { AnalyticsService } from '../../core/analytics/analytics.service';
import { ConsentService } from '../consent/consent.service';

// §6: client capture is allow-listed to behavioral events only.
const CLIENT_EVENTS = ['module_opened'] as const;
const ALLOWED_MODULES = [
  'dashboard',
  'attendance',
  'leave',
  'timesheets',
  'employees',
  'invoicing',
  'reports',
  'settings',
  'inbox',
  'calendar',
] as const;

class ClientEventDto {
  @IsIn(CLIENT_EVENTS)
  event!: (typeof CLIENT_EVENTS)[number];

  @IsOptional()
  @IsObject()
  @Type(() => Object)
  properties?: Record<string, unknown>;
}

class ClientEventsBatchDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ClientEventDto)
  events!: ClientEventDto[];
}

/**
 * Client behavioral capture (PRD v4 §6). Server-enforced consent gate: events
 * are accepted ONLY while the latest `analytics` consent is granted (5-min
 * in-memory cache — Redis stays idle in beta). Schema-validated, allow-listed,
 * ≤20/batch + 60/min throttle. Server/job events never pass through here.
 */
@ApiTags('Analytics')
@ApiBearerAuth('access-token')
@Controller('events')
export class EventsController {
  private readonly consentCache = new Map<string, { granted: boolean; at: number }>();

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly consent: ConsentService,
  ) {}

  private async analyticsGranted(userId: string): Promise<boolean> {
    const cached = this.consentCache.get(userId);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.granted;
    const granted = await this.consent.analyticsGranted(userId);
    this.consentCache.set(userId, { granted, at: Date.now() });
    return granted;
  }

  @Post()
  @Throttle({ long: { ttl: 60_000, limit: 60 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Batched client events (consent-gated, allow-listed)' })
  async ingest(@Body() dto: ClientEventsBatchDto, @CurrentUser() user: JwtPayload) {
    if (!(await this.analyticsGranted(user.sub))) {
      throw new ForbiddenException('Analytics consent not granted');
    }
    let accepted = 0;
    for (const e of dto.events) {
      // Property schema: module must come from the fixed map; everything else
      // is dropped (ids/enums only — never PII or free text).
      const module = String(e.properties?.['module'] ?? '');
      if (
        e.event === 'module_opened' &&
        (ALLOWED_MODULES as readonly string[]).includes(module)
      ) {
        this.analytics.track({
          event: 'module_opened',
          tenantId: user.tenantId,
          userId: user.sub,
          source: 'web',
          properties: { module },
        });
        accepted += 1;
      }
    }
    return { data: { accepted, dropped: dto.events.length - accepted } };
  }
}
