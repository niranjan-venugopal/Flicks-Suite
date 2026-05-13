import { Controller, Get, Query, Header } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { ReportsService } from './reports.service';
import { ReportRangeDto } from './reports.dto';

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('attendance')
  @Roles('manager')
  @Header('Cache-Control', 'private, max-age=60')
  @ApiOperation({
    summary: 'Attendance compliance report',
    description:
      'Counts by status, present + late rates, daily trend, and top-20 employees by record count over a date range (default: last 30 days).',
  })
  @ApiResponse({ status: 200, description: 'Attendance report' })
  async getAttendance(
    @CurrentUser() user: JwtPayload,
    @Query() range: ReportRangeDto,
  ) {
    return this.reportsService.getAttendanceReport(user.tenantId, range);
  }

  @Get('leave')
  @Roles('manager')
  @Header('Cache-Control', 'private, max-age=60')
  @ApiOperation({
    summary: 'Leave consumption report',
    description:
      'Counts by status + leave type, monthly trend across the year, and top-10 consumers by approved days.',
  })
  @ApiResponse({ status: 200, description: 'Leave report' })
  async getLeave(
    @CurrentUser() user: JwtPayload,
    @Query() range: ReportRangeDto,
  ) {
    return this.reportsService.getLeaveReport(user.tenantId, range);
  }
}
