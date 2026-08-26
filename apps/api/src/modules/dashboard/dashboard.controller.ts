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
    // The endpoint itself is open to every tenant member (the Inbox calls it
    // for all roles), so the review buckets are gated here rather than with
    // @Roles — mirrors the @Roles('admin') gate on the onboarding-queue
    // endpoint. Approvals follow the @Roles('manager') gate on the leave and
    // regularization review routes: a plain employee has no queue and must not
    // receive the whole workspace's pending requests.
    const isPlatformAdmin = user.isPlatformAdmin === true;
    return this.dashboardService.getAdminOverview(user.tenantId, {
      callerUserId: user.sub,
      includeOnboarding:
        isPlatformAdmin ||
        ['owner', 'admin', 'fam', 'super_admin'].includes(user.role),
      includeApprovals:
        isPlatformAdmin ||
        ['owner', 'admin', 'manager', 'fam', 'super_admin'].includes(user.role),
    });
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
