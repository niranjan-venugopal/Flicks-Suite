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
import { AttendanceService } from './attendance.service';
import {
  PunchDto,
  RegularizationRequestDto,
  ReviewRegularizationDto,
  AttendanceListQueryDto,
} from './attendance.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Attendance')
@ApiBearerAuth('access-token')
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post('punch-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record punch-in for the day' })
  @ApiResponse({ status: 200, description: 'Punch-in recorded' })
  @ApiResponse({ status: 409, description: 'Already punched in' })
  async punchIn(
    @Body() dto: PunchDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.attendanceService.punchIn(user.sub, user.tenantId, dto);
  }

  @Post('punch-out')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record punch-out for the day' })
  @ApiResponse({ status: 200, description: 'Punch-out recorded' })
  async punchOut(
    @Body() dto: PunchDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.attendanceService.punchOut(user.sub, user.tenantId, dto);
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

  @Post('regularizations')
  @ApiOperation({ summary: 'Submit a regularization request' })
  @ApiResponse({ status: 201, description: 'Regularization submitted' })
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
