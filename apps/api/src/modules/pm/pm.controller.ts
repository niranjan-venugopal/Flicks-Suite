import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { PmGrantGuard } from '../../core/auth/guards/pm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { PmTeamsService } from './teams.service';
import { PmIssuesService } from './issues.service';
import { PmProjectsService } from './projects.service';
import { PmCyclesService } from './cycles.service';
import { PmSampleDataService } from './sample-data.service';
import { PmViewsService } from './views.service';
import { PmSearchService } from './search.service';
import { PmGithubService } from './github.service';
import { PmImportService } from './import.service';
import { PmTemplatesService } from './templates.service';
import { PmPublicService } from './public';
import { PmGuestsService } from './guests.service';

class InviteGuestDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsOptional() @IsString() @MaxLength(120) full_name?: string;
}

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
  // At-create project link (validated in-tenant; REQUIRED for guest callers)
  @IsOptional() @IsUUID() project_id?: string;
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

class CreateProjectDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(300) summary?: string;
  @IsOptional() @IsString() description_md?: string;
  @IsOptional() @IsString() @MaxLength(16) icon?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsIn(['backlog', 'planned', 'in_progress', 'paused', 'completed', 'canceled']) status?: string;
  @IsOptional() @IsUUID() lead_user_id?: string;
  @IsOptional() @IsString() start_date?: string;
  @IsOptional() @IsString() target_date?: string;
  @IsOptional() @IsUUID(undefined, { each: true }) team_ids?: string[];
  @IsOptional() @IsUUID() deal_id?: string;
}
class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(300) summary?: string | null;
  @IsOptional() @IsString() description_md?: string | null;
  @IsOptional() @IsString() @MaxLength(16) icon?: string | null;
  @IsOptional() @IsString() @MaxLength(16) color?: string | null;
  @IsOptional() @IsIn(['backlog', 'planned', 'in_progress', 'paused', 'completed', 'canceled']) status?: string;
  @IsOptional() @IsUUID() lead_user_id?: string | null;
  @IsOptional() start_date?: string | null;
  @IsOptional() target_date?: string | null;
}
class SetProjectTeamsDto {
  @IsUUID(undefined, { each: true }) team_ids!: string[];
}
class PostUpdateDto {
  @IsIn(['on_track', 'at_risk', 'off_track']) health!: string;
  @IsString() @MaxLength(4000) body_md!: string;
}
class CreateMilestoneDto {
  @IsUUID() project_id!: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() target_date?: string | null;
  @IsOptional() @IsInt() @Type(() => Number) position?: number;
}
class UpdateMilestoneDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() target_date?: string | null;
  @IsOptional() @IsInt() @Type(() => Number) position?: number;
}
class SetIssueProjectDto {
  @IsOptional() @IsUUID() project_id?: string | null;
  @IsOptional() @IsUUID() milestone_id?: string | null;
}
class CreateInitiativeDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsUUID() owner_user_id?: string;
  @IsOptional() @IsString() @MaxLength(16) target_quarter?: string;
}
class UpdateInitiativeDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsIn(['active', 'completed', 'paused']) status?: string;
  @IsOptional() @IsUUID() owner_user_id?: string | null;
  @IsOptional() @IsString() @MaxLength(16) target_quarter?: string | null;
}
class SetInitiativeProjectsDto {
  @IsUUID(undefined, { each: true }) project_ids!: string[];
}
class UpdateTeamConfigDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsBoolean() cycles_enabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(6) @Type(() => Number) cycle_length_weeks?: number;
  @IsOptional() @IsInt() @Min(0) @Max(7) @Type(() => Number) cooldown_days?: number;
  @IsOptional() @IsInt() @Min(0) @Max(6) @Type(() => Number) cycle_start_dow?: number;
  @IsOptional() @IsBoolean() cycle_auto_add_started?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(4) @Type(() => Number) upcoming_cycles?: number;
  @IsOptional() @IsBoolean() triage_enabled?: boolean;
  @IsOptional() @IsBoolean() is_private?: boolean;
  @IsOptional() @IsIn(['count', 'linear', 'fibonacci', 'exponential', 'tshirt']) estimate_scale?: string;
  // GitHub status automations (P16)
  @IsOptional() @IsBoolean() gh_auto_branch?: boolean;
  @IsOptional() @IsBoolean() gh_auto_pr_open?: boolean;
  @IsOptional() @IsBoolean() gh_auto_pr_merge?: boolean;
  @IsOptional() @IsBoolean() gh_auto_pr_close?: boolean;
  @IsOptional() @IsBoolean() gh_magic_words?: boolean;
  @IsOptional() @IsBoolean() gh_bot_comment?: boolean;
}
class SetIssueCycleDto {
  @IsOptional() @IsUUID() cycle_id?: string | null;
}
class TriageAcceptDto {
  @IsOptional() @IsInt() @Min(0) @Max(4) @Type(() => Number) priority?: number;
  @IsOptional() @IsUUID() assignee_user_id?: string | null;
}
class TriageDeclineDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class SnoozeDto {
  @IsOptional() @IsString() until?: string | null;
}
class GithubInstallDto {
  @IsInt() @Min(1) @Type(() => Number) installation_id!: number;
  @IsOptional() @IsString() @MaxLength(120) account_login?: string;
  /** One-shot nonce from POST github/install-url — proves this tenant installed it. */
  @IsString() @MaxLength(96) state!: string;
}
class GithubMapRepoDto {
  @IsString() @MaxLength(200) repo_full_name!: string;
  @IsUUID() team_id!: string;
  @IsOptional() @IsInt() @Type(() => Number) repo_id?: number;
}
class GithubBranchFormatDto {
  @IsString() @MaxLength(120) format!: string;
}
class PmImportParseDto {
  @IsString() @MaxLength(5_000_000) csv!: string;
  @IsOptional() @IsString() @MaxLength(200) file_name?: string;
}
class PmImportRunDto extends PmImportParseDto {
  @IsObject() @Type(() => Object) mapping!: Record<string, string>;
  @IsOptional() @IsIn(['skip', 'update']) strategy?: 'skip' | 'update';
  @IsIn(['linear', 'jira', 'csv']) preset!: 'linear' | 'jira' | 'csv';
}
class SaveTemplateDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(300) title_pattern?: string | null;
  @IsOptional() @IsString() description_md?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(4) @Type(() => Number) default_priority?: number | null;
  @IsOptional() @Type(() => Number) default_estimate?: number | null;
  @IsOptional() @IsBoolean() is_team_default?: boolean;
}
class FromDealDto {
  @IsUUID() deal_id!: string;
}
class TeamMemberDto {
  @IsUUID() user_id!: string;
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
    private readonly projects: PmProjectsService,
    private readonly cycles: PmCyclesService,
    private readonly sample: PmSampleDataService,
    private readonly views: PmViewsService,
    private readonly search_: PmSearchService,
    private readonly github: PmGithubService,
    private readonly import_: PmImportService,
    private readonly templates: PmTemplatesService,
    private readonly pub: PmPublicService,
    private readonly guests: PmGuestsService,
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

