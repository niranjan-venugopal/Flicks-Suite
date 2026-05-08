/**
 * Multi-Tenant Isolation Test Suite (PRD Section 2.3)
 *
 * These 10 tests MUST ALL PASS before any PR can merge.
 * They are the single most important security control in the codebase.
 *
 * Creates two tenants, seeds distinct data in each, and asserts
 * that no query from tenant A can access tenant B's data.
 */
import { Test, TestingModule } from '@nestjs/testing'
import { ConfigModule } from '@nestjs/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql, eq } from 'drizzle-orm'
import * as schema from '@flicks/db/schema'
import { withTenant } from '@flicks/db'
import * as crypto from 'crypto'

// ─── Test Setup ──────────────────────────────────────────────────────────────

const TEST_DB_URL =
  process.env['DATABASE_URL'] ||
  'postgresql://postgres:postgres@localhost:5432/flicks_test'

const rawClient = postgres(TEST_DB_URL, { max: 5 })
const db = drizzle(rawClient, { schema })

// Helper: run inside a transaction with tenant context set
async function withTestTenant<T>(
  tenantId: string,
  callback: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`,
    )
    return callback(tx as unknown as typeof db)
  })
}

// Helper: create a minimal tenant
async function createTestTenant(name: string) {
  const [tenant] = await db
    .insert(schema.tenants)
    .values({
      name,
      slug: `test-${name.toLowerCase()}-${Date.now()}`,
      status: 'trialing',
    })
    .returning()
  return tenant!
}

// Helper: create a minimal user
async function createTestUser(email: string) {
  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      status: 'active',
    })
    .returning()
  return user!
}

// Helper: create a minimal employee in a tenant
async function createTestEmployee(
  tenantId: string,
  email: string,
  code: string,
) {
  // Need a user first
  const user = await createTestUser(email)
  const [emp] = await db
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
    .returning()
  return emp!
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Multi-Tenant RLS Isolation (Gate 1 — PRD Section 2.3)', () => {
  let tenantA: (typeof schema.tenants.$inferSelect)
  let tenantB: (typeof schema.tenants.$inferSelect)
  let employeeA: (typeof schema.employees.$inferSelect)
  let employeeB: (typeof schema.employees.$inferSelect)

  beforeAll(async () => {
    // Create two separate test tenants
    tenantA = await createTestTenant('TenantAlpha')
    tenantB = await createTestTenant('TenantBeta')

    // Seed distinct employees in each
    employeeA = await createTestEmployee(tenantA.id, `alice-${Date.now()}@alpha.com`, 'EMP-A-001')
    employeeB = await createTestEmployee(tenantB.id, `bob-${Date.now()}@beta.com`, 'EMP-B-001')
  })

  afterAll(async () => {
    // Cleanup test data
    await db.delete(schema.employees).where(eq(schema.employees.tenant_id, tenantA.id))
    await db.delete(schema.employees).where(eq(schema.employees.tenant_id, tenantB.id))
    await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantA.id))
    await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantB.id))
    await rawClient.end()
  })

  // ─── Test 1: SELECT isolation ──────────────────────────────────────────────
  it('1. SELECT from tenant A returns 0 employees from tenant B', async () => {
    const employees = await withTestTenant(tenantA.id, (tx) =>
      tx.select().from(schema.employees),
    )

    // All returned employees must belong to tenant A
    expect(employees.every((e) => e.tenant_id === tenantA.id)).toBe(true)
    // Bob from tenant B must NOT be visible
    expect(employees.find((e) => e.id === employeeB.id)).toBeUndefined()
  })

  // ─── Test 2: INSERT isolation — tenant_id mismatch rejected ───────────────
  it('2. INSERT with wrong tenant_id is rejected by RLS', async () => {
    await expect(
      withTestTenant(tenantA.id, async (tx) => {
        return tx.insert(schema.employees).values({
          tenant_id: tenantB.id, // wrong tenant
          employee_code: 'EMP-EVIL',
          first_name: 'Evil',
          last_name: 'Actor',
          work_email: `evil-${Date.now()}@hacker.com`,
          employment_type: 'full_time',
          date_of_joining: new Date().toISOString().split('T')[0]!,
          status: 'active',
        })
      }),
    ).rejects.toThrow()
  })

  // ─── Test 3: UPDATE isolation ──────────────────────────────────────────────
  it('3. UPDATE from tenant A context cannot modify tenant B employees', async () => {
    await withTestTenant(tenantA.id, async (tx) => {
      // Try to update tenant B's employee — RLS will filter it out
      await tx
        .update(schema.employees)
        .set({ first_name: 'Hacked' })
        .where(eq(schema.employees.id, employeeB.id))
    })

    // Verify Bob's name is unchanged (UPDATE was silently dropped by RLS)
    const [unchanged] = await db
      .select()
      .from(schema.employees)
      .where(eq(schema.employees.id, employeeB.id))

    expect(unchanged?.first_name).not.toBe('Hacked')
  })

  // ─── Test 4: DELETE isolation ──────────────────────────────────────────────
  it('4. DELETE from tenant A context cannot delete tenant B employees', async () => {
    const countBefore = await db
      .select()
      .from(schema.employees)
      .where(eq(schema.employees.id, employeeB.id))

    await withTestTenant(tenantA.id, async (tx) => {
      await tx
        .delete(schema.employees)
        .where(eq(schema.employees.id, employeeB.id))
    })

    const countAfter = await db
      .select()
      .from(schema.employees)
      .where(eq(schema.employees.id, employeeB.id))

    // Bob still exists
    expect(countAfter.length).toBe(countBefore.length)
    expect(countAfter.length).toBe(1)
  })

  // ─── Test 5: Tenant B cannot see Tenant A's employees ─────────────────────
  it('5. Tenant B context sees 0 employees from tenant A', async () => {
    const employees = await withTestTenant(tenantB.id, (tx) =>
      tx.select().from(schema.employees),
    )

    expect(employees.find((e) => e.id === employeeA.id)).toBeUndefined()
    expect(employees.every((e) => e.tenant_id === tenantB.id)).toBe(true)
  })

  // ─── Test 6: No tenant context = 0 rows (RLS applied with empty setting) ──
  it('6. Query without tenant context returns 0 rows', async () => {
    const employees = await db.transaction(async (tx) => {
      // Explicitly set tenant_id to empty string
      await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`)
      return tx.select().from(schema.employees)
    })

    // With empty tenant_id, current_setting('app.tenant_id')::uuid will fail or return empty
    // Either 0 rows or an exception — both are acceptable isolation behaviors
    expect(employees.every((e) => e.tenant_id === '')).toBe(true)
    // In practice this returns 0 rows because no row has tenant_id = ''
    expect(employees.length).toBe(0)
  })

  // ─── Test 7: Leave requests isolation ─────────────────────────────────────
  it('7. Leave requests are isolated per tenant', async () => {
    // Seed a leave type for tenant A
    const [leaveType] = await db
      .insert(schema.leave_types)
      .values({
        tenant_id: tenantA.id,
        name: 'Casual Leave',
        code: 'CL',
        default_quota_days: '12',
        is_active: true,
        is_paid: true,
        is_lop: false,
      })
      .returning()

    // Seed a leave request for employee A
    const [leaveReq] = await db
      .insert(schema.leave_requests)
      .values({
        tenant_id: tenantA.id,
        employee_id: employeeA.id,
        leave_type_id: leaveType!.id,
        start_date: '2026-06-01',
        end_date: '2026-06-02',
        total_days: '2',
        reason: 'Personal work',
        status: 'pending',
      })
      .returning()

    // Query from tenant B context — must NOT see tenant A's leave request
    const results = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.leave_requests)
        .where(eq(schema.leave_requests.id, leaveReq!.id)),
    )

    expect(results.length).toBe(0)

    // Cleanup
    await db.delete(schema.leave_requests).where(eq(schema.leave_requests.id, leaveReq!.id))
    await db.delete(schema.leave_types).where(eq(schema.leave_types.id, leaveType!.id))
  })

  // ─── Test 8: Attendance records isolation ─────────────────────────────────
  it('8. Attendance records are isolated per tenant', async () => {
    const [record] = await db
      .insert(schema.attendance_records)
      .values({
        tenant_id: tenantA.id,
        employee_id: employeeA.id,
        attendance_date: '2026-05-15',
        attendance_status: 'present',
      })
      .returning()

    const results = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.attendance_records)
        .where(eq(schema.attendance_records.id, record!.id)),
    )

    expect(results.length).toBe(0)

    // Cleanup
    await db.delete(schema.attendance_records).where(eq(schema.attendance_records.id, record!.id))
  })

  // ─── Test 9: Memberships isolation ────────────────────────────────────────
  it('9. Memberships are isolated per tenant', async () => {
    const user = await createTestUser(`member-${Date.now()}@test.com`)
    const [membership] = await db
      .insert(schema.memberships)
      .values({
        tenant_id: tenantA.id,
        user_id: user.id,
        role: 'employee',
        status: 'active',
      })
      .returning()

    const results = await withTestTenant(tenantB.id, (tx) =>
      tx
        .select()
        .from(schema.memberships)
        .where(eq(schema.memberships.id, membership!.id)),
    )

    expect(results.length).toBe(0)

    // Cleanup
    await db.delete(schema.memberships).where(eq(schema.memberships.id, membership!.id))
    await db.delete(schema.users).where(eq(schema.users.id, user.id))
  })

  // ─── Test 10: Subquery cannot leak cross-tenant data ──────────────────────
  it('10. Subquery/join cannot leak cross-tenant data', async () => {
    // Query for all employees whose tenant has status='trialing'
    // The employees RLS should still restrict to the current tenant
    const employees = await withTestTenant(tenantA.id, async (tx) => {
      return tx
        .select({
          id: schema.employees.id,
          tenant_id: schema.employees.tenant_id,
          email: schema.employees.work_email,
        })
        .from(schema.employees)
        .innerJoin(schema.tenants, eq(schema.employees.tenant_id, schema.tenants.id))
    })

    // All results must belong to tenant A only
    expect(employees.every((e) => e.tenant_id === tenantA.id)).toBe(true)
    expect(employees.find((e) => e.tenant_id === tenantB.id)).toBeUndefined()
  })
})
