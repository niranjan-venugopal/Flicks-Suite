import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from './core/auth/decorators/public.decorator';
import { DB_SERVICE_ROLE } from './core/database/database.module';
import type { DbAdmin } from '@flicks/db';

// Liveness + readiness probe for Better Stack (and any other uptime
// monitor). Mounted at the root (excluded from the api/v1 prefix in
// main.ts) so the monitor URL is simply https://api.flickssuite.com/healthz.
@ApiTags('Health')
@Controller('healthz')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(@Inject(DB_SERVICE_ROLE) private readonly db: DbAdmin) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness + DB readiness probe (public)' })
  async check() {
    try {
      // Cap the probe at 3s. If Postgres is unreachable the driver's connect
      // can hang far longer than any monitor's request timeout — we'd rather
      // return a fast, explicit 503 than let the request stall.
      await Promise.race([
        this.db.execute(sql`select 1`),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('db timeout')), 3000),
        ),
      ]);
    } catch {
      // 503 so the monitor marks the service down when Postgres is
      // unreachable, not just when the process is dead.
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'down',
      });
    }

    return {
      status: 'ok',
      database: 'up',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }
}
