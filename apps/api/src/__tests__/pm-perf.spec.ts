import 'dotenv/config';
import * as crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, memberships, pmTeams, pmWorkflowStates, pmIssues, pmTeamCounters, domainEvents } from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmSearchService } from '../modules/pm/search.service';

/**
 * PRD v6 §21 — the 10k-issue reference workspace + CI perf budgets.
 * Budgets (server-side, local PG): bootstrap < 2s, delta < 150ms P95,
 * search < 200ms P95. These are the §3.9/§21 acceptance numbers; the spike
 * gate measured the client half (optimistic 1.6ms, propagation ~420ms).
 */

const ISSUES = 10_000;
const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc);
const searchSvc = new PmSearchService(dbSvc, visibility);

let tenantId: string;
let ownerId: string;

const p95 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;

jest.setTimeout(180_000);

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `Perf ${rid()}`, slug: `perf-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `perf-${rid()}@t.test`, full_name: 'Perf Owner', status: 'active' })
    .returning();
  ownerId = u!.id;
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: ownerId, role: 'owner', status: 'active' });
  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId));
  const states = await dbAdmin.select().from(pmWorkflowStates).where(eq(pmWorkflowStates.team_id, team!.id));

  // Reference seeder — 10k issues in 500-row chunks (~2s total).
  const words = ['auth', 'billing', 'sync', 'search', 'board', 'triage', 'cycle', 'export', 'mobile', 'perf'];
  for (let base = 0; base < ISSUES; base += 500) {
    await dbAdmin.insert(pmIssues).values(
      Array.from({ length: Math.min(500, ISSUES - base) }, (_, i) => {
        const n = base + i + 1;
        return {
          tenant_id: tenantId,
          team_id: team!.id,
          number: n,
          title: `${words[n % words.length]} case ${n} — reference issue`,
          state_id: states[n % states.length]!.id,
          priority: n % 5,
          creator_user_id: ownerId,
          board_rank: `r${String(n).padStart(6, '0')}`,
          backlog_rank: `r${String(n).padStart(6, '0')}`,
          source: 'manual',
        };
      }),
    );
  }
  await dbAdmin.update(pmTeamCounters).set({ last_number: ISSUES }).where(eq(pmTeamCounters.team_id, team!.id));
  // A spread of outbox events so delta has a realistic window to scan.
  for (let i = 0; i < 50; i++) {
    await domainEventsSvc.publish({
      name: 'pm.issue.updated',
      tenantId,
      actorUserId: ownerId,
      payload: { issue_id: crypto.randomUUID(), sync: [] },
    });
  }
});

afterAll(async () => {
  await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, ownerId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Perf budgets @10k issues (§21)', () => {
  it(`bootstrap streams the 10k-issue workspace in < 2s`, async () => {
    const t0 = performance.now();
    const lines = await syncSvc.bootstrap(tenantId, ownerId);
    const ms = performance.now() - t0;
    const issueLines = lines.filter((l) => l.includes('"pm_issues"')).length;
    expect(issueLines).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`bootstrap: ${ms.toFixed(0)}ms for ${lines.length} lines`);
    expect(ms).toBeLessThan(2_000);
  });

  it('delta P95 < 150ms over 10 pulls', async () => {
    const [{ min }] = await dbAdmin
      .select({ min: sql<number>`coalesce(min(${domainEvents.sync_seq}), 0)` })
      .from(domainEvents)
      .where(eq(domainEvents.tenant_id, tenantId));
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await syncSvc.delta(tenantId, ownerId, Number(min));
      times.push(performance.now() - t0);
    }
    // eslint-disable-next-line no-console
    console.log(`delta p95: ${p95(times).toFixed(0)}ms`);
    expect(p95(times)).toBeLessThan(150);
  });

  it('search P95 < 200ms over 10 queries (FTS + trigram + key)', async () => {
    const queries = ['auth', 'billing case', 'sync', 'perf', 'search', 'boa', 'cycle', 'export', 'mobile', 'case 42'];
    const times: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      await searchSvc.search(tenantId, ownerId, q);
      times.push(performance.now() - t0);
    }
    // eslint-disable-next-line no-console
    console.log(`search p95: ${p95(times).toFixed(0)}ms`);
    expect(p95(times)).toBeLessThan(200);
  });
});
