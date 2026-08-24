import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { Public } from './core/auth/decorators/public.decorator';
import { DB_SERVICE_ROLE } from './core/database/database.module';
import type { DbAdmin } from '@flicks/db';

// Health probes, mounted at the root (excluded from the api/v1 prefix in
// main.ts) so the URLs are simply https://api.flickssuite.com/healthz|readyz.
//
//   /healthz  — LIVENESS: process up. Always 200 while Node is running.
//               This is what Railway's deploy health check points at.
//   /readyz   — READINESS: real `SELECT 1` against Postgres (3s cap) with
//               dbLatencyMs. This is what the uptime monitor points at.
//
// The split matters operationally: /healthz used to probe the DB too, which
// meant a Supabase outage made EVERY new Railway deploy fail its health
// check — the platform kept the previous (equally broken) container and new
// code could not ship until the DB recovered (2026-08-24 incident). Liveness
// must reflect only the process so deploys always roll forward; DB health is
// the monitor's job via /readyz.
@ApiTags('Health')
@Controller()
@SkipThrottle() // uptime monitors / platform probes poll frequently — never rate-limit
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(@Inject(DB_SERVICE_ROLE) private readonly db: DbAdmin) {}

  /** Race the DB probe against a 3s cap; returns latency ms or throws. */
  private async probeDb(): Promise<number> {
    const t0 = Date.now();
    await Promise.race([
      this.db.execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('db timeout')), 3000),
      ),
    ]);
    return Date.now() - t0;
  }

  @Public()
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe — process up, no dependencies (public)' })
  check() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe — DB reachability + query latency (public)' })
  async ready() {
    let latencyMs: number;
    try {
      // Cap the probe at 3s: if Postgres is unreachable the driver's connect
      // can hang far longer than any monitor's request timeout — return a
      // fast, explicit 503 instead.
      latencyMs = await this.probeDb();
    } catch {
      throw new ServiceUnavailableException({ status: 'not-ready', database: 'down' });
    }
    return { status: 'ready', database: 'up', dbLatencyMs: latencyMs, timestamp: new Date().toISOString() };
  }
}
