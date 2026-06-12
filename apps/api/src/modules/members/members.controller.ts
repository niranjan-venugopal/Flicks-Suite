import {
  Body,
  Controller,
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
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { MembersService } from './members.service';
import { InviteAuditorDto, UpdateGrantsDto } from './members.dto';

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
