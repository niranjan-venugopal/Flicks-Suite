import {
  Controller,
  Get,
  Post,
  Put,
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
} from './settings.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

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
