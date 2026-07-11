import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  attendanceRecords,
  attendanceRegularizations,
  leaveRequests,
  leaveTypes,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { PresenceService, type LiveActivity } from '../modules/presence/presence.service';

/**
 * PRD v4 §5 — presence resolution (Sprint 18). Real-Postgres integration:
 * manual-wins, expiry, leave → OOO (online → Available · OOO), open punch →
 * In office, WFH → Available · Remote, connection/idle/offline tiers.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const presence = new PresenceService(dbAdmin as never, dbSvc);
const today = new Date().toISOString().slice(0, 10);

const live = (connected: boolean, agoMs: number): Map<string, LiveActivity> =>
  new Map();

describe('Presence resolution (PRD v4 §5)', () => {
  let tenantId: string;
  let userId: string;
  let employeeId: string;

  const activity = (connected: boolean, agoMs: number) =>
    new Map<string, LiveActivity>([
      [userId, { connected, lastActivityAt: Date.now() - agoMs }],
    ]);

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `PresCo${rid()}`, slug: `pres-${rid()}-${Date.now()}`, status: 'trialing' })
      .returning();
    tenantId = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `pres-${rid()}@test.test`, full_name: 'Pres User', status: 'active' })
      .returning();
    userId = u!.id;
    const [e] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId,
        user_id: userId,
        employee_code: `EMP-${rid()}`,
        first_name: 'Pres',
        last_name: 'User',
        work_email: u!.email,
        date_of_joining: '2025-01-01',
      })
      .returning();
    employeeId = e!.id;
    await dbAdmin.insert(memberships).values({
      tenant_id: tenantId,
      user_id: userId,
      employee_id: employeeId,
      role: 'employee',
      status: 'active',
    });
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    await dbAdmin.delete(users).where(eq(users.id, userId));
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  afterEach(async () => {
    // Clean per-scenario signals so tests stay independent.
    await dbAdmin.delete(leaveRequests).where(eq(leaveRequests.tenant_id, tenantId));
    await dbAdmin.delete(attendanceRecords).where(eq(attendanceRecords.tenant_id, tenantId));
    await dbAdmin.delete(attendanceRegularizations).where(eq(attendanceRegularizations.tenant_id, tenantId));
    await presence.clearStatus(tenantId, userId).catch(() => {});
  });

  it('connection tiers: active → available · idle>10m → away · disconnected → offline', async () => {
    let [r] = await presence.resolve(tenantId, [userId], activity(true, 1_000));
    expect(r!.status).toBe('available');
    [r] = await presence.resolve(tenantId, [userId], activity(true, 15 * 60 * 1000));
    expect(r!.status).toBe('away');
    [r] = await presence.resolve(tenantId, [userId], new Map());
    expect(r!.status).toBe('offline');
  });

  it('manual status wins over auto, and an expired manual falls back', async () => {
    await presence.setStatus(tenantId, userId, {
      status: 'busy',
      message: 'Sprint planning till 3',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    let [r] = await presence.resolve(tenantId, [userId], activity(true, 1_000));
    expect(r!.status).toBe('busy');
    expect(r!.message).toBe('Sprint planning till 3');
    expect(r!.manual).toBe(true);

    // Expired manual → auto takes over (Busy(1h) auto-reverts, §5 acceptance).
    await presence.setStatus(tenantId, userId, {
      status: 'busy',
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    [r] = await presence.resolve(tenantId, [userId], activity(true, 1_000));
    expect(r!.status).toBe('available');
    expect(r!.manual).toBe(false);
  });

  it('approved leave today → Out of office; still online → Available · Out of office', async () => {
    const [lt] = await dbAdmin
      .insert(leaveTypes)
      .values({ tenant_id: tenantId, code: `CL${rid().slice(0, 3)}`, name: 'Casual' })
      .returning();
    await dbAdmin.insert(leaveRequests).values({
      tenant_id: tenantId,
      employee_id: employeeId,
      leave_type_id: lt!.id,
      start_date: today,
      end_date: today,
      total_days: 1,
      status: 'approved',
      reason: 'presence test',
    });
    let [r] = await presence.resolve(tenantId, [userId], new Map());
    expect(r!.status).toBe('out_of_office');
    [r] = await presence.resolve(tenantId, [userId], activity(true, 1_000));
    expect(r!.status).toBe('ooo_available');
  });

  it('open punch → In office; with approved WFH today → Available · Remote', async () => {
    await dbAdmin.insert(attendanceRecords).values({
      tenant_id: tenantId,
      employee_id: employeeId,
      attendance_date: today,
      first_punch_in_at: new Date(),
      last_punch_out_at: null,
    });
    let [r] = await presence.resolve(tenantId, [userId], activity(true, 1_000));
    expect(r!.status).toBe('in_office');

    await dbAdmin.insert(attendanceRegularizations).values({
      tenant_id: tenantId,
      employee_id: employeeId,
      attendance_date: today,
      request_type: 'wfh_request',
      status: 'approved',
      reason: 'presence test',
    });
    [r] = await presence.resolve(tenantId, [userId], activity(true, 1_000));
    expect(r!.status).toBe('remote_available');
  });

  it('userIdForEmployee bridges leave-approval events to presence', async () => {
    expect(await presence.userIdForEmployee(tenantId, employeeId)).toBe(userId);
  });
});

describe('Presence liveness store — Redis (PRD v4 §5.2)', () => {
  // Minimal in-memory Redis stub covering exactly what the gateway uses
  // (set EX / get / mget / del) — hermetic, no live Redis in CI.
  function redisStub() {
    const store = new Map<string, string>();
    return {
      store,
      set: async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      },
      get: async (k: string) => store.get(k) ?? null,
      mget: async (...keys: Array<string | string[]>) => {
        const flat = keys.flat();
        return flat.map((k) => store.get(k) ?? null);
      },
      del: async (k: string) => (store.delete(k) ? 1 : 0),
    };
  }

  it('buildActivity MGETs per-user keys → connected + lastActivityAt; missing key → absent', async () => {
    const { PresenceGateway } = await import('../gateways/presence.gateway');
    const redis = redisStub();
    const gateway = new PresenceGateway(
      {} as never, // jwtService — not used by buildActivity
      {} as never, // configService — not used by buildActivity
      presence,
      redis as never,
    );
    const ts = Date.now() - 5_000;
    redis.store.set('presence:last:t1:alice', String(ts));

    const map = await gateway.buildActivity('t1', ['alice', 'bob']);
    expect(map.get('alice')).toEqual({ connected: true, lastActivityAt: ts });
    expect(map.has('bob')).toBe(false); // no key → not connected
    expect((await gateway.buildActivity('t1', [])).size).toBe(0);
  });

  it('degrades to empty activity (everyone offline) when Redis is unreachable', async () => {
    const { PresenceGateway } = await import('../gateways/presence.gateway');
    const broken = {
      mget: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const gateway = new PresenceGateway({} as never, {} as never, presence, broken as never);
    const map = await gateway.buildActivity('t1', ['alice']);
    expect(map.size).toBe(0);
  });
});
