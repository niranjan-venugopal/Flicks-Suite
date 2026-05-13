import {
  Controller,
  Post,
  Put,
  Get,
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
import { OnboardingService } from './onboarding.service';
import {
  CheckSlugDto,
  CreateTenantDto,
  UpdateTenantDetailsDto,
  CreateDepartmentsDto,
} from './onboarding.dto';
import { Public } from '../../core/auth/decorators/public.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Public()
  @Post('check-slug')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check slug availability' })
  @ApiResponse({ status: 200, schema: { example: { available: true } } })
  async checkSlug(@Body() dto: CheckSlugDto) {
    return this.onboardingService.checkSlug(dto.slug);
  }

  @Post('create-tenant')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a new tenant',
    description:
      'Creates a tenant + primary location + Owner membership + EMP001 employee row for the founder. Caller must be authenticated (POST /auth/verify-otp first to get a tenant-less JWT).',
  })
  @ApiResponse({ status: 201, description: 'Tenant created' })
  @ApiResponse({ status: 409, description: 'Slug already taken or user already in a workspace' })
  async createTenant(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.onboardingService.createTenant(dto, user.sub);
  }

  @Put('tenant-details')
  @Roles('admin')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Update tenant GSTIN, PAN, and address' })
  @ApiResponse({ status: 200, description: 'Tenant details updated' })
  async updateTenantDetails(
    @Body() dto: UpdateTenantDetailsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.onboardingService.updateTenantDetails(user.tenantId, dto);
  }

  @Post('departments')
  @Roles('admin')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Bulk create departments' })
  @ApiResponse({ status: 201, description: 'Departments created' })
  async createDepartments(
    @Body() dto: CreateDepartmentsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.onboardingService.createDepartments(user.tenantId, dto);
  }

  @Get('checklist')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get onboarding checklist state' })
  @ApiResponse({ status: 200, description: 'Checklist state' })
  async getChecklist(@CurrentUser() user: JwtPayload) {
    return this.onboardingService.getChecklist(user.tenantId);
  }

  @Patch('checklist/:taskId')
  @Roles('admin')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Mark checklist task complete' })
  @ApiResponse({ status: 200, description: 'Task marked complete' })
  async markChecklistItem(
    @Param('taskId') taskId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.onboardingService.markChecklistItem(user.tenantId, taskId);
  }
}
