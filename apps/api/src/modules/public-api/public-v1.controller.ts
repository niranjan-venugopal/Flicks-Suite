import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { tenants } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { Public } from '../../core/auth/decorators/public.decorator';
import { ApiKeyGuard, type PublicApiRequest } from './api-key.guard';

/**
 * Public REST API v1 (PRD v5 §11) — key-authenticated, tenant derived from
 * the key, per-key rate-limited in the guard (own limiter → platform
 * throttler skipped). Sprint 24 ships the framework + /me; CRM resource
 * endpoints (people/companies/deals/leads/activities) mount here in Sprint 30.
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
  constructor(@Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin) {}

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
}
