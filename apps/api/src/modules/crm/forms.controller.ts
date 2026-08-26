import { Body, Controller, Delete, Get, Ip, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Public } from '../../core/auth/decorators/public.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { FormsService, type FormField } from './forms.service';

class CreateFormDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(500) intro?: string;
  @IsOptional() @IsArray() @Type(() => Object) fields?: FormField[];
  @IsOptional() @IsString() @MaxLength(40) source_tag?: string;
  @IsOptional() @IsIn(['none', 'round_robin']) assignment?: 'none' | 'round_robin';
  @IsOptional() @IsString() @MaxLength(300) success_message?: string;
  @IsOptional() @IsString() @MaxLength(500) redirect_url?: string;
}

class SetActiveDto {
  @IsBoolean() active!: boolean;
}

/** Web forms management (C13, §5.2). */
@ApiTags('crm-forms')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get('forms')
  @RequireGrant('crm', 'view')
  list(@CurrentUser() user: JwtPayload) {
    return this.forms.list(user.tenantId);
  }

  @Post('forms')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  @ApiOperation({ summary: 'Create a hosted lead-capture form (Manager and above)' })
  create(@Body() dto: CreateFormDto, @CurrentUser() user: JwtPayload) {
    return this.forms.create(user.tenantId, user.sub, dto);
  }

  @Patch('forms/:id/active')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  setActive(@Param('id') id: string, @Body() dto: SetActiveDto, @CurrentUser() user: JwtPayload) {
    return this.forms.setActive(user.tenantId, user.sub, id, dto.active);
  }

  @Delete('forms/:id')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager') // §13: delete = manager-and-up
  @ApiOperation({ summary: 'Delete a form (soft) — the public link dies, submissions and leads are kept' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.forms.remove(user.tenantId, user.sub, id);
  }

  @Get('forms/:id/submissions')
  @RequireGrant('crm', 'view')
  submissions(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.forms.submissions(user.tenantId, id);
  }
}

/**
 * The internet-facing capture endpoints behind /f/:token (§5.2). No auth —
 * the token scopes to one form; spam is handled by honeypot + min-fill-time
 * (silent drops) + a 10/hr/IP hard limit, and the endpoint throttle on top.
 */
@ApiExcludeController()
@Controller('public/forms')
export class PublicFormsController {
  constructor(private readonly forms: FormsService) {}

  @Get(':token')
  @Public()
  @Throttle({ medium: { ttl: 60_000, limit: 60 } })
  form(@Param('token') token: string) {
    return this.forms.publicForm(token);
  }

  @Post(':token/submit')
  @Public()
  @Throttle({ medium: { ttl: 60_000, limit: 20 } })
  submit(
    @Param('token') token: string,
    @Body() body: { values?: Record<string, string>; ts?: string; sig?: string; website?: string; utm?: Record<string, string> },
    @Ip() ip: string,
  ) {
    return this.forms.submit(token, body, ip);
  }
}
