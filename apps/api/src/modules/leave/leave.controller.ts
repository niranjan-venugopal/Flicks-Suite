import {
  Controller,
  Get,
  Post,
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
import { LeaveService } from './leave.service';
import {
  ApplyLeaveDto,
  CancelLeaveDto,
  ReviewLeaveDto,
  CreateLeaveTypeDto,
  LeaveListQueryDto,
} from './leave.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Leave')
@ApiBearerAuth('access-token')
@Controller('leave')
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

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
    return this.leaveService.reviewLeave(id, user.sub, user.tenantId, dto);
  }

  @Get('holidays')
  @ApiOperation({ summary: 'List holidays for the tenant' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Holiday list' })
  async listHolidays(
    @CurrentUser() user: JwtPayload,
    @Query('year') year?: string,
  ) {
    const parsedYear = year ? Number(year) : undefined;
    return this.leaveService.listHolidays(user.tenantId, parsedYear);
  }
}
