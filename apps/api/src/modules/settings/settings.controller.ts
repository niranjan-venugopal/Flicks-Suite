import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import {
  CreateDepartmentDto,
  UpdateDepartmentDto,
  CreateLocationDto,
  UpdateLocationDto,
  CreateDesignationDto,
  UpdateDesignationDto,
  CreateShiftTemplateDto,
  UpdateShiftTemplateDto,
  CreateLeavePolicyDto,
  UpdateLeavePolicyDto,
  UpdateMemberRoleDto,
  UpdateOrganizationDto,
} from './settings.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  // ─── Organization (tenant profile) ─────────────────────────────────────────

  @Get('organization')
  @ApiOperation({
    summary: 'Get the current tenant profile',
    description:
      'Workspace name, slug, legal/tax identifiers, registered address, branding, plus headcount/dept/location counts for the Settings landing screen.',
  })
  @ApiResponse({ status: 200, description: 'Tenant profile' })
  async getOrganization(@CurrentUser() user: JwtPayload) {
    return this.settingsService.getOrganization(user.tenantId);
  }

  @Patch('organization')
  @Roles('admin')
  @ApiOperation({
    summary: 'Update the tenant profile',
    description:
      'Edit display name, legal name, GSTIN/PAN/CIN, industry, size band, and registered address. Slug is immutable; status/billing live in FAM.',
  })
  @ApiResponse({ status: 200, description: 'Tenant updated' })
  async updateOrganization(
    @Body() dto: UpdateOrganizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.updateOrganization(
      user.tenantId,
      user.sub,
      dto,
    );
  }

  // ─── Departments ───────────────────────────────────────────────────────────

  @Get('departments')
  @ApiOperation({ summary: 'List departments' })
  @ApiResponse({ status: 200, description: 'Departments list' })
  async listDepartments(@CurrentUser() user: JwtPayload) {
    return this.settingsService.listDepartments(user.tenantId);
  }

  @Post('departments')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a department' })
  @ApiResponse({ status: 201, description: 'Department created' })
  async createDepartment(
    @Body() dto: CreateDepartmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.createDepartment(user.tenantId, user.sub, dto);
  }

  @Put('departments/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a department' })
  @ApiResponse({ status: 200, description: 'Department updated' })
  async updateDepartment(
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.updateDepartment(
      id,
      user.tenantId,
      user.sub,
      dto,
    );
  }

  // ─── Locations ─────────────────────────────────────────────────────────────

  @Get('locations')
  @ApiOperation({ summary: 'List locations' })
  @ApiResponse({ status: 200, description: 'Locations list' })
  async listLocations(@CurrentUser() user: JwtPayload) {
    return this.settingsService.listLocations(user.tenantId);
  }

  @Post('locations')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a location' })
  @ApiResponse({ status: 201, description: 'Location created' })
  async createLocation(
    @Body() dto: CreateLocationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.createLocation(user.tenantId, user.sub, dto);
  }

  @Put('locations/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a location' })
  @ApiResponse({ status: 200, description: 'Location updated' })
  async updateLocation(
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.updateLocation(
      id,
      user.tenantId,
      user.sub,
      dto,
    );
  }

  // ─── Designations ──────────────────────────────────────────────────────────

  @Get('designations')
  @ApiOperation({ summary: 'List designations' })
  @ApiResponse({ status: 200, description: 'Designations list' })
  async listDesignations(@CurrentUser() user: JwtPayload) {
    return this.settingsService.listDesignations(user.tenantId);
  }

  @Post('designations')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a designation' })
  @ApiResponse({ status: 201, description: 'Designation created' })
  async createDesignation(
    @Body() dto: CreateDesignationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.createDesignation(user.tenantId, user.sub, dto);
  }

  @Put('designations/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a designation' })
  @ApiResponse({ status: 200, description: 'Designation updated' })
  async updateDesignation(
    @Param('id') id: string,
    @Body() dto: UpdateDesignationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.updateDesignation(
      id,
      user.tenantId,
      user.sub,
      dto,
    );
  }

  // ─── Working hours / shift templates ───────────────────────────────────────

  @Get('shifts')
  @ApiOperation({
    summary: 'List shift templates',
    description: 'Returns all shift templates for the tenant with current assigned headcount.',
  })
  @ApiResponse({ status: 200, description: 'Shift templates list' })
  async listShifts(@CurrentUser() user: JwtPayload) {
    return this.settingsService.listShifts(user.tenantId);
  }

  @Post('shifts')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a shift template' })
  @ApiResponse({ status: 201, description: 'Shift template created' })
  async createShift(
    @Body() dto: CreateShiftTemplateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.createShift(user.tenantId, user.sub, dto);
  }

  @Put('shifts/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a shift template' })
  @ApiResponse({ status: 200, description: 'Shift template updated' })
  async updateShift(
    @Param('id') id: string,
    @Body() dto: UpdateShiftTemplateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.updateShift(id, user.tenantId, user.sub, dto);
  }

  // ─── Leave policies ────────────────────────────────────────────────────────

  @Get('leave-policies')
  @ApiOperation({
    summary: 'List leave policies',
    description: 'Returns all leave types with YTD approved usage stats.',
  })
  @ApiResponse({ status: 200, description: 'Leave policies list' })
  async listLeavePolicies(@CurrentUser() user: JwtPayload) {
    return this.settingsService.listLeavePolicies(user.tenantId);
  }

  @Post('leave-policies')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a leave policy' })
  @ApiResponse({ status: 201, description: 'Leave policy created' })
  async createLeavePolicy(
    @Body() dto: CreateLeavePolicyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.createLeavePolicy(
      user.tenantId,
      user.sub,
      dto,
    );
  }

  @Put('leave-policies/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a leave policy' })
  @ApiResponse({ status: 200, description: 'Leave policy updated' })
  async updateLeavePolicy(
    @Param('id') id: string,
    @Body() dto: UpdateLeavePolicyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.updateLeavePolicy(
      id,
      user.tenantId,
      user.sub,
      dto,
    );
  }

  // ─── Members (memberships / workspace access) ──────────────────────────────

  @Get('members')
  @ApiOperation({
    summary: 'List workspace members',
    description: 'Memberships joined to user + employee + dept + designation.',
  })
  @ApiResponse({ status: 200, description: 'Members list' })
  async listMembers(@CurrentUser() user: JwtPayload) {
    return this.settingsService.listMembers(user.tenantId);
  }

  @Patch('members/:id/role')
  @Roles('admin')
  @ApiOperation({ summary: 'Change a member\'s role' })
  @ApiResponse({ status: 200, description: 'Role updated' })
  async updateMemberRole(
    @Param('id') id: string,
    @Body() dto: UpdateMemberRoleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.updateMemberRole(
      id,
      user.tenantId,
      user.sub,
      dto,
    );
  }

  @Post('members/:id/deactivate')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a member' })
  @ApiResponse({ status: 200, description: 'Member deactivated' })
  async deactivateMember(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.setMemberStatus(
      id,
      user.tenantId,
      user.sub,
      'deactivated',
    );
  }

  @Post('members/:id/reactivate')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a member' })
  @ApiResponse({ status: 200, description: 'Member reactivated' })
  async reactivateMember(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.setMemberStatus(
      id,
      user.tenantId,
      user.sub,
      'active',
    );
  }
}
