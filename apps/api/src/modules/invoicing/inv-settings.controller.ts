import {
  Body,
  Controller,
  Delete,
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
  GrantFamConsentDto,
} from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
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

  // ─── Razorpay OAuth Connect (PRD §6.6/§9.3) ─────────────────────────────────

  @Get('razorpay/connect')
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({ summary: 'Start Razorpay OAuth — returns the authorize URL' })
  razorpayConnect(@CurrentUser() user: JwtPayload) {
    return this.settings.razorpayConnectUrl(user.tenantId, user.sub);
  }

  @Post('razorpay/disconnect')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disconnect Razorpay (Owner only) — revokes tokens' })
  razorpayDisconnect(@CurrentUser() user: JwtPayload) {
    return this.settings.razorpayDisconnect(user.tenantId, user.sub);
  }

  // ─── FAM debug consent (PRD §10.5) — owner-only ─────────────────────────────

  @Get('fam-consent')
  @Roles('owner')
  @ApiOperation({ summary: 'Current FAM debug-access consent for this workspace' })
  getFamConsent(@CurrentUser() user: JwtPayload) {
    return this.settings.getFamConsent(user.tenantId, user.sub);
  }

  @Post('fam-consent')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Grant FAM time-boxed, revocable debug access (counts/logs only)',
  })
  grantFamConsent(@Body() dto: GrantFamConsentDto, @CurrentUser() user: JwtPayload) {
    return this.settings.grantFamConsent(user.tenantId, user.sub, dto);
  }

  @Delete('fam-consent')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke FAM debug access' })
  revokeFamConsent(@CurrentUser() user: JwtPayload) {
    return this.settings.revokeFamConsent(user.tenantId, user.sub);
  }
}
