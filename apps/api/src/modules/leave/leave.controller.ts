import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
} from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LeaveService } from './leave.service';
import {
  ApplyLeaveDto,
  CancelLeaveDto,
  ReviewLeaveDto,
  CreateLeaveTypeDto,
  CreateHolidayDto,
  UpdateHolidayDto,
  ImportHolidaysDto,
  LeaveListQueryDto,
} from './leave.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Leave')
@ApiBearerAuth('access-token')
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly leaveService: LeaveService,
    private readonly events: EventEmitter2,
  ) {}

  @Get('types')
  @ApiOperation({ summary: 'List configured leave types' })
  @ApiResponse({ status: 200, description: 'Leave types' })
  async listLeaveTypes(@CurrentUser() user: JwtPayload) {
    return this.leaveService.listLeaveTypes(user.tenantId);
  }

  @Post('types')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a new leave type' })
  @ApiResponse({ status: 201, description: 'Leave type created' })
  async createLeaveType(
    @Body() dto: CreateLeaveTypeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.createLeaveType(user.tenantId, user.sub, dto);
  }

  @Get('me/balances')
  @ApiOperation({ summary: 'Get my current leave balances' })
  @ApiResponse({ status: 200, description: 'Balances by leave type' })
  async getMyBalances(@CurrentUser() user: JwtPayload) {
    return this.leaveService.getMyBalances(user.sub, user.tenantId);
  }

  @Post('apply')
  @ApiOperation({ summary: 'Apply for leave' })
  @ApiResponse({ status: 201, description: 'Leave request submitted' })
  @ApiResponse({ status: 400, description: 'Insufficient balance / overlap' })
  async applyLeave(
    @Body() dto: ApplyLeaveDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.applyLeave(user.sub, user.tenantId, dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'List my leave requests' })
  @ApiResponse({ status: 200, description: 'Leave requests' })
  async listMine(
    @Query() query: LeaveListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.listMine(user.sub, user.tenantId, query);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a leave request' })
  @ApiResponse({ status: 200, description: 'Leave cancelled' })
  async cancelLeave(
    @Param('id') id: string,
    @Body() dto: CancelLeaveDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.cancelLeave(id, user.sub, user.tenantId, dto);
  }

  @Get('pending')
  @Roles('manager')
  @ApiOperation({ summary: 'List leave requests pending my review' })
  @ApiResponse({ status: 200, description: 'Pending leave requests' })
  async listPending(
    @Query() query: LeaveListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.listPending(user.sub, user.tenantId, query);
  }

  @Post(':id/review')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a leave request' })
  @ApiResponse({ status: 200, description: 'Leave reviewed' })
  async reviewLeave(
    @Param('id') id: string,
    @Body() dto: ReviewLeaveDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const res = await this.leaveService.reviewLeave(id, user.sub, user.tenantId, dto);
    // PRD v4 §5 — approving today's leave flips the REQUESTER to Out of office
    // org-wide ≤5s. The gateway resolves employee→user itself.
    const employeeId = (res as { data?: { employee_id?: string } })?.data?.employee_id;
    if (dto.action === 'approve' && employeeId) {
      this.events.emit('presence.changed', { tenantId: user.tenantId, employeeId });
    }
    return res;
  }

  @Get('holidays')
  @ApiOperation({
    summary: 'List holidays for the tenant',
    description:
      "Default scope is the caller's own location (company-wide + their location). locationId accepts 'all' (admin screens), 'company', or a location id.",
  })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'locationId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Holiday list' })
  async listHolidays(
    @CurrentUser() user: JwtPayload,
    @Query('year') year?: string,
    @Query('locationId') locationId?: string,
  ) {
    const parsedYear = year ? Number(year) : undefined;
    return this.leaveService.listHolidays(user.tenantId, {
      year: parsedYear,
      locationScope: locationId || undefined,
      userId: user.sub,
    });
  }

  @Get('holidays/presets')
  @Roles('admin')
  @ApiOperation({
    summary: 'Curated country holiday lists that seed the import flow',
  })
  @ApiQuery({ name: 'country', required: true, type: String })
  @ApiQuery({ name: 'year', required: true, type: Number })
  async listHolidayPresets(
    @Query('country') country: string,
    @Query('year', ParseIntPipe) year: number,
  ) {
    return this.leaveService.listHolidayPresets(
      (country ?? '').toUpperCase(),
      year,
    );
  }

  @Post('holidays')
  @Roles('admin')
  @ApiOperation({ summary: 'Add a holiday (company-wide or per location)' })
  @ApiResponse({ status: 201, description: 'Holiday created' })
  async createHoliday(
    @Body() dto: CreateHolidayDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.createHoliday(user.tenantId, dto);
  }

  @Post('holidays/import')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk-import holidays (country presets); duplicates are skipped',
  })
  async importHolidays(
    @Body() dto: ImportHolidaysDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.importHolidays(user.tenantId, dto);
  }

  @Patch('holidays/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a holiday' })
  async updateHoliday(
    @Param('id') id: string,
    @Body() dto: UpdateHolidayDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.updateHoliday(user.tenantId, id, dto);
  }

  @Delete('holidays/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Delete a holiday' })
  async deleteHoliday(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.leaveService.deleteHoliday(user.tenantId, id);
  }
}
