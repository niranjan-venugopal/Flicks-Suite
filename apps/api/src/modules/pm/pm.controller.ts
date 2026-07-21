import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PmGrantGuard } from '../../core/auth/guards/pm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { PmTeamsService } from './teams.service';
import { PmIssuesService } from './issues.service';
import { PmViewsService } from './views.service';

class CreateTeamDto {
  @IsString() @MaxLength(6) key!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsBoolean() is_private?: boolean;
  @IsOptional() @IsString() timezone?: string;
}

class CreateIssueDto {
  @IsUUID() team_id!: string;
  @IsString() @MaxLength(500) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() state_id?: string;
  @IsOptional() @IsInt() @Min(0) @Max(4) @Type(() => Number) priority?: number;
  @IsOptional() estimate?: number | string | null;
  @IsOptional() @IsUUID() assignee_user_id?: string;
  @IsOptional() @IsUUID() parent_issue_id?: string;
  @IsOptional() @IsString() due_date?: string;
}

class UpdateIssueDto {
  @IsOptional() @IsString() @MaxLength(500) title?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() estimate?: number | string | null;
  @IsOptional() @IsString() due_date?: string | null;
}

class MoveStateDto {
  @IsUUID() state_id!: string;
}
class SetPriorityDto {
  @IsInt() @Min(0) @Max(4) @Type(() => Number) priority!: number;
}
class AssignDto {
  @IsOptional() @IsUUID() assignee_user_id?: string | null;
}
class RankDto {
  @IsIn(['board_rank', 'backlog_rank']) rank_field!: 'board_rank' | 'backlog_rank';
  @IsString() @MaxLength(64) rank!: string;
}

/**
 * PM conventional REST (PRD v6 §19) — the kill-switch path. Same domain
 * services as the sync mutation-executor; when the FSE flag is off the web
 * client runs entirely on these endpoints via react-query.
 */
@ApiTags('pm')
@Controller('pm')
@UseGuards(PmGrantGuard)
export class PmController {
  constructor(
    private readonly teams: PmTeamsService,
    private readonly issues: PmIssuesService,
    private readonly views: PmViewsService,
  ) {}

  // ─── Teams ────────────────────────────────────────────────────────────────

  @Get('teams')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'Visible teams + memberships + states + labels (self-heals an empty workspace)' })
  listTeams(@CurrentUser() user: JwtPayload) {
    return this.teams.list(user.tenantId, user.sub);
  }

  @Post('teams')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin', 'manager')
  @ApiOperation({ summary: 'Create a team (Owner/Admin/Manager — §16 matrix)' })
  createTeam(@CurrentUser() user: JwtPayload, @Body() dto: CreateTeamDto) {
    return this.teams.create(user.tenantId, user.sub, dto);
  }

  @Get('users')
  @RequireGrant('pm', 'view')
  usersLite(@CurrentUser() user: JwtPayload) {
    return this.teams.usersLite(user.tenantId, user.sub).then((rows) => ({ data: rows }));
  }

  // ─── Issues (REST list/detail/CRUD — kill-switch path) ────────────────────

  @Get('issues')
  @RequireGrant('pm', 'view')
  listIssues(
    @CurrentUser() user: JwtPayload,
    @Query('team_id') teamId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.issues.list(user.tenantId, user.sub, {
      team_id: teamId,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('issues/:id')
  @RequireGrant('pm', 'view')
  getIssue(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.issues.get(user.tenantId, user.sub, id);
  }

  @Post('issues')
  @RequireGrant('pm', 'edit')
  createIssue(@CurrentUser() user: JwtPayload, @Body() dto: CreateIssueDto) {
    return this.issues.create(user.tenantId, user.sub, dto);
  }

  @Patch('issues/:id')
  @RequireGrant('pm', 'edit')
  updateIssue(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateIssueDto) {
    return this.issues.update(user.tenantId, user.sub, id, dto);
  }

  @Post('issues/:id/move-state')
  @RequireGrant('pm', 'edit')
  moveState(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: MoveStateDto) {
    return this.issues.moveState(user.tenantId, user.sub, id, dto.state_id);
  }

  @Post('issues/:id/priority')
  @RequireGrant('pm', 'edit')
  setPriority(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetPriorityDto) {
    return this.issues.setPriority(user.tenantId, user.sub, id, dto.priority);
  }

  @Post('issues/:id/assign')
  @RequireGrant('pm', 'edit')
  assign(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: AssignDto) {
    return this.issues.assign(user.tenantId, user.sub, id, dto.assignee_user_id ?? null);
  }

  @Post('issues/:id/rank')
  @RequireGrant('pm', 'edit')
  rank(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RankDto) {
    return this.issues.rank(user.tenantId, user.sub, id, dto);
  }

  @Post('issues/:id/move-team')
  @RequireGrant('pm', 'edit')
  moveTeam(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: { team_id: string }) {
    return this.issues.moveTeam(user.tenantId, user.sub, id, dto.team_id);
  }

  // ─── Team settings: states + labels (§4.2/§4.3, lead-gated in service) ────

  @Post('teams/:teamId/states')
  @RequireGrant('pm', 'edit')
  upsertState(
    @CurrentUser() user: JwtPayload,
    @Param('teamId') teamId: string,
    @Body() dto: { id?: string; name: string; color: string; category?: string; position?: number },
  ) {
    return this.teams.upsertState(user.tenantId, user.sub, user.role, teamId, dto);
  }

  @Post('labels')
  @RequireGrant('pm', 'edit')
  upsertLabel(
    @CurrentUser() user: JwtPayload,
    @Body() dto: { id?: string; team_id?: string | null; name: string; color: string; description?: string },
  ) {
    return this.teams.upsertLabel(user.tenantId, user.sub, user.role, dto);
  }

  // ─── Saved views + favorites (§9.4) ───────────────────────────────────────

  @Get('views')
  @RequireGrant('pm', 'view')
  listViews(@CurrentUser() user: JwtPayload, @Query('object_type') objectType?: string) {
    return this.views.list(user.tenantId, user.sub, objectType ?? 'pm_issue');
  }

  @Post('views')
  @RequireGrant('pm', 'edit')
  createView(
    @CurrentUser() user: JwtPayload,
    @Body() dto: { object_type: string; name: string; is_shared?: boolean; filters?: Record<string, unknown>; sort?: Record<string, unknown> },
  ) {
    return this.views.create(user.tenantId, user.sub, dto);
  }

  @Post('views/:id/favorite')
  @RequireGrant('pm', 'view')
  favoriteView(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: { favorite: boolean }) {
    return this.views.setFavorite(user.tenantId, user.sub, id, dto.favorite !== false);
  }

  @Post('views/:id/delete')
  @RequireGrant('pm', 'edit')
  deleteView(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.views.remove(user.tenantId, user.sub, id);
  }
}
