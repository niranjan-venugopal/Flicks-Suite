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
  UpdateWorkingHoursDto,
  CreateDesignationDto,
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

  // ─── Working hours ─────────────────────────────────────────────────────────

  @Get('working-hours')
  @ApiOperation({ summary: 'Get tenant default working hours' })
  @ApiResponse({ status: 200, description: 'Working hours config' })
  async getWorkingHours(@CurrentUser() user: JwtPayload) {
    return this.settingsService.getWorkingHours(user.tenantId);
  }

  @Put('working-hours')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update tenant default working hours' })
  @ApiResponse({ status: 200, description: 'Working hours updated' })
  async updateWorkingHours(
    @Body() dto: UpdateWorkingHoursDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.settingsService.updateWorkingHours(
      user.tenantId,
      user.sub,
      dto,
    );
  }
}
