import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { FeedbackService } from './feedback.service';

class SubmitFeedbackDto {
  @IsIn(['bug', 'idea', 'question', 'other'])
  category!: string;

  @IsString()
  @MaxLength(4000)
  message!: string;

  @IsOptional()
  @IsBoolean()
  contact_ok?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  page_path?: string;
}

class NpsRespondDto {
  @IsIn(['answer', 'snooze', 'dismiss'])
  action!: 'answer' | 'snooze' | 'dismiss';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  score?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

class FamFeedbackUpdateDto {
  @IsOptional()
  @IsIn(['new', 'triaged', 'resolved', 'closed'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  internal_note?: string;
}

/** Feedback + NPS endpoints (PRD v4 §7, D10-R–D13). */
@ApiTags('Feedback & NPS')
@ApiBearerAuth('access-token')
@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post('feedback')
  @Throttle({ long: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit in-app feedback (10/day)' })
  submit(@Body() dto: SubmitFeedbackDto, @CurrentUser() user: JwtPayload) {
    return this.feedback.submit(user.tenantId, user.sub, dto);
  }

  @Get('me/nps-eligibility')
  @ApiOperation({ summary: 'Should the NPS micro-card show? (§7.2 gates)' })
  eligibility(@CurrentUser() user: JwtPayload) {
    return this.feedback.eligibility(user.tenantId, user.sub);
  }

  @Post('me/nps')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Answer / snooze (14d) / dismiss (permanent) the NPS' })
  respond(@Body() dto: NpsRespondDto, @CurrentUser() user: JwtPayload) {
    return this.feedback.respond(user.tenantId, user.sub, dto);
  }

  // ─── FAM (D12/D13) ──────────────────────────────────────────────────────────

  @Get('fam/feedback')
  @Roles('fam')
  @ApiOperation({ summary: 'FAM feedback inbox (filters: category/status/tenant)' })
  famList(
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.feedback.famList({ category, status, tenantId });
  }

  @Patch('fam/feedback/:id')
  @Roles('fam')
  @ApiOperation({ summary: 'Update feedback status / internal note (audited)' })
  famUpdate(
    @Param('id') id: string,
    @Body() dto: FamFeedbackUpdateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.feedback.famUpdate(id, user.sub, dto);
  }

  @Get('fam/nps-summary')
  @Roles('fam')
  @ApiOperation({ summary: 'NPS tile: score + P/P/D distribution (D13)' })
  npsSummary() {
    return this.feedback.npsSummary();
  }
}