  @Patch('teams/:id')
  @RequireGrant('pm', 'edit')
  @ApiOperation({ summary: 'Team + cycle config (Owner/Admin or team lead)' })
  updateTeam(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateTeamConfigDto) {
    return this.teams.updateConfig(user.tenantId, user.sub, user.role, id, dto);
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
    @Query('project_id') projectId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.issues.list(user.tenantId, user.sub, {
      team_id: teamId,
      project_id: projectId,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('issues/:id')
  @RequireGrant('pm', 'view')
  getIssue(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.issues.get(user.tenantId, user.sub, id);
  }

  @Get('issues/:id/detail')
  @RequireGrant('pm', 'view')
  issueDetail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.issues.detail(user.tenantId, user.sub, id);
  }

  @Post('issues/:id/comments')
  @RequireGrant('pm', 'edit')
  createComment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: { body: string; parent_comment_id?: string | null; mentioned_user_ids?: string[] },
  ) {
    return this.issues.createComment(user.tenantId, user.sub, id, dto);
  }

  @Post('issues/:id/relate')
  @RequireGrant('pm', 'edit')
  relate(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: { related_issue_id: string; type: 'blocks' | 'duplicate_of' | 'relates_to' },
  ) {
    return this.issues.relate(user.tenantId, user.sub, id, dto);
  }

  @Get('search')
  @RequireGrant('pm', 'view')
  search(@CurrentUser() user: JwtPayload, @Query('q') q?: string) {
    return this.search_.search(user.tenantId, user.sub, q ?? '');
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

  // ─── Team membership + lifecycle (§4.4, P15) ──────────────────────────────

  @Post('teams/:teamId/members')
  @RequireGrant('pm', 'edit')
  addTeamMember(@CurrentUser() user: JwtPayload, @Param('teamId') teamId: string, @Body() dto: TeamMemberDto) {
    return this.teams.addMember(user.tenantId, user.sub, user.role, teamId, dto.user_id);
  }

  @Post('teams/:teamId/members/:userId/remove')
  @RequireGrant('pm', 'edit')
  removeTeamMember(@CurrentUser() user: JwtPayload, @Param('teamId') teamId: string, @Param('userId') userId: string) {
    return this.teams.removeMember(user.tenantId, user.sub, user.role, teamId, userId);
  }

  @Post('teams/:teamId/join')
  @RequireGrant('pm', 'edit')
  joinTeam(@CurrentUser() user: JwtPayload, @Param('teamId') teamId: string) {
    return this.teams.joinTeam(user.tenantId, user.sub, teamId);
  }

  @Post('teams/:teamId/delete')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  deleteTeam(@CurrentUser() user: JwtPayload, @Param('teamId') teamId: string) {
    return this.teams.deleteTeam(user.tenantId, user.sub, teamId);
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

  // ─── Projects + milestones + updates (§6) ─────────────────────────────────

  @Get('projects')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'Visible projects + team links + computed progress' })
  listProjects(@CurrentUser() user: JwtPayload) {
    return this.projects.list(user.tenantId, user.sub);
  }

  @Get('projects/:id/detail')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'Lazy detail: description, milestones, updates, issues, members' })
  projectDetail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.projects.detail(user.tenantId, user.sub, id);
  }

  @Post('projects')
  @RequireGrant('pm', 'edit')
  createProject(@CurrentUser() user: JwtPayload, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.tenantId, user.sub, dto);
  }

  @Patch('projects/:id')
  @RequireGrant('pm', 'edit')
  updateProject(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(user.tenantId, user.sub, id, dto as Record<string, unknown>);
  }

  @Post('projects/:id/teams')
  @RequireGrant('pm', 'edit')
  setProjectTeams(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetProjectTeamsDto) {
    return this.projects.setTeams(user.tenantId, user.sub, id, dto.team_ids);
  }

  @Post('projects/:id/updates')
  @RequireGrant('pm', 'edit')
  @ApiOperation({ summary: 'Post a health update (§6.3) — latest health denormalizes' })
  postProjectUpdate(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: PostUpdateDto) {
    return this.projects.postUpdate(user.tenantId, user.sub, id, dto);
  }

  @Post('projects/:id/delete')
  @RequireGrant('pm', 'edit')
  deleteProject(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.projects.softDelete(user.tenantId, user.sub, id);
  }

  @Post('projects/:id/restore')
  @RequireGrant('pm', 'edit')
  restoreProject(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.projects.restore(user.tenantId, user.sub, id);
  }

  // ─── Guest seats (round 7) — admin+ (it mints a workspace membership,
  //     mirroring invite-auditor) ─────────────────────────────────────────────

  @Post('projects/:id/guests')
  @RequireGrant('pm', 'edit')
  @Roles('admin')
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Invite an external guest to exactly this project' })
  inviteGuest(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: InviteGuestDto) {
    return this.guests.invite(user.tenantId, user.sub, id, dto);
  }

  @Get('projects/:id/guests')
  @RequireGrant('pm', 'view')
  @Roles('admin')
  listGuests(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.guests.list(user.tenantId, id);
  }

  @Post('projects/:id/guests/:userId/remove')
  @RequireGrant('pm', 'edit')
  @Roles('admin')
  revokeGuest(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.guests.revoke(user.tenantId, user.sub, id, userId);
  }

  @Post('milestones')
  @RequireGrant('pm', 'edit')
  createMilestone(@CurrentUser() user: JwtPayload, @Body() dto: CreateMilestoneDto) {
    return this.projects.createMilestone(user.tenantId, user.sub, dto);
  }

  @Patch('milestones/:id')
  @RequireGrant('pm', 'edit')
  updateMilestone(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateMilestoneDto) {
    return this.projects.updateMilestone(user.tenantId, user.sub, id, dto);
  }

  @Post('milestones/:id/delete')
  @RequireGrant('pm', 'edit')
  deleteMilestone(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.projects.deleteMilestone(user.tenantId, user.sub, id);
  }

  @Post('issues/:id/project')
  @RequireGrant('pm', 'edit')
  setIssueProject(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetIssueProjectDto) {
    return this.issues.setProject(user.tenantId, user.sub, id, {
      project_id: dto.project_id ?? null,
      milestone_id: dto.milestone_id,
    });
  }

  // ─── Initiatives (§6.4 — Manager+) ────────────────────────────────────────

  @Get('initiatives')
  @RequireGrant('pm', 'view')
  listInitiatives(@CurrentUser() user: JwtPayload) {
    return this.projects.listInitiatives(user.tenantId, user.sub);
  }

  @Post('initiatives')
  @RequireGrant('pm', 'edit')
  createInitiative(@CurrentUser() user: JwtPayload, @Body() dto: CreateInitiativeDto) {
    return this.projects.createInitiative(user.tenantId, user.sub, user.role, dto);
  }

  @Patch('initiatives/:id')
  @RequireGrant('pm', 'edit')
  updateInitiative(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateInitiativeDto) {
    return this.projects.updateInitiative(user.tenantId, user.sub, user.role, id, dto);
  }

  @Post('initiatives/:id/projects')
  @RequireGrant('pm', 'edit')
  setInitiativeProjects(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetInitiativeProjectsDto) {
    return this.projects.setInitiativeProjects(user.tenantId, user.sub, user.role, id, dto.project_ids);
  }

  // ─── Cycles (§7) + triage (§8) ────────────────────────────────────────────

  @Get('teams/:teamId/cycles')
  @RequireGrant('pm', 'view')
  @ApiOperation({ summary: 'Cycles + active snapshots + stats (velocity/completion/creep)' })
  teamCycles(@CurrentUser() user: JwtPayload, @Param('teamId') teamId: string) {
    return this.cycles.teamCycles(user.tenantId, user.sub, teamId);
  }

  @Post('issues/:id/cycle')
  @RequireGrant('pm', 'edit')
  setIssueCycle(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetIssueCycleDto) {
    return this.issues.setCycle(user.tenantId, user.sub, id, { cycle_id: dto.cycle_id ?? null });
  }

  @Post('issues/:id/send-to-triage')
  @RequireGrant('pm', 'edit')
  sendToTriage(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.issues.sendToTriage(user.tenantId, user.sub, id);
  }

  @Post('issues/:id/triage-accept')
  @RequireGrant('pm', 'edit')
  triageAccept(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: TriageAcceptDto) {
    return this.issues.triageAccept(user.tenantId, user.sub, id, dto);
  }

  @Post('issues/:id/triage-decline')
  @RequireGrant('pm', 'edit')
  triageDecline(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: TriageDeclineDto) {
    return this.issues.triageDecline(user.tenantId, user.sub, id, dto.reason ?? null);
  }

  @Post('issues/:id/snooze')
  @RequireGrant('pm', 'edit')
  snoozeIssue(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SnoozeDto) {
    return this.issues.snooze(user.tenantId, user.sub, id, dto.until ?? null);
  }

  // ─── Appendix B sample data ───────────────────────────────────────────────

  @Get('sample-data')
  @RequireGrant('pm', 'view')
  sampleStatus(@CurrentUser() user: JwtPayload) {
    return this.sample.status(user.tenantId);
  }

  @Post('sample-data')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin', 'manager')
  sampleSeed(@CurrentUser() user: JwtPayload) {
    return this.sample.seed(user.tenantId, user.sub);
  }

  @Post('sample-data/remove')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin', 'manager')
  sampleRemove(@CurrentUser() user: JwtPayload) {
    return this.sample.remove(user.tenantId, user.sub);
  }

  // ─── GitHub integration (§12, P16) ────────────────────────────────────────

  @Get('github/status')
  @RequireGrant('pm', 'view')
  @Roles('employee') // members only — not part of a guest's project scope
  githubStatus(@CurrentUser() user: JwtPayload) {
    return this.github.status(user.tenantId, user.sub);
  }

  /** Mint the GitHub install URL + state nonce (the claim below requires it). */
  @Post('github/install-url')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  githubInstallUrl(@CurrentUser() user: JwtPayload) {
    return this.github.startInstall(user.tenantId, user.sub);
  }

  @Post('github/install')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  githubInstall(@CurrentUser() user: JwtPayload, @Body() dto: GithubInstallDto) {
    return this.github.claimInstallation(user.tenantId, user.sub, dto);
  }

  @Post('github/uninstall')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  githubUninstall(@CurrentUser() user: JwtPayload) {
    return this.github.uninstall(user.tenantId, user.sub);
  }

  @Post('github/repos')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  githubMapRepo(@CurrentUser() user: JwtPayload, @Body() dto: GithubMapRepoDto) {
    return this.github.mapRepo(user.tenantId, user.sub, dto);
  }

  @Post('github/repos/:id/delete')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  githubUnmapRepo(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.github.unmapRepo(user.tenantId, user.sub, id);
  }

  @Patch('github/branch-format')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  githubBranchFormat(@CurrentUser() user: JwtPayload, @Body() dto: GithubBranchFormatDto) {
    return this.github.setBranchFormat(user.tenantId, user.sub, dto.format);
  }

  @Post('github/redeliver')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  githubRedeliver(@CurrentUser() user: JwtPayload) {
    return this.github.redeliver(user.tenantId, user.sub);
  }

  // ─── Importers (§14, P17) ─────────────────────────────────────────────────

  @Post('import/parse')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin', 'manager')
  importParse(@Body() dto: PmImportParseDto) {
    return this.import_.parse(dto);
  }

  @Post('import/dry-run')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin', 'manager')
  importDryRun(@CurrentUser() user: JwtPayload, @Body() dto: PmImportRunDto) {
    return this.import_.dryRun(user.tenantId, user.sub, dto);
  }

  @Post('import/run')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin', 'manager')
  importRun(@CurrentUser() user: JwtPayload, @Body() dto: PmImportRunDto) {
    return this.import_.run(user.tenantId, user.sub, dto);
  }

  @Get('import/batches')
  @RequireGrant('pm', 'view')
  @Roles('employee') // members only — not part of a guest's project scope
  importBatches(@CurrentUser() user: JwtPayload) {
    return this.import_.batches(user.tenantId, user.sub);
  }

  @Post('import/:id/undo')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin', 'manager')
  importUndo(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.import_.undo(user.tenantId, user.sub, id);
  }

  // ─── Issue templates (§15.5, P15) ─────────────────────────────────────────

  @Get('teams/:teamId/templates')
  @RequireGrant('pm', 'view')
  listTemplates(@CurrentUser() user: JwtPayload, @Param('teamId') teamId: string) {
    return this.templates.list(user.tenantId, user.sub, teamId);
  }

  @Post('teams/:teamId/templates')
  @RequireGrant('pm', 'edit')
  saveTemplate(@CurrentUser() user: JwtPayload, @Param('teamId') teamId: string, @Body() dto: SaveTemplateDto) {
    return this.templates.save(user.tenantId, user.sub, teamId, dto);
  }

  @Post('teams/:teamId/templates/:id/delete')
  @RequireGrant('pm', 'edit')
  deleteTemplate(@CurrentUser() user: JwtPayload, @Param('teamId') teamId: string, @Param('id') id: string) {
    return this.templates.remove(user.tenantId, user.sub, teamId, id);
  }

  // ─── Deal → project (§15.2) ───────────────────────────────────────────────

  @Post('projects/from-deal')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin', 'manager')
  createFromDeal(@CurrentUser() user: JwtPayload, @Body() dto: FromDealDto) {
    return this.pub.createProjectFromDeal(user.tenantId, user.sub, dto.deal_id);
  }

  @Get('projects/by-deal/:dealId')
  @RequireGrant('pm', 'view')
  @Roles('employee') // members only — not part of a guest's project scope
  projectByDeal(@CurrentUser() user: JwtPayload, @Param('dealId') dealId: string) {
    return this.pub.projectForDeal(user.tenantId, user.sub, dealId);
  }

  // ─── Recently deleted (§15.4, P18) ────────────────────────────────────────

  @Get('recently-deleted')
  @RequireGrant('pm', 'view')
  recentlyDeleted(@CurrentUser() user: JwtPayload) {
    return this.teams.recentlyDeleted(user.tenantId, user.sub);
  }

  @Post('issues/:id/restore')
  @RequireGrant('pm', 'edit')
  restoreIssue(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.issues.restore(user.tenantId, user.sub, id);
  }

  @Post('recently-deleted/:kind/:id/purge')
  @RequireGrant('pm', 'edit')
  @Roles('owner', 'admin')
  purgeDeleted(
    @CurrentUser() user: JwtPayload,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ) {
    return this.teams.purgeDeleted(user.tenantId, user.sub, kind, id);
  }
}
