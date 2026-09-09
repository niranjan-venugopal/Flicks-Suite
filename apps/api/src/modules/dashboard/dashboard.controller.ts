import {
  Controller,
  Get,
  Header,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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
  @ApiQuery({
    name: 'pendingLimit',
    required: false,
    type: Number,
    description:
      'How many pending leaves / regularizations to list (1–50, default 5). Counts are unaffected; the Inbox asks for 50.',
  })
  @Header('Cache-Control', 'private, max-age=15')
  async getAdminOverview(
    @CurrentUser() user: JwtPayload,
    @Query('pendingLimit') pendingLimit?: string,
  ) {
    // The endpoint itself is open to every tenant member (the Inbox calls it
    // for all roles), so the review buckets are gated here rather than with
    // @Roles — mirrors the @Roles('admin') gate on the onboarding-queue
    // endpoint. Approvals follow the @Roles('manager') gate on the leave and
    // regularization review routes: a plain employee has no queue and must not
    // receive the whole workspace's pending requests.
    const isPlatformAdmin = user.isPlatformAdmin === true;
    // Round K: only the list length is caller-controlled (the service clamps
    // it to 1..50); anything unparseable falls back to the default.
    const parsedLimit = pendingLimit ? Number(pendingLimit) : NaN;
    return this.dashboardService.getAdminOverview(user.tenantId, {
      callerUserId: user.sub,
      includeOnboarding:
        isPlatformAdmin ||
        ['owner', 'admin', 'fam', 'super_admin'].includes(user.role),
      includeApprovals:
        isPlatformAdmin ||
        ['owner', 'admin', 'manager', 'fam', 'super_admin'].includes(user.role),
      // Round I (founder decision): a manager's dashboard is about THEIR
      // team — direct reports only. Owner/admin/finance stay workspace-wide.
      scope: !isPlatformAdmin && user.role === 'manager' ? 'team' : 'org',
      pendingLimit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
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
