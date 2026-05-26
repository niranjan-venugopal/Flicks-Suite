import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TimesheetService } from './timesheet.service';
import {
  BulkSaveEntriesDto,
  SubmitTimesheetDto,
  ReviewTimesheetDto,
  TimesheetListQueryDto,
} from './timesheet.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Timesheet')
@ApiBearerAuth('access-token')
@Controller('timesheet')
export class TimesheetController {
  constructor(private readonly timesheetService: TimesheetService) {}

  @Get('me/current')
  @ApiOperation({ summary: 'Get my current open timesheet period' })
  @ApiResponse({ status: 200, description: 'Current period' })
  async getMyCurrentPeriod(@CurrentUser() user: JwtPayload) {
    return this.timesheetService.getMyCurrentPeriod(user.sub, user.tenantId);
  }

  @Get('me/previous-categories')
  @ApiOperation({
    summary: 'Categories logged last week (for "Copy last week")',
  })
  @ApiResponse({ status: 200, description: 'Distinct prior-week categories' })
  async getPreviousWeekCategories(@CurrentUser() user: JwtPayload) {
    return this.timesheetService.getPreviousWeekCategories(
      user.sub,
      user.tenantId,
    );
  }

  @Get('reports/utilization')
  @Roles('manager')
  @ApiOperation({ summary: 'Billable vs non-billable utilization per employee' })
  @ApiResponse({ status: 200, description: 'Utilization report' })
  async getUtilizationReport(
    @CurrentUser() user: JwtPayload,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.timesheetService.getUtilizationReport(user.tenantId, {
      from,
      to,
    });
  }

  @Get('me')
  @ApiOperation({ summary: 'List my timesheet periods' })
  @ApiResponse({ status: 200, description: 'Timesheet periods' })
  async listMine(
    @Query() query: TimesheetListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.timesheetService.listMine(user.sub, user.tenantId, query);
  }

  @Get(':periodId/entries')
  @ApiOperation({ summary: 'Get entries for a period' })
  @ApiResponse({ status: 200, description: 'Period entries' })
  async getEntries(
    @Param('periodId') periodId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.timesheetService.getEntries(periodId, user.sub, user.tenantId);
  }

  @Post('entries')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk save entries for a draft period' })
  @ApiResponse({ status: 200, description: 'Entries saved' })
  async saveEntries(
    @Body() dto: BulkSaveEntriesDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.timesheetService.saveEntries(user.sub, user.tenantId, dto);
  }

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit a draft period for approval' })
  @ApiResponse({ status: 200, description: 'Period submitted' })
  async submitTimesheet(
    @Body() dto: SubmitTimesheetDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.timesheetService.submitTimesheet(user.sub, user.tenantId, dto);
  }

  @Get('pending')
  @Roles('manager')
  @ApiOperation({ summary: 'List timesheets pending my review' })
  @ApiResponse({ status: 200, description: 'Pending timesheets' })
  async listPending(
    @Query() query: TimesheetListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.timesheetService.listPending(user.sub, user.tenantId, query);
  }

  @Post(':periodId/review')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve / reject / rework a timesheet period' })
  @ApiResponse({ status: 200, description: 'Period reviewed' })
  async reviewTimesheet(
    @Param('periodId') periodId: string,
    @Body() dto: ReviewTimesheetDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.timesheetService.reviewTimesheet(
      periodId,
      user.sub,
      user.tenantId,
      dto,
    );
  }
}
