/**
 * Multi-Tenant Isolation Test Suite (PRD Section 2.3 — Gate 1)
 *
 * These 10 tests MUST ALL PASS before any PR can merge.
 * They are the single most important security control in the codebase.
 *
 * Creates two tenants, seeds distinct data in each, and asserts
 * that no query from tenant A can access tenant B's data.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql, eq } from 'drizzle-orm';
import * as schema from '@flicks/db/schema';

// ─── Test Setup ──────────────────────────────────────────────────────────────
// Two connections by design:
//   • appClient — uses the app role (NOBYPASSRLS). All test assertions go
//     through this client so RLS policies are actually enforced.
//   • adminClient — uses the service role (BYPASSRLS). Used only for
//     setup/teardown to seed and clean up across tenants.

const APP_DB_URL =
  process.env['DATABASE_URL'] ||
  'postgresql://flicks_app:flicks_app@127.0.0.1:5432/flicks_suite';
const ADMIN_DB_URL =
  process.env['DATABASE_SERVICE_ROLE_URL'] ||
  'postgresql://postgres:postgres@127.0.0.1:5432/flicks_suite';

const appClient = postgres(APP_DB_URL, { max: 5 });
const adminClient = postgres(ADMIN_DB_URL, { max: 2 });
const db = drizzle(appClient, { schema });
const dbAdmin = drizzle(adminClient, { schema });

// Helper: run inside a transaction with tenant context set
async function withTestTenant<T>(
  tenantId: string,
  callback: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`,
    );
    return callback(tx as unknown as typeof db);
  });
}

// Helper: create a minimal tenant (admin connection — tenants table has no RLS)
async function createTestTenant(name: string) {
  const [tenant] = await dbAdmin
    .insert(schema.tenants)
    .values({
      name,
      slug: `test-${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'trialing',
    })
    .returning();
  return tenant!;
}

// Helper: create a minimal user (admin connection — users table has no RLS)
async function createTestUser(email: string) {
  const [user] = await dbAdmin
    .insert(schema.users)
    .values({
      email,
      full_name: email.split('@')[0]!,
      status: 'active',
    })
    .returning();
  return user!;
}

// Helper: create a minimal employee (admin connection bypasses RLS for setup)
async function createTestEmployee(
  tenantId: string,
  email: string,
  code: string,
) {
  const user = await createTestUser(email);
  const [emp] = await dbAdmin
    .insert(schema.employees)
    .values({
      tenant_id: tenantId,
      user_id: user.id,
      employee_code: code,
      first_name: email.split('@')[0]!,
      last_name: 'Test',
      work_email: email,
      employment_type: 'full_time',
      date_of_joining: new Date().toISOString().split('T')[0]!,
      status: 'active',
    })
    .returning();
  return emp!;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Multi-Tenant RLS Isolation (Gate 1 — PRD Section 2.3)', () => {
  let tenantA: typeof schema.tenants.$inferSelect;
  let tenantB: typeof schema.tenants.$inferSelect;
  let employeeA: typeof schema.employees.$inferSelect;
  let employeeB: typeof schema.employees.$inferSelect;

  beforeAll(async () => {
    tenantA = await createTestTenant('TenantAlpha');
    tenantB = await createTestTenant('TenantBeta');

    employeeA = await createTestEmployee(
      tenantA.id,
      `alice-${Date.now()}@alpha.test`,
      `EMP-A-${Date.now()}`,
    );
    employeeB = await createTestEmployee(
      tenantB.id,
      `bob-${Date.now()}@beta.test`,
      `EMP-B-${Date.now()}`,
    );
  });

  afterAll(async () => {
    // Cleanup test data — cascades handle dependent rows (employees, memberships)
    await dbAdmin
      .delete(schema.tenants)
      .where(eq(schema.tenants.id, tenantA.id));
    await dbAdmin
      .delete(schema.tenants)
      .where(eq(schema.tenants.id, tenantB.id));
    await dbAdmin
      .delete(schema.users)
      .where(eq(schema.users.id, employeeA.user_id!));
    await dbAdmin
      .delete(schema.users)
      .where(eq(schema.users.id, employeeB.user_id!));
    await appClient.end();
    await adminClient.end();
  });

  // ─── Test 1: SELECT isolation ──────────────────────────────────────────────
  it('1. SELECT from tenant A returns 0 employees from tenant B', async () => {
    const employees = await withTestTenant(tenantA.id, (tx) =>
      tx.select().from(schema.employees),
    );

    expect(employees.every((e) => e.tenant_id === tenantA.id)).toBe(true);
    expect(employees.find((e) => e.id === employeeB.id)).toBeUndefined();
  });

  // ─── Test 2: INSERT isolation — tenant_id mismatch rejected ───────────────
  it('2. INSERT with wrong tenant_id is rejected by RLS', async () => {
    await expect(
      withTestTenant(tenantA.id, async (tx) => {
        return tx.insert(schema.employees).values({
          tenant_id: tenantB.id, // wrong tenant
          employee_code: `EMP-EVIL-${Date.now()}`,
          first_name: 'Evil',
          last_name: 'Actor',
          work_email: `evil-${Date.now()}@hacker.test`,
          employment_type: 'full_time',
          date_of_joining: new Date().toISOString().split('T')[0]!,
          status: 'active',
        });
      }),
    ).rejects.toThrow();
  });

  // ─── Test 3: UPDATE isolation ──────────────────────────────────────────────
  it('3. UPDATE from tenant A context cannot modify tenant B employees', async () => {
    await withTestTenant(tenantA.id, async (tx) => {
      await tx
        .update(schema.employees)
        .set({ first_name: 'Hacked' })
        .where(eq(schema.employees.id, employeeB.id));
    });

    // Verify Bob's name is unchanged (UPDATE was silently dropped by RLS).
    // Use admin client to inspect across tenants — RLS would hide it otherwise.
    const [unchanged] = await dbAdmin
      .select()
      .from(schema.employees)
      .where(eq(schema.employees.id, employeeB.id));

    expect(unchanged?.first_name).not.toBe('Hacked');
  });

  // ─── Test 4: DELETE isolation ──────────────────────────────────────────────
  it('4. DELETE from tenant A context cannot delete tenant B employees', async () => {
    const countBefore = await dbAdmin
      .select()
      .from(schema.employees)
      .where(eq(schema.employees.id, employeeB.id));

    await withTestTenant(tenantA.id, async (tx) => {
      await tx
        .delete(schema.employees)
        .where(eq(schema.employees.id, employeeB.id));
    });

    const countAfter = await dbAdmin
      .select()
      .from(schema.employees)
      .where(eq(schema.employees.id, employeeB.id));

    expect(countAfter.length).toBe(countBefore.length);
    expect(countAfter.length).toBe(1);
  });

  // ─── Test 5: Tenant B cannot see Tenant A's employees ─────────────────────
  it('5. Tenant B context sees 0 employees from tenant A', async () => {
    const employees = await withTestTenant(tenantB.id, (tx) =>
      tx.select().from(schema.employees),
    );

    expect(employees.find((e) => e.id === employeeA.id)).toBeUndefined();
    expect(employees.every((e) => e.tenant_id === tenantB.id)).toBe(true);
  });

  // ─── Test 6: No tenant context = isolation enforced ──────────────────────
  it('6. Query without tenant context cannot leak rows', async () => {
    // With app.tenant_id unset/empty, the RLS predicate
    //   tenant_id = current_setting('app.tenant_id', true)::uuid
    // either rejects (invalid uuid cast) or returns 0 rows. Both outcomes
    // satisfy the isolation guarantee — neither leaks data.
    let leaked = false;
    try {
      const employees = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
        return tx.select().from(schema.employees);
      });
      leaked = employees.length > 0;
    } catch {
      // Cast error from ''::uuid is acceptable — no data leaked
      leaked = false;
    }
    expect(leaked).toBe(false);
  });

  // ─── Test 7: Leave requests isolation ─────────────────────────────────────
  it('7. Leave requests are isolated per tenant', async () => {
    const [leaveType] = await dbAdmin
      .insert(schema.leaveTypes)
      .values({
        tenant_id: tenantA.id,
        name: 'Casual Leave',
        code: `CL-${Date.now()}`,
        default_quota_days: 12,
        is_active: true,
        is_paid: true,
        is_lop: false,
      })
      .returning();

    const [leaveReq] = await dbAdmin
      .insert(schema.leaveRequests)
      .values({
        tenant_id: tenantA.id,
        employee_id: employeeA.id,
        leave_type_id: leaveType!.id,
        start_date: '2026-06-01',
        end_date: '2026-06-02',
        total_days: 2,
        reason: 'Personal work',
        status: 'pending',
      })
      .returning();

    const results = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.leaveRequests)
        .where(eq(schema.leaveRequests.id, leaveReq!.id)),
    );

    expect(results.length).toBe(0);

    // Cleanup
    await dbAdmin
      .delete(schema.leaveRequests)
      .where(eq(schema.leaveRequests.id, leaveReq!.id));
    await dbAdmin
      .delete(schema.leaveTypes)
      .where(eq(schema.leaveTypes.id, leaveType!.id));
  });

  // ─── Test 8: Attendance records + punches isolation ───────────────────────
  it('8. Attendance records and punches are isolated per tenant', async () => {
    const [record] = await dbAdmin
      .insert(schema.attendanceRecords)
      .values({
        tenant_id: tenantA.id,
        employee_id: employeeA.id,
        attendance_date: '2026-05-15',
        attendance_status: 'present',
      })
      .returning();

    // Seed a punch row tied to that attendance record
    const [punch] = await dbAdmin
      .insert(schema.attendancePunches)
      .values({
        tenant_id: tenantA.id,
        attendance_record_id: record!.id,
        employee_id: employeeA.id,
        punch_type: 'in',
        punched_at: new Date('2026-05-15T03:30:00Z'),
        source: 'web',
      })
      .returning();

    // Tenant B must see neither the record nor the punch
    const recordsFromB = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.attendanceRecords)
        .where(eq(schema.attendanceRecords.id, record!.id)),
    );
    const punchesFromB = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.attendancePunches)
        .where(eq(schema.attendancePunches.id, punch!.id)),
    );

    expect(recordsFromB.length).toBe(0);
    expect(punchesFromB.length).toBe(0);

    // And tenant A's context should see exactly one of each
    const recordsFromA = await withTestTenant(tenantA.id, (tx) =>
      tx
        .select()
        .from(schema.attendanceRecords)
        .where(eq(schema.attendanceRecords.id, record!.id)),
    );
    expect(recordsFromA.length).toBe(1);

    // Cleanup (cascade deletes punches via the FK on attendance_record_id)
    await dbAdmin
      .delete(schema.attendanceRecords)
      .where(eq(schema.attendanceRecords.id, record!.id));
  });

  // ─── Test 9: Memberships isolation ────────────────────────────────────────
  it('9. Memberships are isolated per tenant', async () => {
    const user = await createTestUser(`member-${Date.now()}@test.test`);
    const [membership] = await dbAdmin
      .insert(schema.memberships)
      .values({
        tenant_id: tenantA.id,
        user_id: user.id,
        role: 'employee',
        status: 'active',
      })
      .returning();

    const results = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.memberships)
        .where(eq(schema.memberships.id, membership!.id)),
    );

    expect(results.length).toBe(0);

    await dbAdmin
      .delete(schema.memberships)
      .where(eq(schema.memberships.id, membership!.id));
    await dbAdmin.delete(schema.users).where(eq(schema.users.id, user.id));
  });

  // ─── Test 10: Subquery cannot leak cross-tenant data ──────────────────────
  it('10. Subquery/join cannot leak cross-tenant data', async () => {
    const employees = await withTestTenant(tenantA.id, async (tx) => {
      return tx
        .select({
          id: schema.employees.id,
          tenant_id: schema.employees.tenant_id,
          email: schema.employees.work_email,
        })
        .from(schema.employees)
        .innerJoin(
          schema.tenants,
          eq(schema.employees.tenant_id, schema.tenants.id),
        );
    });

    expect(employees.every((e) => e.tenant_id === tenantA.id)).toBe(true);
    expect(employees.find((e) => e.tenant_id === tenantB.id)).toBeUndefined();
  });

  // ─── Test 11: Subscriptions isolation (Bucket B, 0009) ────────────────────
  // FAM reads subscriptions via the service role, so this is defense-in-depth:
  // a tenant-role query must never see another tenant's billing row.
  it('11. Subscriptions are isolated per tenant', async () => {
    const [sub] = await dbAdmin
      .insert(schema.subscriptions)
      .values({
        tenant_id: tenantA.id,
        plan_code: 'starter',
        status: 'trialing',
      })
      .returning();

    const results = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.id, sub!.id)),
    );

    expect(results.length).toBe(0);

    await dbAdmin
      .delete(schema.subscriptions)
      .where(eq(schema.subscriptions.id, sub!.id));
  });

  // ─── Test 12: Impersonation sessions isolation (target_tenant_id, 0009) ───
  // The policy keys on target_tenant_id (the tenant being impersonated), not
  // tenant_id — guard against that column being wired up wrong.
  it('12. Impersonation sessions are isolated per target tenant', async () => {
    const [session] = await dbAdmin
      .insert(schema.impersonationSessions)
      .values({
        target_tenant_id: tenantA.id,
        impersonator_user_id: employeeA.user_id!,
        target_user_id: employeeA.user_id!,
        ends_at: new Date(Date.now() + 15 * 60 * 1000),
        reason: 'isolation test',
      })
      .returning();

    const results = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.impersonationSessions)
        .where(eq(schema.impersonationSessions.id, session!.id)),
    );

    expect(results.length).toBe(0);

    await dbAdmin
      .delete(schema.impersonationSessions)
      .where(eq(schema.impersonationSessions.id, session!.id));
  });

  // ─── Test 13: Users visible only to tenants they are members of (0010) ────
  it('13. Users are visible only to tenants they belong to', async () => {
    const user = await createTestUser(`u13-${Date.now()}@test.test`);
    const [membership] = await dbAdmin
      .insert(schema.memberships)
      .values({
        tenant_id: tenantA.id,
        user_id: user.id,
        role: 'employee',
        status: 'active',
      })
      .returning();

    // Visible under tenant A (the user is a member there) …
    const fromA = await withTestTenant(tenantA.id, (tx) =>
      tx.select().from(schema.users).where(eq(schema.users.id, user.id)),
    );
    expect(fromA.length).toBe(1);

    // … but invisible under tenant B (not a member).
    const fromB = await withTestTenant(tenantB.id, (tx) =>
      tx.select().from(schema.users).where(eq(schema.users.id, user.id)),
    );
    expect(fromB.length).toBe(0);

    await dbAdmin
      .delete(schema.memberships)
      .where(eq(schema.memberships.id, membership!.id));
    await dbAdmin.delete(schema.users).where(eq(schema.users.id, user.id));
  });

  // ─── Test 14: Tenants see only their own row (0010) ───────────────────────
  it('14. A tenant connection sees only its own tenants row', async () => {
    const own = await withTestTenant(tenantA.id, (tx) =>
      tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantA.id)),
    );
    expect(own.length).toBe(1);

    const other = await withTestTenant(tenantA.id, (tx) =>
      tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantB.id)),
    );
    expect(other.length).toBe(0);
  });

  // ─── Test 15: Identity/auth tables are denied to the tenant role (0011) ───
  // auth_otps et al. are service-role-only (deny-all RLS). The app role must
  // be able to neither read nor write them — this is what makes the OTP/login
  // tables safe to have RLS on without leaking, and re-locks auth_otps after
  // the dashboard-drift hotfix.
  it('15. Identity tables (auth_otps) are denied to the tenant connection', async () => {
    const [otp] = await dbAdmin
      .insert(schema.authOtps)
      .values({
        email: `otp-${Date.now()}@test.test`,
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      })
      .returning();

    // Deny-all USING(false): the tenant connection sees zero rows.
    const seen = await withTestTenant(tenantA.id, (tx) =>
      tx.select().from(schema.authOtps).where(eq(schema.authOtps.id, otp!.id)),
    );
    expect(seen.length).toBe(0);

    // Deny-all WITH CHECK(false): the tenant connection cannot insert either.
    await expect(
      withTestTenant(tenantA.id, (tx) =>
        tx.insert(schema.authOtps).values({
          email: `blocked-${Date.now()}@test.test`,
          expires_at: new Date(Date.now() + 10 * 60 * 1000),
        }),
      ),
    ).rejects.toThrow();

    await dbAdmin.delete(schema.authOtps).where(eq(schema.authOtps.id, otp!.id));
  });
});
