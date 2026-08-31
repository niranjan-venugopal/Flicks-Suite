import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
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
import { MediaService } from '../media/media.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  InviteEmployeeDto,
  UpdateEmployeeDto,
  SelfUpdateEmployeeDto,
  OnboardingStepDto,
  SubmitOnboardingStepDto,
  TransferEmployeeDto,
  TerminateEmployeeDto,
  EmployeeListQueryDto,
  RejectOnboardingDto,
  ImportEmployeesDto,
  RejectChangeRequestDto,
} from './employees.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Employees')
@ApiBearerAuth('access-token')
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly mediaService: MediaService,
    private readonly events: EventEmitter2,
  ) {}

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
    const res = await this.employeesService.listEmployees(user.tenantId, query);
    // §4 — serialization-level avatar swap (signed 64px key URL, legacy fallback).
    const data = await Promise.all(
      res.data.map(async ({ avatarKey, ...row }) => ({
        ...row,
        avatarUrl: await this.mediaService.servedUrl(
          avatarKey ?? null,
          row.avatarUrl,
          64,
        ),
      })),
    );
    return { ...res, data };
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
    const res = await this.employeesService.inviteEmployee(dto, user.sub, user.tenantId);
    this.events.emit('analytics.track', {
      event: 'member_invited', tenantId: user.tenantId, userId: user.sub, // §6
    });
    return res;
  }

  @Post('import')
  @Roles('admin')
  @ApiOperation({
    summary: 'Bulk-import employees from parsed CSV rows',
    description:
      'Each row reuses the single-invite path. Department/designation/location are matched by name. Returns per-row success/failure.',
  })
  @ApiResponse({ status: 201, description: 'Import result' })
  async importEmployees(
    @Body() dto: ImportEmployeesDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.importEmployees(dto, user.sub, user.tenantId);
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

  @Get('onboarding-queue')
  @Roles('admin')
  @ApiOperation({
    summary: 'List employees pending HR onboarding approval',
    description:
      'Returns employees who submitted their self-onboarding for review (custom_fields.onboarding_submitted_for_review = true) and are not yet activated. Used by the People → Onboarding queue.',
  })
  @ApiResponse({ status: 200, description: 'Pending onboarding queue' })
  async getOnboardingQueue(@CurrentUser() user: JwtPayload) {
    return this.employeesService.getOnboardingQueue(user.tenantId, user.sub);
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

  @Post(':id/onboarding/:step')
  @Roles('admin')
  @ApiOperation({
    summary: 'Admin: edit an employee\'s detail groups',
    description:
      'Owner/HR variant of the self-onboarding step writer — same validation and encryption, targeted at any employee. For an ACTIVE app-joined employee the edit is held as a pending change request until the employee confirms it (returns pendingConfirmation: true); for invited/onboarding employees it applies directly. Steps 1-3 (personal / identity / bank).',
  })
  @ApiParam({ name: 'step', type: Number })
  @ApiResponse({ status: 200, description: 'Saved or queued for confirmation' })
  async adminSubmitEmployeeDetails(
    @Param('id') id: string,
    @Param('step', ParseIntPipe) step: number,
    @Body() dto: SubmitOnboardingStepDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.employeesService.adminSubmitEmployeeDetails(
      id,
      step,
      { ...dto, submitForReview: undefined },
      user.tenantId,
      user.sub,
      {
        ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
        userAgent: req.headers['user-agent'] ?? undefined,
      },
    );
  }

  @Get('me/change-requests')
  @ApiOperation({
    summary: 'My pending detail-change requests (HR edits awaiting my confirmation)',
  })
  async listMyChangeRequests(@CurrentUser() user: JwtPayload) {
    return this.employeesService.listMyChangeRequests(user.sub, user.tenantId);
  }

  @Post('me/change-requests/:requestId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a pending detail change — applies it to my record' })
  async confirmMyChangeRequest(
    @Param('requestId') requestId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.reviewMyChangeRequest(
      user.sub,
      user.tenantId,
      requestId,
      'confirm',
    );
  }

  @Post('me/change-requests/:requestId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending detail change — flags it back to HR' })
  async rejectMyChangeRequest(
    @Param('requestId') requestId: string,
    @Body() dto: RejectChangeRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.reviewMyChangeRequest(
      user.sub,
      user.tenantId,
      requestId,
      'reject',
      dto.reason,
    );
  }

  @Get(':id/change-requests')
  @Roles('admin')
  @ApiOperation({ summary: "Admin: an employee's recent detail-change requests" })
  async listEmployeeChangeRequests(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.listEmployeeChangeRequests(id, user.tenantId);
  }

  @Post(':id/change-requests/:requestId/cancel')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: withdraw a pending detail-change request' })
  async cancelChangeRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.cancelChangeRequest(
      id,
      requestId,
      user.tenantId,
      user.sub,
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

  // ─── Removal (founder round 21) ───────────────────────────────────────────
  // The owner-only rule for an owner/admin target is enforced in the SERVICE,
  // from the membership row, not with @Roles here — the decision depends on
  // who is being removed, not on which route was called.

  @Get(':id/removal-preview')
  @Roles('admin')
  @ApiOperation({
    summary: 'What removing this employee would do',
    description:
      'Returns mode=delete (no history — the row goes for good) or mode=archive (they have attendance/leave/timesheet/payroll history, so the record is kept and hidden), with the counts behind that answer. Drives the confirmation copy.',
  })
  @ApiResponse({ status: 200, description: 'Removal preview' })
  async previewRemoval(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.employeesService.previewRemoval(id, user.tenantId);
  }

  @Delete(':id')
  @Roles('admin')
  @ApiOperation({
    summary: 'Remove an employee',
    description:
      'Deletes the record outright when it has no history; otherwise stamps deleted_at so the person leaves every directory while their statutory records survive. Revokes the workspace seat either way.',
  })
  @ApiResponse({ status: 200, description: 'Removed' })
  async removeEmployee(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.employeesService.removeEmployee(id, user.tenantId, user.sub);
  }

  @Post(':id/restore')
  @Roles('admin')
  @ApiOperation({
    summary: 'Restore a removed employee',
    description:
      'Clears deleted_at. The workspace seat is NOT restored — re-invite them if they need access again.',
  })
  @ApiResponse({ status: 200, description: 'Restored' })
  async restoreEmployee(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.employeesService.restoreEmployee(id, user.tenantId, user.sub);
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

  @Post(':id/reject-onboarding')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin sends employee onboarding back for changes' })
  @ApiResponse({ status: 200, description: 'Onboarding rejected' })
  async rejectOnboarding(
    @Param('id') id: string,
    @Body() dto: RejectOnboardingDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeesService.rejectOnboarding(
      id,
      dto.reason,
      user.sub,
      user.tenantId,
    );
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
