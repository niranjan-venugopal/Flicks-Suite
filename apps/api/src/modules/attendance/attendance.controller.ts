import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AttendanceService } from './attendance.service';
import { PresenceService } from '../presence/presence.service';
import {
  PunchDto,
  RegularizationRequestDto,
  ReviewRegularizationDto,
  AttendanceListQueryDto,
  AttendanceMonthQueryDto,
} from './attendance.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]!.trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.ip;
}

@ApiTags('Attendance')
@ApiBearerAuth('access-token')
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly presence: PresenceService,
    private readonly events: EventEmitter2,
  ) {}

  @Post('punch-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record punch-in for the day' })
  @ApiResponse({ status: 200, description: 'Punch-in recorded' })
  @ApiResponse({ status: 404, description: 'No shift assigned' })
  async punchIn(
    @Body() dto: PunchDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const res = await this.attendanceService.punchIn(
      user.sub,
      user.tenantId,
      dto,
      clientIp(req),
      req.headers['user-agent'],
    );
    // PRD v4 §5 — a punch flips presence (In office / Remote) org-wide ≤5s.
    // A punch is an explicit availability signal, so it OVERRIDES any stale
    // manual "Set status" (Busy / Away / Appear offline) — otherwise the
    // profile dot never changes on clock-in and reads as broken.
    await this.presence.clearStatus(user.tenantId, user.sub);
    this.events.emit('presence.changed', { tenantId: user.tenantId, userId: user.sub });
    return res;
  }

  @Post('punch-out')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record punch-out for the day' })
  @ApiResponse({ status: 200, description: 'Punch-out recorded' })
  @ApiResponse({ status: 400, description: 'No punch-in for today' })
  async punchOut(
    @Body() dto: PunchDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const res = await this.attendanceService.punchOut(
      user.sub,
      user.tenantId,
      dto,
      clientIp(req),
      req.headers['user-agent'],
    );
    // Same rule on the way out — the punch wins over a stale manual status.
    await this.presence.clearStatus(user.tenantId, user.sub);
    this.events.emit('presence.changed', { tenantId: user.tenantId, userId: user.sub });
    return res;
  }

  @Post('break-start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a break' })
  @ApiResponse({ status: 200, description: 'Break started' })
  async breakStart(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.breakStart(user.sub, user.tenantId);
  }

  @Post('break-end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a break' })
  @ApiResponse({ status: 200, description: 'Break ended' })
  async breakEnd(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.breakEnd(user.sub, user.tenantId);
  }

  @Get('me/month')
  @ApiOperation({ summary: 'Unified month view — every calendar day with punches, regularization status, holiday/weekend flags' })
  async getMyMonth(@Query() query: AttendanceMonthQueryDto, @CurrentUser() user: JwtPayload) {
    return this.attendanceService.getMyMonth(user.sub, user.tenantId, query.month);
  }

  @Get('me/today')
  @ApiOperation({ summary: 'Get my current-day attendance state' })
  @ApiResponse({ status: 200, description: 'Today snapshot' })
  async getMyToday(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.getMyToday(user.sub, user.tenantId);
  }

  @Get('me')
  @ApiOperation({ summary: 'List my attendance records' })
  @ApiResponse({ status: 200, description: 'Attendance list' })
  async listMine(
    @Query() query: AttendanceListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.attendanceService.listMine(user.sub, user.tenantId, query);
  }

  @Get('employee/:employeeId')
  @ApiOperation({
    summary: 'Attendance history for one employee (employee-360 tab)',
    description:
      'Visible to the employee themselves, their reporting manager, and owner/admin/finance. Same shape as /attendance/me plus workMode.',
  })
  @ApiResponse({ status: 200, description: 'Attendance list' })
  @ApiResponse({ status: 403, description: 'Not the employee, their manager, or an admin' })
  async listForEmployee(
    @Param('employeeId') employeeId: string,
    @Query() query: AttendanceListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.attendanceService.listForEmployee(
      user.sub,
      user.role,
      employeeId,
      user.tenantId,
      query,
    );
  }

  @Get('team/today')
  // Hierarchical guard: finance and above (owner/admin/manager/finance/fam).
  // Managers get their direct reports; every higher role gets the whole org.
  @Roles('finance')
  @ApiOperation({
    summary: 'Get today’s team attendance',
    description:
      'One row per active employee with their current-day attendance state. Managers see direct reports; owner/admin/finance see the whole workspace (optionally narrowed with ?managerId=).',
  })
  @ApiResponse({ status: 200, description: 'Team status' })
  async listTeamToday(
    @CurrentUser() user: JwtPayload,
    @Query('managerId') managerId?: string,
  ) {
    return this.attendanceService.listTeamToday(
      user.sub,
      user.tenantId,
      user.role,
      managerId,
    );
  }

  @Post('regularizations')
  @ApiOperation({ summary: 'Submit a regularization request' })
  @ApiResponse({ status: 201, description: 'Regularization submitted' })
  @ApiResponse({ status: 400, description: 'Pending duplicate exists' })
  async requestRegularization(
    @Body() dto: RegularizationRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.attendanceService.requestRegularization(
      user.sub,
      user.tenantId,
      dto,
    );
  }

  @Get('regularizations/pending')
  @Roles('manager')
  @ApiOperation({ summary: 'List regularizations awaiting my review' })
  @ApiResponse({ status: 200, description: 'Pending regularizations' })
  async listPendingRegularizations(
    @Query() query: AttendanceListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.attendanceService.listPendingRegularizations(
      user.sub,
      user.tenantId,
      query,
    );
  }

  @Post('regularizations/:id/review')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a regularization request' })
  @ApiResponse({ status: 200, description: 'Regularization reviewed' })
  async reviewRegularization(
    @Param('id') id: string,
    @Body() dto: ReviewRegularizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.attendanceService.reviewRegularization(
      id,
      user.sub,
      user.tenantId,
      dto,
    );
  }
}
