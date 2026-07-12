import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { ApiKeysService } from './api-keys.service';

class CreateApiKeyDto {
  @IsString() name!: string;
  @IsArray() @IsString({ each: true }) scopes!: string[];
}

/** Settings → API keys (C19; PRD §13 — Owner/Admin only). */
@ApiTags('api-keys')
@Controller('api-keys')
@Roles('owner', 'admin')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @ApiOperation({ summary: 'List API keys (prefix + usage only — never the key)' })
  list(@CurrentUser() user: JwtPayload) {
    return this.keys.list(user.tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an API key — plaintext revealed ONCE in this response' })
  create(@Body() dto: CreateApiKeyDto, @CurrentUser() user: JwtPayload) {
    return this.keys.create(user.tenantId, user.sub, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke an API key (immediate)' })
  revoke(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.keys.revoke(user.tenantId, user.sub, id);
  }
}
