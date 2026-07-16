import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { and, asc, eq } from 'drizzle-orm';
import { memberships, tenants } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { Public } from '../../core/auth/decorators/public.decorator';
import { ApiKeyGuard, ApiScopes, type PublicApiRequest } from './api-key.guard';
import { CrmPublicService } from '../crm/public';

class ApiPersonDto {
  @IsOptional() @IsString() @MaxLength(120) first_name?: string;
  @IsOptional() @IsString() @MaxLength(120) last_name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() company_id?: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
}

class ApiCompanyDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(200) domain?: string;
  @IsOptional() @IsString() @MaxLength(500) website?: string;
}

class ApiDealDto {
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsString() pipeline_id?: string;
  @IsOptional() @IsString() stage_id?: string;
  @IsOptional() @IsString() company_id?: string;
  @IsOptional() @IsString() primary_person_id?: string;
  @IsOptional() @IsString() owner_user_id?: string;
  @IsOptional() @IsNumber() value_amount?: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
}

class ApiLeadDto {
  @IsOptional() @IsString() @MaxLength(120) first_name?: string;
  @IsOptional() @IsString() @MaxLength(120) last_name?: string;
  @IsOptional() @IsString() @MaxLength(200) company_name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
  @IsOptional() @IsString() owner_user_id?: string;
}

/**
 * Public REST API v1 (PRD v5 §11/§13) — key-authenticated, tenant derived from
 * the key, per-key rate-limited in the guard (own limiter → platform
 * throttler skipped). Sprint 30 mounts the CRM resources: people, companies,
 * deals, leads. Writes act as the workspace owner (audit shows the key's
 * tenant owner as actor) and flow through the SAME services the UI uses —
 * RLS scoping, FX snapshots, dedupe and domain events all apply.
 *
 * Path note: 'api/public/v1' is excluded from the app's 'api/v1' global
 * prefix, so this really serves at /api/public/v1/*.
 */
@ApiTags('public-api')
@Public()
@SkipThrottle()
@UseGuards(ApiKeyGuard)
@Controller('api/public/v1')
export class PublicV1Controller {
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly crm: CrmPublicService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Identify the calling key: workspace + scopes (a connectivity ping)' })
  async me(@Req() req: PublicApiRequest) {
    const ctx = req.apiKey!;
    const [t] = await this.dbAdmin
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1);
    return {
      data: {
        workspace: t ? { id: t.id, name: t.name, slug: t.slug } : null,
        scopes: ctx.scopes,
        rate_limit_per_minute: 120,
      },
    };
  }

  // ─── Directory ───────────────────────────────────────────────────────────────

  @Get('people')
  @ApiScopes('directory:read')
  people(@Req() req: PublicApiRequest, @Query('q') q?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.crm.listPeople(req.apiKey!.tenantId, { q, page: num(page), limit: num(limit) });
  }

  @Post('people')
  @ApiScopes('directory:write')
  async createPerson(@Req() req: PublicApiRequest, @Body() dto: ApiPersonDto) {
    return this.crm.createPerson(req.apiKey!.tenantId, await this.actor(req), dto);
  }

  @Get('companies')
  @ApiScopes('directory:read')
  companies(@Req() req: PublicApiRequest, @Query('q') q?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.crm.listCompanies(req.apiKey!.tenantId, { q, page: num(page), limit: num(limit) });
  }

  @Post('companies')
  @ApiScopes('directory:write')
  async createCompany(@Req() req: PublicApiRequest, @Body() dto: ApiCompanyDto) {
    return this.crm.createCompany(req.apiKey!.tenantId, await this.actor(req), dto);
  }

  // ─── Deals ───────────────────────────────────────────────────────────────────

  @Get('deals/:id')
  @ApiScopes('crm:read')
  deal(@Req() req: PublicApiRequest, @Param('id') id: string) {
    return this.crm.getDeal(req.apiKey!.tenantId, id);
  }

  @Post('deals')
  @ApiScopes('crm:write')
  @ApiOperation({ summary: 'Create a deal (same FX/stage rules as the UI; source is stamped "api")' })
  async createDeal(@Req() req: PublicApiRequest, @Body() dto: ApiDealDto) {
    return this.crm.createDeal(req.apiKey!.tenantId, await this.actor(req), { ...dto, source: 'api' });
  }

  // ─── Leads ───────────────────────────────────────────────────────────────────

  @Get('leads')
  @ApiScopes('crm:read')
  leadsList(@Req() req: PublicApiRequest, @Query('status') status?: string) {
    return this.crm.listLeads(req.apiKey!.tenantId, status);
  }

  @Post('leads')
  @ApiScopes('crm:write')
  @ApiOperation({ summary: 'Push a lead into the inbox (source "api"; scoring + workflows fire as usual)' })
  async createLead(@Req() req: PublicApiRequest, @Body() dto: ApiLeadDto) {
    return this.crm.createLead(req.apiKey!.tenantId, await this.actor(req), { ...dto, source: 'api' });
  }

  /** Writes act as the workspace owner — the oldest active owner membership. */
  private async actor(req: PublicApiRequest): Promise<string> {
    const [m] = await this.dbAdmin
      .select({ user_id: memberships.user_id })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, req.apiKey!.tenantId), eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.created_at))
      .limit(1);
    if (!m) throw new BadRequestException('Workspace has no active owner');
    return m.user_id;
  }
}

function num(v?: string): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}
