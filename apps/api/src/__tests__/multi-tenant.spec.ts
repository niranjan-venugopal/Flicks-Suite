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

// ════════════════════════════════════════════════════════════════════════════
// Invoicing v3 — cross-tenant isolation (PRD §4.4)
// Self-contained (own DB clients) so it is independent of the suite above,
// whose afterAll closes the shared connections. Covers every new tenant-scoped
// table, plus the auditor company-switcher cases (memberships self-visibility,
// auditor-in-A-and-B) and the razorpay_webhook_events deny-all.
// ════════════════════════════════════════════════════════════════════════════

describe('Invoicing v3 RLS Isolation (PRD §4.4)', () => {
  const invApp = postgres(APP_DB_URL, { max: 5 });
  const invAdmin = postgres(ADMIN_DB_URL, { max: 2 });
  const idb = drizzle(invApp, { schema });
  const idbAdmin = drizzle(invAdmin, { schema });
  const rid = () => Math.random().toString(36).slice(2, 10);

  async function withTenant<T>(
    tenantId: string,
    cb: (tx: typeof idb) => Promise<T>,
  ): Promise<T> {
    return idb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`);
      return cb(tx as unknown as typeof idb);
    });
  }
  async function withTenantUser<T>(
    tenantId: string,
    userId: string,
    cb: (tx: typeof idb) => Promise<T>,
  ): Promise<T> {
    return idb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}::text, true)`);
      return cb(tx as unknown as typeof idb);
    });
  }
  const mkTenant = async (name: string) =>
    (await idbAdmin.insert(schema.tenants).values({ name, slug: `inv-${name.toLowerCase()}-${rid()}`, status: 'trialing' }).returning())[0]!;
  const mkUser = async (email: string) =>
    (await idbAdmin.insert(schema.users).values({ email, full_name: email.split('@')[0]!, status: 'active' }).returning())[0]!;

  let tenantA: typeof schema.tenants.$inferSelect;
  let tenantB: typeof schema.tenants.$inferSelect;
  let customerA: typeof schema.customers.$inferSelect;
  let customerB: typeof schema.customers.$inferSelect;

  beforeAll(async () => {
    tenantA = await mkTenant(`InvAlpha${rid()}`);
    tenantB = await mkTenant(`InvBeta${rid()}`);
    [customerA] = await idbAdmin.insert(schema.customers).values({ tenant_id: tenantA.id, customer_code: `CUST-A-${rid()}`, display_name: 'Customer A' }).returning();
    [customerB] = await idbAdmin.insert(schema.customers).values({ tenant_id: tenantB.id, customer_code: `CUST-B-${rid()}`, display_name: 'Customer B' }).returning();
  });

  afterAll(async () => {
    await idbAdmin.delete(schema.tenants).where(eq(schema.tenants.id, tenantA.id));
    await idbAdmin.delete(schema.tenants).where(eq(schema.tenants.id, tenantB.id));
    await invApp.end();
    await invAdmin.end();
  });

  const cases: { label: string; table: any; values: () => Record<string, unknown> }[] = [
    { label: 'customers', table: schema.customers, values: () => ({ tenant_id: tenantA.id, customer_code: `C-${rid()}`, display_name: 'Acme' }) },
    { label: 'items', table: schema.items, values: () => ({ tenant_id: tenantA.id, item_code: `I-${rid()}`, name: 'Widget', default_rate: '100.00' }) },
    { label: 'invoices', table: schema.invoices, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, invoice_number: `INV-${rid()}`, invoice_date: '2026-06-01', due_date: '2026-07-01', fy_label: '26-27', currency: 'INR' }) },
    { label: 'invoice_payments', table: schema.invoicePayments, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, payment_number: `PMT-${rid()}`, payment_date: '2026-06-02', amount: '50.00', currency: 'INR', payment_method: 'CASH' }) },
    { label: 'invoice_subscriptions', table: schema.invoiceSubscriptions, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, name: 'Monthly', pricing_model: 'flat_rate', currency: 'INR', billing_period: 'monthly', start_date: '2026-06-01' }) },
    { label: 'credit_notes', table: schema.creditNotes, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, credit_note_number: `CN-${rid()}`, fy_label: '26-27', credit_note_date: '2026-06-01', reason: 'sales_return' }) },
    { label: 'debit_notes', table: schema.debitNotes, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, debit_note_number: `DN-${rid()}`, fy_label: '26-27', debit_note_date: '2026-06-01', reason: 'additional_charges' }) },
    { label: 'adjustments', table: schema.adjustments, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, adjustment_date: '2026-06-01', amount: '10.00', type: 'round_off' }) },
    { label: 'customer_credit_balance', table: schema.customerCreditBalance, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, balance_amount: '0', currency: `C${rid().slice(0, 2)}` }) },
    { label: 'customer_credit_balance_entries', table: schema.customerCreditBalanceEntries, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, entry_date: '2026-06-01', entry_type: 'overpayment', amount: '5.00' }) },
    { label: 'invoicing_settings', table: schema.invoicingSettings, values: () => ({ tenant_id: tenantA.id }) },
    { label: 'invoicing_setup_progress', table: schema.invoicingSetupProgress, values: () => ({ tenant_id: tenantA.id }) },
    { label: 'invoice_sequences', table: schema.invoiceSequences, values: () => ({ tenant_id: tenantA.id, document_type: `INVOICE-${rid()}`, fy_label: '26-27', fy_start_date: '2026-04-01', fy_end_date: '2027-03-31' }) },
    { label: 'tenant_bank_accounts', table: schema.tenantBankAccounts, values: () => ({ tenant_id: tenantA.id, beneficiary_name: 'Acme Pvt Ltd', account_number: `${rid()}`, bank_name: 'HDFC' }) },
    { label: 'reminder_schedule', table: schema.reminderSchedule, values: () => ({ tenant_id: tenantA.id, reminder_number: 1, offset_days: -3 }) },
    { label: 'gstr1_exports', table: schema.gstr1Exports, values: () => ({ tenant_id: tenantA.id, fy_label: '26-27' }) },
    { label: 'form_131_received', table: schema.form131Received, values: () => ({ tenant_id: tenantA.id, customer_id: customerA.id, fy_label: '26-27', quarter: 1 }) },
    { label: 'tenant_module_toggles', table: schema.tenantModuleToggles, values: () => ({ tenant_id: tenantA.id, module: `mod-${rid()}`, enabled: true }) },
    { label: 'tenant_hsn_sac_codes', table: schema.tenantHsnSacCodes, values: () => ({ tenant_id: tenantA.id, code: `X-${rid()}`, type: 'SAC', description: 'Custom service' }) },
  ];

  cases.forEach(({ label, table, values }) => {
    it(`isolation: ${label} — A sees its row, B sees none`, async () => {
      const [row] = await idbAdmin.insert(table).values(values()).returning();
      const seenByA = await withTenant(tenantA.id, (tx) => tx.select().from(table).where(eq(table.id, (row as any).id)));
      expect(seenByA.length).toBe(1);
      const seenByB = await withTenant(tenantB.id, (tx) => tx.select().from(table).where(eq(table.id, (row as any).id)));
      expect(seenByB.length).toBe(0);
      await idbAdmin.delete(table).where(eq(table.id, (row as any).id));
    });
  });

  it('isolation: invoice_line_items follow their invoice tenant', async () => {
    const [inv] = await idbAdmin.insert(schema.invoices).values({ tenant_id: tenantA.id, customer_id: customerA.id, invoice_number: `INV-${rid()}`, invoice_date: '2026-06-01', due_date: '2026-07-01', fy_label: '26-27', currency: 'INR' }).returning();
    const [line] = await idbAdmin.insert(schema.invoiceLineItems).values({ tenant_id: tenantA.id, invoice_id: inv!.id, line_number: 1, item_name: 'Widget', quantity: '1', rate: '100.00' }).returning();
    expect((await withTenant(tenantA.id, (tx) => tx.select().from(schema.invoiceLineItems).where(eq(schema.invoiceLineItems.id, line!.id)))).length).toBe(1);
    expect((await withTenant(tenantB.id, (tx) => tx.select().from(schema.invoiceLineItems).where(eq(schema.invoiceLineItems.id, line!.id)))).length).toBe(0);
    await idbAdmin.delete(schema.invoices).where(eq(schema.invoices.id, inv!.id));
  });

  it('isolation: tenant_currency_bank_defaults is tenant-scoped', async () => {
    const [bank] = await idbAdmin.insert(schema.tenantBankAccounts).values({ tenant_id: tenantA.id, beneficiary_name: 'Acme', account_number: `${rid()}`, bank_name: 'ICICI' }).returning();
    const [def] = await idbAdmin.insert(schema.tenantCurrencyBankDefaults).values({ tenant_id: tenantA.id, currency: 'USD', bank_account_id: bank!.id }).returning();
    expect((await withTenant(tenantA.id, (tx) => tx.select().from(schema.tenantCurrencyBankDefaults).where(eq(schema.tenantCurrencyBankDefaults.id, def!.id)))).length).toBe(1);
    expect((await withTenant(tenantB.id, (tx) => tx.select().from(schema.tenantCurrencyBankDefaults).where(eq(schema.tenantCurrencyBankDefaults.id, def!.id)))).length).toBe(0);
    await idbAdmin.delete(schema.tenantBankAccounts).where(eq(schema.tenantBankAccounts.id, bank!.id));
  });

  it('isolation: razorpay_orders is tenant-scoped', async () => {
    const [inv] = await idbAdmin.insert(schema.invoices).values({ tenant_id: tenantA.id, customer_id: customerA.id, invoice_number: `INV-${rid()}`, invoice_date: '2026-06-01', due_date: '2026-07-01', fy_label: '26-27', currency: 'INR' }).returning();
    const [ord] = await idbAdmin.insert(schema.razorpayOrders).values({ tenant_id: tenantA.id, invoice_id: inv!.id, order_id: `order_${rid()}`, amount_paise: 1000, currency: 'INR' }).returning();
    expect((await withTenant(tenantA.id, (tx) => tx.select().from(schema.razorpayOrders).where(eq(schema.razorpayOrders.id, ord!.id)))).length).toBe(1);
    expect((await withTenant(tenantB.id, (tx) => tx.select().from(schema.razorpayOrders).where(eq(schema.razorpayOrders.id, ord!.id)))).length).toBe(0);
    await idbAdmin.delete(schema.invoices).where(eq(schema.invoices.id, inv!.id));
  });

  it('isolation: razorpay_webhook_events denies the tenant connection', async () => {
    const [evt] = await idbAdmin.insert(schema.razorpayWebhookEvents).values({ event_id: `evt-${rid()}`, event_type: 'payment.captured' }).returning();
    expect((await withTenant(tenantA.id, (tx) => tx.select().from(schema.razorpayWebhookEvents).where(eq(schema.razorpayWebhookEvents.id, evt!.id)))).length).toBe(0);
    await expect(withTenant(tenantA.id, (tx) => tx.insert(schema.razorpayWebhookEvents).values({ event_id: `blk-${rid()}`, event_type: 'payment.captured' }))).rejects.toThrow();
    await idbAdmin.delete(schema.razorpayWebhookEvents).where(eq(schema.razorpayWebhookEvents.id, evt!.id));
  });

  it('member_status: tenant-wide read, write-own only (0024)', async () => {
    const alice = await mkUser(`status-a-${rid()}@test.test`);
    const bob = await mkUser(`status-b-${rid()}@test.test`);
    const [row] = await idbAdmin.insert(schema.memberStatus).values({
      tenant_id: tenantA.id, user_id: alice.id, manual_status: 'busy', status_message: 'heads down',
    }).returning();

    // Org-wide read within the tenant (Bob sees Alice); cross-tenant blind.
    expect((await withTenantUser(tenantA.id, bob.id, (tx) => tx.select().from(schema.memberStatus).where(eq(schema.memberStatus.id, row!.id)))).length).toBe(1);
    expect((await withTenant(tenantB.id, (tx) => tx.select().from(schema.memberStatus).where(eq(schema.memberStatus.id, row!.id)))).length).toBe(0);
    // Bob cannot write Alice's status (UPDATE matches 0 rows under write-own).
    const hijack = await withTenantUser(tenantA.id, bob.id, (tx) =>
      tx.update(schema.memberStatus).set({ manual_status: 'offline' }).where(eq(schema.memberStatus.id, row!.id)).returning(),
    );
    expect(hijack.length).toBe(0);
    // Bob cannot INSERT a row for Alice either.
    await expect(withTenantUser(tenantA.id, bob.id, (tx) => tx.insert(schema.memberStatus).values({
      tenant_id: tenantA.id, user_id: alice.id, manual_status: 'offline',
    }))).rejects.toThrow();
    // Alice CAN write her own.
    const own = await withTenantUser(tenantA.id, alice.id, (tx) =>
      tx.update(schema.memberStatus).set({ manual_status: 'available' }).where(eq(schema.memberStatus.id, row!.id)).returning(),
    );
    expect(own.length).toBe(1);

    await idbAdmin.delete(schema.users).where(eq(schema.users.id, alice.id));
    await idbAdmin.delete(schema.users).where(eq(schema.users.id, bob.id));
  });

  it('consent_records self-visibility: own rows only, append-only under the app role (0022)', async () => {
    const alice = await mkUser(`consent-a-${rid()}@test.test`);
    const bob = await mkUser(`consent-b-${rid()}@test.test`);
    const [row] = await idbAdmin.insert(schema.consentRecords).values({
      user_id: alice.id, consent_type: 'analytics', granted: true,
      policy_version: 'consent-v1', source: 'settings',
    }).returning();

    // Alice sees her row (app.user_id = alice); Bob sees nothing.
    expect((await withTenantUser(tenantA.id, alice.id, (tx) => tx.select().from(schema.consentRecords).where(eq(schema.consentRecords.id, row!.id)))).length).toBe(1);
    expect((await withTenantUser(tenantA.id, bob.id, (tx) => tx.select().from(schema.consentRecords).where(eq(schema.consentRecords.id, row!.id)))).length).toBe(0);
    // No user context at all → nothing.
    expect((await withTenant(tenantA.id, (tx) => tx.select().from(schema.consentRecords).where(eq(schema.consentRecords.id, row!.id)))).length).toBe(0);
    // Alice can append her own row but NOT one for Bob.
    await withTenantUser(tenantA.id, alice.id, (tx) => tx.insert(schema.consentRecords).values({
      user_id: alice.id, consent_type: 'marketing_email', granted: false,
      policy_version: 'consent-v1', source: 'settings',
    }));
    await expect(withTenantUser(tenantA.id, alice.id, (tx) => tx.insert(schema.consentRecords).values({
      user_id: bob.id, consent_type: 'marketing_email', granted: true,
      policy_version: 'consent-v1', source: 'settings',
    }))).rejects.toThrow();
    // Append-only: UPDATE/DELETE are denied under the app role (no policy, no grant).
    await expect(withTenantUser(tenantA.id, alice.id, (tx) =>
      tx.update(schema.consentRecords).set({ granted: false }).where(eq(schema.consentRecords.id, row!.id)),
    )).rejects.toThrow();
    await expect(withTenantUser(tenantA.id, alice.id, (tx) =>
      tx.delete(schema.consentRecords).where(eq(schema.consentRecords.id, row!.id)),
    )).rejects.toThrow();

    await idbAdmin.delete(schema.users).where(eq(schema.users.id, alice.id));
    await idbAdmin.delete(schema.users).where(eq(schema.users.id, bob.id));
  });

  it('isolation: membership_grants is tenant-scoped', async () => {
    const user = await mkUser(`grant-${rid()}@test.test`);
    const [m] = await idbAdmin.insert(schema.memberships).values({ tenant_id: tenantA.id, user_id: user.id, role: 'auditor', status: 'active' }).returning();
    const [grant] = await idbAdmin.insert(schema.membershipGrants).values({ tenant_id: tenantA.id, membership_id: m!.id, module: 'invoicing', access_level: 'view' }).returning();
    expect((await withTenant(tenantA.id, (tx) => tx.select().from(schema.membershipGrants).where(eq(schema.membershipGrants.id, grant!.id)))).length).toBe(1);
    expect((await withTenant(tenantB.id, (tx) => tx.select().from(schema.membershipGrants).where(eq(schema.membershipGrants.id, grant!.id)))).length).toBe(0);
    await idbAdmin.delete(schema.memberships).where(eq(schema.memberships.id, m!.id));
    await idbAdmin.delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it('memberships self-visibility: own rows cross-tenant only with app.user_id', async () => {
    const user = await mkUser(`auditor-${rid()}@test.test`);
    const [mA] = await idbAdmin.insert(schema.memberships).values({ tenant_id: tenantA.id, user_id: user.id, role: 'auditor', status: 'active' }).returning();
    const [mB] = await idbAdmin.insert(schema.memberships).values({ tenant_id: tenantB.id, user_id: user.id, role: 'auditor', status: 'active' }).returning();
    const withUser = await withTenantUser(tenantA.id, user.id, (tx) => tx.select().from(schema.memberships).where(eq(schema.memberships.user_id, user.id)));
    expect(withUser.map((m: any) => m.id).sort()).toEqual([mA!.id, mB!.id].sort());
    const withoutUser = await withTenant(tenantA.id, (tx) => tx.select().from(schema.memberships).where(eq(schema.memberships.user_id, user.id)));
    expect(withoutUser.map((m: any) => m.id)).toEqual([mA!.id]);
    await idbAdmin.delete(schema.memberships).where(eq(schema.memberships.user_id, user.id));
    await idbAdmin.delete(schema.users).where(eq(schema.users.id, user.id));
  });

  it('auditor in two companies stays confined to the active company (RLS)', async () => {
    const user = await mkUser(`multico-${rid()}@test.test`);
    await idbAdmin.insert(schema.memberships).values({ tenant_id: tenantA.id, user_id: user.id, role: 'auditor', status: 'active' });
    await idbAdmin.insert(schema.memberships).values({ tenant_id: tenantB.id, user_id: user.id, role: 'auditor', status: 'active' });
    const seen = await withTenantUser(tenantA.id, user.id, (tx) => tx.select().from(schema.customers));
    expect(seen.some((c: any) => c.id === customerA.id)).toBe(true);
    expect(seen.some((c: any) => c.id === customerB.id)).toBe(false);
    await expect(withTenantUser(tenantA.id, user.id, (tx) => tx.insert(schema.customers).values({ tenant_id: tenantB.id, customer_code: `EVIL-${rid()}`, display_name: 'Evil' }))).rejects.toThrow();
    await idbAdmin.delete(schema.memberships).where(eq(schema.memberships.user_id, user.id));
    await idbAdmin.delete(schema.users).where(eq(schema.users.id, user.id));
  });
});
