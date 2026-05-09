import {
  Controller,
  Get,
  Header,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { DashboardService } from './dashboard.service';
import { ActivityQueryDto } from './dashboard.dto';

@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('admin/overview')
  @ApiOperation({
    summary: 'Customer admin dashboard overview',
    description:
      'Returns headline stats, headcount, today’s attendance, top pending approvals, and 30-day trends — all in one round-trip (PRD §10 / Gate 5: <1.5s).',
  })
  @Header('Cache-Control', 'private, max-age=15')
  async getAdminOverview(@CurrentUser() user: JwtPayload) {
    return this.dashboardService.getAdminOverview(user.tenantId);
  }

  @Get('admin/activity')
  @ApiOperation({
    summary: 'Recent activity feed (audit log)',
    description:
      'Paginated tenant-scoped audit log with cursor (`before` = id of last seen item).',
  })
  async getActivity(
    @CurrentUser() user: JwtPayload,
    @Query() query: ActivityQueryDto,
  ) {
    return this.dashboardService.getActivity(user.tenantId, query);
  }
}
