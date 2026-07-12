import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { WebhooksService } from './webhooks.service';

class CreateWebhookDto {
  @IsUrl({ require_tld: false }) url!: string;
  @IsArray() @IsString({ each: true }) events!: string[];
}
class UpdateWebhookDto {
  @IsOptional() @IsUrl({ require_tld: false }) url?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) events?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
}

/** Outbound webhooks (PRD v5 §11/§13 — Owner/Admin only). */
@ApiTags('webhooks')
@Controller('webhooks/endpoints')
@Roles('owner', 'admin')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @ApiOperation({ summary: 'List webhook endpoints (secrets never included)' })
  list(@CurrentUser() user: JwtPayload) {
    return this.webhooks.list(user.tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a webhook endpoint — the secret is revealed ONCE' })
  create(@Body() dto: CreateWebhookDto, @CurrentUser() user: JwtPayload) {
    return this.webhooks.create(user.tenantId, user.sub, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update URL/events/active (re-enabling resets failure strikes)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.webhooks.update(user.tenantId, user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete (soft) a webhook endpoint' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.webhooks.remove(user.tenantId, user.sub, id);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Recent delivery log for one endpoint (C19)' })
  deliveries(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.webhooks.deliveries(user.tenantId, id);
  }
}
