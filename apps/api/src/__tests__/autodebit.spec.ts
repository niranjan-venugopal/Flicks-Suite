import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  customers,
  invoices,
  invoiceSubscriptions,
  memberships,
  subscriptionChargeAttempts,
  tenants,
  users,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AnalyticsService } from '../core/analytics/analytics.service';
import { AuditService } from '../modules/audit/audit.service';
import { R2Service } from '../core/storage/r2.service';
import { RazorpayService } from '../modules/invoicing/razorpay.service';
import { SubscriptionMandatesService } from '../modules/invoicing/subscription-mandates.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';

/**
 * PRD v4 §8A — tenant-track auto-debit (Sprint 23). Real-Postgres integration
 * for the mandate lifecycle, charge ledger, 3-strike dunning, and the public
 * /sub/<token> payload. Razorpay stays unconfigured — the webhook-driven
 * state machine and guards must all work without live keys.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const config = { get: (_: string, fb?: unknown) => fb } as never;
const analytics = new AnalyticsService(config, dbAdmin as never);
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const sendEmailSpy = jest.fn(async () => true);
const inAppSpy = jest.fn(async () => undefined);
const notifications = {
  sendEmail: sendEmailSpy,
  createInAppNotification: inAppSpy,
} as never;
const razorpay = new RazorpayService(config);
const r2 = new R2Service(config);
// resolveRazorpayForOrder → null (not connected) for the 503 guard test.
const settings = { resolveRazorpayForOrder: async () => null } as never;
// InvoicesService is only exercised via settleGeneratedInvoice — construct a
// real one so recordPayment runs the true SENT→PAID path.
let invoicesService: InvoicesService;
let mandates: SubscriptionMandatesService;

let tenantId: string;
let customerId: string;

const DAY = 24 * 60 * 60 * 1000;

async function mkSubscription(over: Partial<typeof invoiceSubscriptions.$inferInsert> = {}) {
  const [sub] = await dbAdmin
    .insert(invoiceSubscriptions)
    .values({
      tenant_id: tenantId,
      customer_id: customerId,
      name: `Retainer ${rid()}`,
      status: 'PENDING_MANDATE',
      pricing_model: 'flat_rate',
      currency: 'INR',
      flat_amount: '5000.00',
      billing_period: 'monthly',
      start_date: new Date().toISOString().slice(0, 10),
      next_billing_date: new Date().toISOString().slice(0, 10),
      ...over,
    })
    .returning();
  return sub!;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `AdCo${rid()}`, slug: `ad-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  tenantId = t!.id;
  const [c] = await dbAdmin
    .insert(customers)
    .values({
      tenant_id: tenantId,
      customer_code: `C-${rid()}`,
      display_name: 'Mandate Co',
      email: `mandate-${rid()}@test.test`,
    })
    .returning();
  customerId = c!.id;

  const { NumberingService } = await import('../modules/invoicing/numbering.service');
  const numbering = new NumberingService(dbSvc, audit);
  // recordPayment (the only path exercised here) touches db/audit/notifications;
  // org-financial is only read by preview/render paths — a stub suffices.
  invoicesService = new InvoicesService(
    dbSvc,
    audit,
    numbering,
    config,
    notifications,
    {} as never,
    { publish: async () => null } as never, // domain events — covered in platform-evolution.spec
  );
  mandates = new SubscriptionMandatesService(
    dbAdmin as never,
    dbSvc,
    audit,
    analytics,
    notifications,
    razorpay,
    settings,
    invoicesService,
    config,
    r2,
  );
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

const envelope = (rzpId: string, extra?: Record<string, unknown>) => ({
  payload: { subscription: { entity: { id: rzpId } }, ...(extra ?? {}) },
});

describe('Tenant auto-debit (PRD v4 §8A)', () => {
  it('enable-autodebit guards run before any Razorpay call: non-INR → 400; custom period → 400; then not-connected → 503', async () => {
    // Input guards reject before the external resolve, so they fire even with
    // Razorpay unconfigured.
    const eur = await mkSubscription({ currency: 'EUR' });
    await expect(mandates.enableAutodebit(eur.id, null as never, tenantId)).rejects.toMatchObject({
      status: 400,
    });
    const custom = await mkSubscription({ billing_period: 'custom', custom_period_days: 45 });
    await expect(mandates.enableAutodebit(custom.id, null as never, tenantId)).rejects.toThrow(
      /Custom-period/,
    );
    // A valid INR profile with no connected account → clean 503.
    const sub = await mkSubscription();
    await expect(mandates.enableAutodebit(sub.id, null as never, tenantId)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('webhook lifecycle: authenticated → authenticated; activated → ACTIVE; charged writes the ledger and settles the generated invoice', async () => {
    const rzpId = `sub_${rid()}`;
    const sub = await mkSubscription({
      razorpay_subscription_id: rzpId,
      collection_mode: 'auto_debit',
      mandate_status: 'pending_authorization',
    });

    await mandates.applyRazorpayEvent('subscription.authenticated', envelope(rzpId));
    let [row] = await dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.id, sub.id));
    expect(row!.mandate_status).toBe('authenticated'); // PRD §8.3 enum
    expect(row!.mandate_authorized_at).not.toBeNull();

    await mandates.applyRazorpayEvent('subscription.activated', envelope(rzpId));
    [row] = await dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.id, sub.id));
    expect(row!.status).toBe('ACTIVE');
    expect(row!.mandate_status).toBe('active');

    // A generated (SENT) invoice for this subscription awaits settlement.
    const [inv] = await dbAdmin
      .insert(invoices)
      .values({
        tenant_id: tenantId,
        customer_id: customerId,
        subscription_id: sub.id,
        invoice_number: `SUB-${rid()}`,
        invoice_date: new Date().toISOString().slice(0, 10),
        due_date: new Date(Date.now() + 15 * DAY).toISOString().slice(0, 10),
        fy_label: '26-27',
        currency: 'INR',
        status: 'SENT',
        subtotal: '5000.00',
        taxable_amount: '5000.00',
        total_amount: '5000.00',
        amount_outstanding: '5000.00',
      })
      .returning();

    await mandates.applyRazorpayEvent(
      'subscription.charged',
      envelope(rzpId, { payment: { entity: { id: `pay_${rid()}`, amount: 500000 } } }),
    );
    const attempts = await dbAdmin
      .select()
      .from(subscriptionChargeAttempts)
      .where(eq(subscriptionChargeAttempts.subscription_id, sub.id));
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.status).toBe('captured'); // PRD §8.3 enum
    expect(attempts[0]!.attempt_no).toBe(1);
    expect(attempts[0]!.amount).toBe('5000.00');
    expect(attempts[0]!.invoice_id).toBe(inv!.id); // reconciled = stamped

    const [paidInv] = await dbAdmin.select().from(invoices).where(eq(invoices.id, inv!.id));
    expect(paidInv!.status).toBe('PAID');
    expect(paidInv!.amount_outstanding).toBe('0.00');
  });

  it('charged-before-generation race: charge ledgered unreconciled, settled once at generation, never twice', async () => {
    const rzpId = `sub_${rid()}`;
    const sub = await mkSubscription({
      razorpay_subscription_id: rzpId,
      collection_mode: 'auto_debit',
      mandate_status: 'active',
      status: 'ACTIVE',
    });

    // Charge arrives BEFORE the cycle's invoice exists → attempt recorded,
    // nothing to settle, invoice_id stays NULL (unreconciled).
    await mandates.applyRazorpayEvent(
      'subscription.charged',
      envelope(rzpId, { payment: { entity: { id: `pay_${rid()}`, amount: 590000 } } }),
    );
    let attempts = await dbAdmin
      .select()
      .from(subscriptionChargeAttempts)
      .where(eq(subscriptionChargeAttempts.subscription_id, sub.id));
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.status).toBe('captured');
    expect(attempts[0]!.invoice_id).toBeNull(); // unreconciled

    // The generation job then creates the invoice and reconciles.
    const [inv] = await dbAdmin
      .insert(invoices)
      .values({
        tenant_id: tenantId,
        customer_id: customerId,
        subscription_id: sub.id,
        invoice_number: `SUB-${rid()}`,
        invoice_date: new Date().toISOString().slice(0, 10),
        due_date: new Date(Date.now() + 15 * DAY).toISOString().slice(0, 10),
        fy_label: '26-27',
        currency: 'INR',
        status: 'SENT',
        subtotal: '5000.00',
        taxable_amount: '5000.00',
        total_amount: '5900.00',
        amount_outstanding: '5900.00',
      })
      .returning();

    expect(await mandates.settleUnreconciledCharge(tenantId, sub.id, inv!.id)).toBe(true);
    const [paidInv] = await dbAdmin.select().from(invoices).where(eq(invoices.id, inv!.id));
    expect(paidInv!.status).toBe('PAID');
    expect(paidInv!.amount_outstanding).toBe('0.00');
    attempts = await dbAdmin
      .select()
      .from(subscriptionChargeAttempts)
      .where(eq(subscriptionChargeAttempts.subscription_id, sub.id));
    expect(attempts[0]!.invoice_id).toBe(inv!.id); // stamped

    // Idempotent: nothing left to reconcile → no double-pay.
    expect(await mandates.settleUnreconciledCharge(tenantId, sub.id, inv!.id)).toBe(false);
  });

  it('failed charges: subscription.pending strikes (NOT payment.failed), PAST_DUE then 3rd-strike PAUSE, retry emails', async () => {
    const rzpId = `sub_${rid()}`;
    const sub = await mkSubscription({
      razorpay_subscription_id: rzpId,
      collection_mode: 'auto_debit',
      mandate_status: 'active',
      status: 'ACTIVE',
    });
    sendEmailSpy.mockClear();

    // payment.failed for the SAME cycle must NOT add a strike (Razorpay fires
    // both events per failed cycle; only subscription.pending counts).
    await mandates.applyRazorpayEvent(
      'payment.failed',
      envelope(rzpId, { payment: { entity: { subscription_id: rzpId, error_description: 'ignored' } } }),
    );
    let [row] = await dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.id, sub.id));
    expect(row!.failed_charge_count).toBe(0); // payment.failed no-op

    for (let i = 1; i <= 3; i++) {
      await mandates.applyRazorpayEvent(
        'subscription.pending',
        envelope(rzpId, {
          payment: { entity: { subscription_id: rzpId, error_description: 'UPI mandate paused' } },
        }),
      );
    }
    ;[row] = await dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.id, sub.id));
    expect(row!.failed_charge_count).toBe(3);
    expect(row!.status).toBe('PAUSED'); // 3 strikes
    const attempts = await dbAdmin
      .select()
      .from(subscriptionChargeAttempts)
      .where(eq(subscriptionChargeAttempts.subscription_id, sub.id));
    const failed = attempts.filter((a) => a.status === 'failed');
    expect(failed.length).toBe(3); // not 4
    expect(failed.map((a) => a.attempt_no).sort()).toEqual([1, 2, 3]);
    expect(attempts[0]!.failure_reason).toContain('UPI mandate');
    expect(sendEmailSpy).toHaveBeenCalledWith(
      'charge-failed-retry',
      expect.stringContaining('@'),
      expect.objectContaining({ exhausted: false }),
    );
    expect(sendEmailSpy).toHaveBeenCalledWith(
      'charge-failed-retry',
      expect.stringContaining('@'),
      expect.objectContaining({ exhausted: true }),
    );
  });

  it('subscription.halted sets mandate_status=halted, pauses, and notifies the tenant (§8.5.3)', async () => {
    // An owner to receive the in-app notice.
    const [owner] = await dbAdmin
      .insert(users)
      .values({ email: `owner-${rid()}@test.test`, full_name: 'Owner', status: 'active' })
      .returning();
    await dbAdmin.insert(memberships).values({
      tenant_id: tenantId,
      user_id: owner!.id,
      role: 'owner',
      status: 'active',
    });

    const rzpId = `sub_${rid()}`;
    const sub = await mkSubscription({
      razorpay_subscription_id: rzpId,
      collection_mode: 'auto_debit',
      mandate_status: 'active',
      status: 'ACTIVE',
    });
    inAppSpy.mockClear();
    sendEmailSpy.mockClear();

    await mandates.applyRazorpayEvent('subscription.halted', envelope(rzpId));

    const [row] = await dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.id, sub.id));
    expect(row!.status).toBe('PAUSED');
    expect(row!.mandate_status).toBe('halted'); // D14b "Halted" chip
    expect(row!.paused_at).not.toBeNull();
    // Tenant notified: in-app to the owner.
    expect(inAppSpy).toHaveBeenCalledWith(
      owner!.id,
      'invoicing.mandate_halted',
      expect.stringContaining('halted'),
      '/invoicing/recurring',
      tenantId,
    );

    // A plain pause keeps the mandate intact (status only).
    const rzpId2 = `sub_${rid()}`;
    const sub2 = await mkSubscription({
      razorpay_subscription_id: rzpId2,
      collection_mode: 'auto_debit',
      mandate_status: 'active',
      status: 'ACTIVE',
    });
    await mandates.applyRazorpayEvent('subscription.paused', envelope(rzpId2));
    const [row2] = await dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.id, sub2.id));
    expect(row2!.status).toBe('PAUSED');
    expect(row2!.mandate_status).toBe('active'); // pause ≠ mandate death

    await dbAdmin.delete(users).where(eq(users.id, owner!.id));
  });

  it('mandateChargeCents is GST-inclusive so the charge settles the generated invoice exactly', async () => {
    const { mandateChargeCents } = await import('../modules/invoicing/subscriptions.service');
    // ₹5000 base → invoice total ₹5900 (18% GST) → mandate must charge 590000 paise.
    expect(
      mandateChargeCents({ pricing_model: 'flat_rate', flat_amount: '5000.00', seat_rate: null, seat_count: null }),
    ).toBe(590000);
    // Per-seat: ₹1000 × 3 = ₹3000 base → ₹3540 total.
    expect(
      mandateChargeCents({ pricing_model: 'per_seat', flat_amount: null, seat_rate: '1000.00', seat_count: 3 }),
    ).toBe(354000);
  });

  it('subscription.cancelled → mandate revoked, back to manual collection', async () => {
    const rzpId = `sub_${rid()}`;
    const sub = await mkSubscription({
      razorpay_subscription_id: rzpId,
      collection_mode: 'auto_debit',
      mandate_status: 'active',
      status: 'ACTIVE',
    });
    await mandates.applyRazorpayEvent('subscription.cancelled', envelope(rzpId));
    const [row] = await dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.id, sub.id));
    expect(row!.collection_mode).toBe('manual');
    expect(row!.mandate_status).toBe('revoked');
    expect(row!.mandate_revoked_at).not.toBeNull();
    expect(row!.mandate_short_url).toBeNull();
  });

  it('public /sub/<token>: valid → sanitized summary; expired → 410; unknown → 404', async () => {
    const token = crypto.randomBytes(24).toString('base64url');
    await mkSubscription({
      collection_mode: 'auto_debit',
      mandate_status: 'pending_authorization',
      mandate_short_url: 'https://rzp.io/i/test',
      mandate_token: token,
      mandate_token_expires_at: new Date(Date.now() + 7 * DAY),
    });
    const view = await mandates.publicView(token);
    expect(view.data.subscription_name).toContain('Retainer');
    expect(view.data.amount).toBe('5000.00');
    expect(view.data.authorize_url).toBe('https://rzp.io/i/test');
    expect(view.data.customer_name).toBe('Mandate Co');
    // No internal ids leak.
    expect(JSON.stringify(view)).not.toContain(tenantId);

    const expired = crypto.randomBytes(24).toString('base64url');
    await mkSubscription({
      collection_mode: 'auto_debit',
      mandate_status: 'pending_authorization',
      mandate_token: expired,
      mandate_token_expires_at: new Date(Date.now() - DAY),
    });
    await expect(mandates.publicView(expired)).rejects.toThrow(/expired/);
    await expect(mandates.publicView('nope-token')).rejects.toThrow(/not found/);
  });
});
