import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { EmployeesService } from './employees.service';
import {
  InviteEmployeeDto,
  UpdateEmployeeDto,
  SelfUpdateEmployeeDto,
  OnboardingStepDto,
  SubmitOnboardingStepDto,
  TransferEmployeeDto,
  TerminateEmployeeDto,
  EmployeeListQueryDto,
} from './employees.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Employees')
@ApiBearerAuth('access-token')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @Roles('manager')
  @ApiOperation({
    summary: 'List employees',
    description: 'Paginated list with filters. Requires manager or above.',
  })
  @ApiResponse({ status: 200, description: 'Employees list' })
  async listEmployees(
    @Query() query: EmployeeListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.listEmployees(user.tenantId, query);
  }

  @Post('invite')
  @Roles('admin')
  @ApiOperation({ summary: 'Invite a new employee' })
  @ApiResponse({ status: 201, description: 'Employee invited' })
  @ApiResponse({ status: 409, description: 'Employee code already in use' })
  async inviteEmployee(
    @Body() dto: InviteEmployeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.inviteEmployee(dto, user.sub, user.tenantId);
  }

  @Get('org-chart')
  @ApiOperation({ summary: 'Get org chart tree' })
  @ApiResponse({ status: 200, description: 'Org chart tree structure' })
  async getOrgChart(@CurrentUser() user: JwtPayload) {
    return this.employeesService.getOrgChart(user.tenantId);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get my employee record' })
  @ApiResponse({ status: 200, description: 'Current user employee record' })
  async getMyRecord(@CurrentUser() user: JwtPayload) {
    return this.employeesService.getMyRecord(user.sub, user.tenantId);
  }

  @Get('team/me')
  @Roles('manager')
  @ApiOperation({
    summary: 'List my direct reports',
    description:
      'Returns active employees whose reporting_manager_id is the current user\'s employee row. Used by the Manager → Team views.',
  })
  @ApiResponse({ status: 200, description: 'Team roster' })
  async listMyTeam(@CurrentUser() user: JwtPayload) {
    return this.employeesService.listMyTeam(user.sub, user.tenantId);
  }

  @Put('me')
  @ApiOperation({ summary: 'Self-update limited fields' })
  @ApiResponse({ status: 200, description: 'Updated' })
  async selfUpdate(
    @Body() dto: SelfUpdateEmployeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.selfUpdateEmployee(user.sub, dto, user.tenantId);
  }

  @Post('me/onboarding/:step')
  @ApiOperation({
    summary: 'Submit a self-onboarding step (1-5)',
    description:
      'Step 1 = personal info + emergency contact · Step 2 = identity · Step 3 = bank · Step 4 = documents (placeholder until R2 uploads ship) · Step 5 = review + submit. Each step writes through to the proper typed columns on the employee row and tracks progress in custom_fields.onboarding_step. Setting submitForReview=true on the final step flags the record as ready for HR approval.',
  })
  @ApiParam({ name: 'step', type: Number })
  @ApiResponse({ status: 200, description: 'Step saved' })
  async submitOnboardingStep(
    @Param('step', ParseIntPipe) step: number,
    @Body() dto: SubmitOnboardingStepDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const myRecord = await this.employeesService.getMyRecord(user.sub, user.tenantId);
    return this.employeesService.submitOnboardingStep(
      myRecord.id,
      step,
      dto,
      user.tenantId,
      user.sub,
      {
        ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
        userAgent: req.headers['user-agent'] ?? undefined,
      },
    );
  }

  @Get('me/onboarding-status')
  @ApiOperation({
    summary: 'Get the current user\'s onboarding progress',
    description:
      'Returns { employeeId, onboardingStep, submittedAt, submittedForReview }. The web wizard reads this on mount to resume the user on the last completed step.',
  })
  @ApiResponse({ status: 200, description: 'Onboarding status' })
  async getMyOnboardingStatus(@CurrentUser() user: JwtPayload) {
    return this.employeesService.getMyOnboardingStatus(user.sub, user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get employee by ID' })
  @ApiResponse({ status: 200, description: 'Employee record' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getEmployee(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.getEmployee(id, user.tenantId);
  }

  @Put(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Admin update employee' })
  @ApiResponse({ status: 200, description: 'Updated' })
  async updateEmployee(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.updateEmployee(id, dto, user.sub, user.tenantId);
  }

  @Post(':id/transfer')
  @Roles('admin')
  @ApiOperation({ summary: 'Transfer employee to new department/manager/location' })
  @ApiResponse({ status: 200, description: 'Employee transferred' })
  async transferEmployee(
    @Param('id') id: string,
    @Body() dto: TransferEmployeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.transferEmployee(id, dto, user.sub, user.tenantId);
  }

  @Post(':id/terminate')
  @Roles('admin')
  @ApiOperation({ summary: 'Initiate employee exit process' })
  @ApiResponse({ status: 200, description: 'Exit initiated' })
  async terminateEmployee(
    @Param('id') id: string,
    @Body() dto: TerminateEmployeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.terminateEmployee(id, dto, user.sub, user.tenantId);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Get employee employment history' })
  @ApiResponse({ status: 200, description: 'Employment history' })
  async getHistory(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.getEmploymentHistory(id, user.tenantId);
  }

  @Post(':id/approve-onboarding')
  @Roles('admin')
  @ApiOperation({ summary: 'Admin approves employee onboarding' })
  @ApiResponse({ status: 200, description: 'Onboarding approved' })
  async approveOnboarding(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.approveOnboarding(id, user.sub, user.tenantId);
  }

  @Get(':id/documents/:docId/url')
  @ApiOperation({ summary: 'Get signed URL for employee document' })
  @ApiResponse({ status: 200, description: 'Pre-signed URL (30 min expiry)' })
  async getDocumentUrl(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.getDocumentSignedUrl(id, docId, user.tenantId);
  }
}
