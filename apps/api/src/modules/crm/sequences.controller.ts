import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { SequencesService } from './sequences.service';

class CreateSequenceDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() send_window_start?: string;
  @IsOptional() @IsString() send_window_end?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsArray() steps!: Array<{ subject: string; body_html: string; wait_days?: number }>;
}

class EnrollDto {
  @IsString() person_id!: string;
  @IsOptional() @IsString() deal_id?: string;
}

/** Sequences (C10, §7.1): timed follow-up email with windows + exits. */
@ApiTags('crm-sequences')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class SequencesController {
  constructor(private readonly sequences: SequencesService) {}

  @Get('sequences')
  @RequireGrant('crm', 'view')
  list(@CurrentUser() user: JwtPayload) {
    return this.sequences.list(user.tenantId);
  }

  @Post('sequences')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Create a sequence with its steps (send window in its own timezone)' })
  create(@Body() dto: CreateSequenceDto, @CurrentUser() user: JwtPayload) {
    return this.sequences.create(user.tenantId, user.sub, dto);
  }

  @Get('sequences/:id/enrollments')
  @RequireGrant('crm', 'view')
  enrollments(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.sequences.listEnrollments(user.tenantId, id);
  }

  @Post('sequences/:id/enroll')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Enroll a contact (DNC-refused; one active enrollment per contact per sequence)' })
  enroll(@Param('id') id: string, @Body() dto: EnrollDto, @CurrentUser() user: JwtPayload) {
    return this.sequences.enroll(user.tenantId, user.sub, { sequence_id: id, ...dto });
  }

  @Post('enrollments/:id/exit')
  @RequireGrant('crm', 'edit')
  exit(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.sequences.exit(user.tenantId, user.sub, id);
  }
}
