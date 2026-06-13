import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InvSettingsService } from './inv-settings.service';
import {
  UpdateInvSettingsDto,
  UpdateSetupProgressDto,
} from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

/**
 * Invoicing settings + setup-wizard progress (PRD §7.1, §11). Behind the
 * InvoicingGrantGuard, so the FAM module toggle gates these too. Reads need
 * invoicing:view; writes need invoicing:edit.
 */
@ApiTags('Invoicing — Settings & Setup')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('invoicing')
export class InvSettingsController {
  constructor(private readonly settings: InvSettingsService) {}

  @Get('settings')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Get invoicing settings for the workspace' })
  getSettings(@CurrentUser() user: JwtPayload) {
    return this.settings.getSettings(user.tenantId, user.sub);
  }

  @Patch('settings')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Update invoicing settings (partial)' })
  updateSettings(
    @Body() dto: UpdateInvSettingsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settings.updateSettings(user.tenantId, user.sub, dto);
  }

  @Get('setup-progress')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Get setup-wizard progress' })
  getSetupProgress(@CurrentUser() user: JwtPayload) {
    return this.settings.getSetupProgress(user.tenantId, user.sub);
  }

  @Patch('setup-progress')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Update setup-wizard progress (partial)' })
  updateSetupProgress(
    @Body() dto: UpdateSetupProgressDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settings.updateSetupProgress(user.tenantId, user.sub, dto);
  }

  @Post('setup-progress/complete')
  @RequireGrant('invoicing', 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the setup wizard complete' })
  completeWizard(@CurrentUser() user: JwtPayload) {
    return this.settings.completeWizard(user.tenantId, user.sub);
  }
}
