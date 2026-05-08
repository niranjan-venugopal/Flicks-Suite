import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
} from '@nestjs/common';
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
  @ApiOperation({ summary: 'Submit onboarding step (1-5)' })
  @ApiParam({ name: 'step', type: Number })
  @ApiResponse({ status: 200, description: 'Step submitted' })
  async submitOnboardingStep(
    @Param('step', ParseIntPipe) step: number,
    @Body() dto: OnboardingStepDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const myRecord = await this.employeesService.getMyRecord(user.sub, user.tenantId);
    return this.employeesService.submitOnboardingStep(
      myRecord.id,
      step,
      dto,
      user.tenantId,
    );
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
