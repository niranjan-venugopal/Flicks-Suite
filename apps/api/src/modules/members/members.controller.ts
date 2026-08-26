import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { MembersService } from './members.service';
import {
  InviteAuditorDto,
  MANAGED_MODULES,
  UpdateGrantsDto,
  UpdateRoleDefaultsDto,
  UpsertGrantDto,
} from './members.dto';

/**
 * Auditor management endpoints (PRD §3, §4.4). Lives under /settings/members
 * next to the existing HRMS members list; list/role/deactivate stay in
 * SettingsController, the auditor-specific pieces live here.
 */
@ApiTags('Members (auditor)')
@ApiBearerAuth('access-token')
@Controller('settings/members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Post('invite-auditor')
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  // Invite sends an email — cap to 10 / minute to prevent invite spam.
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Invite an auditor (non-billable, grant-scoped seat)',
    description:
      'Finds or creates the user, creates an invited auditor membership with the ' +
      'given module grants (review-grade defaults when omitted) and emails a magic-link invite.',
  })
  @ApiResponse({ status: 201, description: 'Invite sent' })
  @ApiResponse({ status: 409, description: 'User already has access or a pending invite' })
  async inviteAuditor(
    @Body() dto: InviteAuditorDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.membersService.inviteAuditor(dto, user.sub, user.tenantId);
  }

  @Patch(':id/grants')
  @Roles('admin')
  @ApiOperation({ summary: "Replace a member's module grants" })
  @ApiResponse({ status: 200, description: 'Grants updated' })
  async updateGrants(
    @Param('id') id: string,
    @Body() dto: UpdateGrantsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.membersService.updateGrants(id, dto, user.sub, user.tenantId);
  }

  @Patch(':id/grants/:module')
  @Roles('admin')
  @ApiOperation({
    summary: "Set ONE module on a member's access",
    description:
      'Partial, additive write used by Settings → Module access. Unlike the ' +
      'replace-all endpoint it never touches the modules it was not told ' +
      'about. access_level "none" stores an explicit revocation, which now ' +
      'beats the role default.',
  })
  @ApiResponse({ status: 200, description: 'Module access updated' })
  @ApiResponse({ status: 409, description: 'Guest access is managed per project' })
  async upsertGrant(
    @Param('id') id: string,
    @Param('module') module: string,
    @Body() dto: UpsertGrantDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!(MANAGED_MODULES as readonly string[]).includes(module)) {
      throw new BadRequestException(`Unknown module: ${module}`);
    }
    return this.membersService.upsertGrant(id, module, dto, user.sub, user.tenantId);
  }

  @Delete(':id/grants/:module')
  @Roles('admin')
  @ApiOperation({ summary: "Reset one module to the member's role default" })
  @ApiResponse({ status: 200, description: 'Module reset to role default' })
  async clearGrant(
    @Param('id') id: string,
    @Param('module') module: string,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!(MANAGED_MODULES as readonly string[]).includes(module)) {
      throw new BadRequestException(`Unknown module: ${module}`);
    }
    return this.membersService.clearGrant(id, module, user.sub, user.tenantId);
  }

  @Get('role-defaults')
  @Roles('admin')
  @ApiOperation({
    summary: 'Per-role module policy for this workspace',
    description:
      'What each role gets with no per-person override. Owner/Admin are absent ' +
      'on purpose — they hold every module by role.',
  })
  @ApiResponse({ status: 200, description: 'Role policy' })
  async getRoleDefaults(@CurrentUser() user: JwtPayload) {
    return this.membersService.getRoleDefaults(user.tenantId, user.sub);
  }

  @Patch('role-defaults')
  @Roles('admin')
  @ApiOperation({ summary: 'Set the per-role module policy for this workspace' })
  @ApiResponse({ status: 200, description: 'Role policy updated' })
  async updateRoleDefaults(
    @Body() dto: UpdateRoleDefaultsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.membersService.updateRoleDefaults(dto, user.sub, user.tenantId);
  }

  @Get('seats')
  @ApiOperation({
    summary: 'Seat usage — billable members vs non-billable auditors',
  })
  @ApiResponse({ status: 200, description: 'Seat counts' })
  async seats(@CurrentUser() user: JwtPayload) {
    return this.membersService.seats(user.tenantId);
  }
}

/**
 * Cross-tenant self listing for the company switcher + My Companies screen
 * (PRD §3.4). Strictly keyed to the caller's own user_id.
 */
@ApiTags('Members (auditor)')
@ApiBearerAuth('access-token')
@Controller('me')
export class MeCompaniesController {
  constructor(private readonly membersService: MembersService) {}

  @Get('companies')
  @ApiOperation({
    summary: 'List the companies the signed-in user can switch into',
    description:
      'Active + pending-invite memberships with grants and light invoicing stats. ' +
      'Pending invites are accepted by switching into them (POST /auth/switch-company).',
  })
  @ApiResponse({ status: 200, description: 'Linked companies' })
  async myCompanies(@CurrentUser() user: JwtPayload) {
    return this.membersService.getMyCompanies(user.sub);
  }
}
