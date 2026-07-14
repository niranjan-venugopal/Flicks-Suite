import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { CrmEmailService } from './email.service';

class SendEmailDto {
  @IsOptional() @IsString() deal_id?: string;
  @IsOptional() @IsString() person_id?: string;
  @IsOptional() @IsString() @MaxLength(320) to?: string;
  @IsString() @MaxLength(300) subject!: string;
  @IsString() @MaxLength(100_000) body_html!: string;
  @IsOptional() @IsString() template_id?: string;
  @IsOptional() @IsBoolean() tracking?: boolean;
}

class TemplateDto {
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(300) subject!: string;
  @IsString() @MaxLength(100_000) body_html!: string;
}

class SignatureDto {
  @IsOptional() @IsString() @MaxLength(10_000) signature?: string | null;
}

/** Email Phase A (§7.1): compose, thread, templates, signature, BCC address. */
@ApiTags('crm-email')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class CrmEmailController {
  constructor(private readonly email: CrmEmailService) {}

  @Post('emails')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Compose + send from a deal/contact (variables, signature, tracking, DNC-enforced)' })
  send(@Body() dto: SendEmailDto, @CurrentUser() user: JwtPayload) {
    return this.email.send(user.tenantId, user.sub, dto);
  }

  @Get('deals/:id/emails')
  @RequireGrant('crm', 'view')
  listForDeal(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.email.listForDeal(user.tenantId, id);
  }

  @Get('email-templates')
  @RequireGrant('crm', 'view')
  listTemplates(@CurrentUser() user: JwtPayload) {
    return this.email.listTemplates(user.tenantId);
  }

  @Post('email-templates')
  @RequireGrant('crm', 'edit')
  createTemplate(@Body() dto: TemplateDto, @CurrentUser() user: JwtPayload) {
    return this.email.createTemplate(user.tenantId, user.sub, dto);
  }

  @Get('me/signature')
  @RequireGrant('crm', 'view')
  getSignature(@CurrentUser() user: JwtPayload) {
    return this.email.getSignature(user.sub);
  }

  @Put('me/signature')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Per-user email signature (§19.4), appended to composed email' })
  setSignature(@Body() dto: SignatureDto, @CurrentUser() user: JwtPayload) {
    return this.email.setSignature(user.sub, dto.signature ?? null);
  }

  @Get('inbound-address')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'The tenant BCC dropbox address ({slug}-{token}@in.…)' })
  inboundAddress(@CurrentUser() user: JwtPayload) {
    return this.email.inboundAddress(user.tenantId);
  }
}
