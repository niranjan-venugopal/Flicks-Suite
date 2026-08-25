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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import { AuthService } from '../auth/auth.service';
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
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly authService: AuthService,
  ) {}

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
      'Creates a tenant + primary location + Owner membership + EMP001 employee row for the founder. Caller must be authenticated (POST /auth/verify-otp first to get a tenant-less JWT). Re-issues the auth cookies with the new tenant/owner role baked in so the next request hits the right tenant context.',
  })
  @ApiResponse({ status: 201, description: 'Tenant created + auth cookies refreshed' })
  @ApiResponse({ status: 409, description: 'Slug already taken or user already in a workspace' })
  async createTenant(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.onboardingService.createTenant(dto, user.sub);

    // Re-issue the auth cookies. The JWT created by /auth/verify-otp had
    // tenantId='' because the user had no membership yet — every subsequent
    // tenant-scoped query would explode with 'invalid input syntax for type
    // uuid: ""'. Now that we've inserted the membership, mint a fresh pair
    // with the real tenantId / membershipId / role and set them. Prefer the
    // tenant that was JUST created — a guest/employee creating their own
    // workspace must land in it, not back in the workspace they came from.
    const refreshed = await this.authService.refreshAuthForUser(user.sub, res, {
      preferTenantId: result.id,
    });
    return { ...result, refreshed };
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
