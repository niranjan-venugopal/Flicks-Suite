import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import {
  customers,
  invoiceSubscriptions,
  invoices,
  memberships,
  subscriptionChargeAttempts,
  tenants,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { R2Service } from '../../core/storage/r2.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RazorpayService } from './razorpay.service';
import { InvSettingsService } from './inv-settings.service';
import { InvoicesService } from './invoices.service';
import { cycleAmountCents, mandateChargeCents } from './subscriptions.service';

const MANDATE_TOKEN_DAYS = 30;
const MAX_FAILED_CHARGES = 3;

/**
 * Tenant-track auto-debit mandates (PRD v4 §8A, Sprint 23). The seller's
 * OAuth-connected Razorpay account charges THEIR customer on a recurring
 * e-mandate: enable-autodebit creates customer→plan→subscription on the
 * sub-merchant and mints the public /sub/<token> page; the customer
 * authorizes on Razorpay's hosted short_url; subscription.* webhooks drive
 * the mandate lifecycle and mark generated invoices PAID
 * (recordPayment source='subscription_charge').
 */
@Injectable()
export class SubscriptionMandatesService {
  private readonly logger = new Logger(SubscriptionMandatesService.name);

  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly notifications: NotificationsService,
    private readonly razorpay: RazorpayService,
    private readonly settings: InvSettingsService,
    private readonly invoices: InvoicesService,
    private readonly config: ConfigService,
    private readonly r2: R2Service,
  ) {}

  // ─── Enable / disable (seller actions) ──────────────────────────────────────

  async enableAutodebit(id: string, userId: string, tenantId: string) {
    const sub = await this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(invoiceSubscriptions)
        .where(eq(invoiceSubscriptions.id, id))
        .limit(1);
      if (!row) throw new NotFoundException('Subscription not found');
      return row;
    });
    // Cheap input guards FIRST — reject before any external Razorpay work.
    if (sub.currency !== 'INR') {
      throw new BadRequestException(
        'Auto-debit mandates are INR-only (Razorpay e-mandate constraint) — non-INR profiles stay on manual collection.',
      );
    }
    if (['CANCELLED', 'EXPIRED'].includes(sub.status)) {
      throw new BadRequestException(`Cannot enable auto-debit on a ${sub.status} profile`);
    }
    if (sub.billing_period === 'custom') {
      throw new BadRequestException(
        'Custom-period profiles can’t use auto-debit — Razorpay mandates support monthly/quarterly/annual cycles.',
      );
    }
    // GST-inclusive — the mandate must charge exactly what the generated
    // invoice totals (base + 18% GST), or the invoice never reaches PAID.
    const amountPaise = mandateChargeCents(sub);
    if (amountPaise <= 0) throw new BadRequestException('Cycle amount must be positive');
    if (sub.razorpay_subscription_id && sub.mandate_status !== 'revoked') {
      // Idempotent re-entry: the pending mandate link is reusable.
      return this.mandatePayload(tenantId, sub.id);
    }

    const auth = await this.settings.resolveRazorpayForOrder(tenantId);
    if (!auth) {
      throw new ServiceUnavailableException(
        'Connect your Razorpay account first (Invoicing → Settings → Payments) — auto-debit charges run on YOUR Razorpay.',
      );
    }

    const [customer] = await this.dbAdmin
      .select()
      .from(customers)
      .where(and(eq(customers.id, sub.customer_id), eq(customers.tenant_id, tenantId)))
      .limit(1);
    if (!customer) throw new NotFoundException('Customer not found');

    // 1 — Razorpay customer handle (reused across this customer's mandates).
    let rzpCustomerId = customer.razorpay_customer_id;
    if (!rzpCustomerId) {
      rzpCustomerId = (
        await this.razorpay.createCustomer({
          accessToken: auth.accessToken,
          name: customer.display_name,
          email: customer.email,
          tenantId,
          customerId: customer.id,
        })
      ).id;
      await this.dbAdmin
        .update(customers)
        .set({ razorpay_customer_id: rzpCustomerId })
        .where(eq(customers.id, customer.id));
    }

    // 2 — plan for this profile's cycle amount/cadence (guards already passed).
    const period =
      sub.billing_period === 'annually'
        ? ('yearly' as const)
        : sub.billing_period === 'quarterly'
          ? ('quarterly' as const)
          : ('monthly' as const);
    let planId = sub.razorpay_plan_id;
    if (!planId) {
      planId = (
        await this.razorpay.createPlan({
          accessToken: auth.accessToken,
          name: `${sub.name} · ${sub.billing_period}`,
          amountPaise,
          period,
        })
      ).id;
    }

    // 3 — subscription; total_count from the end condition (§8A). The enum
    // value is 'after_n_cycles' (dto/invoicing.dto.ts) — a wrong literal here
    // would silently let Razorpay charge up to 60 cycles past the agreed count.
    const totalCount =
      sub.end_condition === 'after_n_cycles' && sub.end_after_cycles
        ? sub.end_after_cycles
        : 60; // until_cancelled → 5 years of monthly headroom, renewable
    const startDate = sub.next_billing_date ?? sub.start_date;
    const startAt = new Date(`${startDate}T00:00:00Z`);
    const rzpSub = await this.razorpay.createSubscription({
      accessToken: auth.accessToken,
      planId,
      customerId: rzpCustomerId,
      totalCount,
      startAt: startAt.getTime() > Date.now() + 10 * 60 * 1000 ? startAt : null,
      notes: { tenant_id: tenantId, subscription_id: sub.id },
    });

    // 4 — mint the public page token + persist the mandate state.
    const token = crypto.randomBytes(24).toString('base64url');
    await this.dbAdmin
      .update(invoiceSubscriptions)
      .set({
        collection_mode: 'auto_debit',
        mandate_status: 'pending_authorization',
        mandate_short_url: rzpSub.short_url ?? null,
        mandate_token: token,
        mandate_token_expires_at: new Date(Date.now() + MANDATE_TOKEN_DAYS * 86400000),
        razorpay_subscription_id: rzpSub.id,
        razorpay_plan_id: planId,
        updated_at: new Date(),
      })
      .where(eq(invoiceSubscriptions.id, sub.id));

    // 5 — D15 authorization-request email to the customer. Guarded: the
    // mandate is already committed above, so an email-provider hiccup must
    // NOT 500 the request (the seller can still copy the link from the
    // drawer, and idempotent re-entry wouldn't re-reach this block).
    const publicUrl = `${this.config.get<string>('PUBLIC_INVOICE_BASE_URL', 'http://localhost:3000')}/sub/${token}`;
    if (customer.email) {
      try {
        await this.notifications.sendEmail('mandate-authorization-request', customer.email, {
          customerName: customer.display_name,
          subscriptionName: sub.name,
          amount: `₹${(amountPaise / 100).toLocaleString('en-IN')}`,
          cadence: sub.billing_period,
          authorizeUrl: publicUrl,
        });
      } catch (err) {
        this.logger.warn(
          `mandate-authorization email failed (link still available in the drawer): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.subscription.autodebit_enabled',
      resourceType: 'invoice_subscription',
      resourceId: sub.id,
      metadata: { razorpay_subscription_id: rzpSub.id, plan_id: planId },
    });
    return this.mandatePayload(tenantId, sub.id);
  }

  async disableAutodebit(id: string, userId: string, tenantId: string) {
    const sub = await this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(invoiceSubscriptions)
        .where(eq(invoiceSubscriptions.id, id))
        .limit(1);
      if (!row) throw new NotFoundException('Subscription not found');
      return row;
    });
    if (sub.collection_mode !== 'auto_debit') {
      throw new BadRequestException('This profile already collects manually');
    }
    // Best-effort remote cancel — local truth flips regardless; a late
    // webhook for the dead subscription is a no-op (id no longer matches).
    if (sub.razorpay_subscription_id) {
      try {
        const auth = await this.settings.resolveRazorpayForOrder(tenantId);
        if (auth) {
          await this.razorpay.cancelSubscription(auth.accessToken, sub.razorpay_subscription_id);
        }
      } catch (err) {
        this.logger.warn(
          `razorpay mandate cancel failed (continuing local disable): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    await this.dbAdmin
      .update(invoiceSubscriptions)
      .set({
        collection_mode: 'manual',
        mandate_status: sub.mandate_status === 'none' ? 'none' : 'revoked',
        mandate_revoked_at: sub.mandate_authorized_at ? new Date() : sub.mandate_revoked_at,
        mandate_short_url: null,
        mandate_token: null,
        mandate_token_expires_at: null,
        razorpay_subscription_id: null,
        // Clear the plan too: a later re-enable after a price change must mint
        // a FRESH plan, not reuse this (now stale) one and mischarge.
        razorpay_plan_id: null,
        updated_at: new Date(),
      })
      .where(eq(invoiceSubscriptions.id, sub.id));
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.subscription.autodebit_disabled',
      resourceType: 'invoice_subscription',
      resourceId: sub.id,
    });
    return this.mandatePayload(tenantId, sub.id);
  }

  /** D14b — the mandate chip + public link + charge timeline payload. */
  async mandatePayload(tenantId: string, id: string) {
    const [sub] = await this.dbAdmin
      .select({
        id: invoiceSubscriptions.id,
        collection_mode: invoiceSubscriptions.collection_mode,
        mandate_status: invoiceSubscriptions.mandate_status,
        mandate_short_url: invoiceSubscriptions.mandate_short_url,
        mandate_token: invoiceSubscriptions.mandate_token,
        mandate_authorized_at: invoiceSubscriptions.mandate_authorized_at,
        mandate_revoked_at: invoiceSubscriptions.mandate_revoked_at,
        tenant_id: invoiceSubscriptions.tenant_id,
      })
      .from(invoiceSubscriptions)
      .where(and(eq(invoiceSubscriptions.id, id), eq(invoiceSubscriptions.tenant_id, tenantId)))
      .limit(1);
    if (!sub) throw new NotFoundException('Subscription not found');
    const base = this.config.get<string>('PUBLIC_INVOICE_BASE_URL', 'http://localhost:3000');
    return {
      data: {
        ...sub,
        tenant_id: undefined,
        public_url: sub.mandate_token ? `${base}/sub/${sub.mandate_token}` : null,
      },
    };
  }

  async chargeAttempts(id: string, tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(subscriptionChargeAttempts)
        .where(eq(subscriptionChargeAttempts.subscription_id, id))
        .orderBy(desc(subscriptionChargeAttempts.attempted_at))
        .limit(50);
      return { data: rows };
    });
  }

  // ─── Public /sub/<token> page (D14c — public-invoice pattern) ──────────────

  async publicView(token: string) {
    const [sub] = await this.dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.mandate_token, token))
      .limit(1);
    if (!sub) throw new NotFoundException('Mandate link not found');
    if (
      sub.mandate_token_expires_at &&
      new Date(sub.mandate_token_expires_at).getTime() < Date.now() &&
      sub.mandate_status === 'pending_authorization'
    ) {
      throw new GoneException('This authorization link has expired — ask the sender for a fresh one.');
    }
    const [tenant] = await this.dbAdmin
      .select({ name: tenants.name, logo_key: tenants.logo_key, logo_url: tenants.logo_url })
      .from(tenants)
      .where(eq(tenants.id, sub.tenant_id))
      .limit(1);
    const [customer] = await this.dbAdmin
      .select({ display_name: customers.display_name })
      .from(customers)
      .where(eq(customers.id, sub.customer_id))
      .limit(1);
    let logoUrl = tenant?.logo_url ?? null;
    if (tenant?.logo_key && this.r2.isConfigured()) {
      try {
        logoUrl = await this.r2.signedGetUrl(tenant.logo_key);
      } catch {
        /* legacy fallback stands */
      }
    }
    const amountPaise = cycleAmountCents(sub);
    return {
      data: {
        seller_name: tenant?.name ?? null,
        seller_logo_url: logoUrl,
        customer_name: customer?.display_name ?? null,
        subscription_name: sub.name,
        amount: (amountPaise / 100).toFixed(2),
        currency: sub.currency,
        billing_period: sub.billing_period,
        next_billing_date: sub.next_billing_date,
        mandate_status: sub.mandate_status,
        authorize_url:
          sub.mandate_status === 'pending_authorization' ? sub.mandate_short_url : null,
      },
    };
  }

  // ─── Webhook lifecycle (service-role; called by RazorpayWebhookController) ──

  async applyRazorpayEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const entity = this.subscriptionEntity(payload);
    if (!entity?.id) return;
    const [sub] = await this.dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.razorpay_subscription_id, entity.id))
      .limit(1);
    if (!sub) {
      this.logger.warn(`tenant webhook for unknown mandate subscription ${entity.id} (${eventType})`);
      return;
    }
    const tenantId = sub.tenant_id;

    switch (eventType) {
      case 'subscription.authenticated': {
        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({
            mandate_status: 'authenticated',
            mandate_authorized_at: sub.mandate_authorized_at ?? new Date(),
            payment_method: sub.payment_method ?? 'upi_autopay',
            updated_at: new Date(),
          })
          .where(eq(invoiceSubscriptions.id, sub.id));
        void this.analytics.track({ event: 'mandate_authorized', tenantId });
        break;
      }
      case 'subscription.activated': {
        const inTrial =
          sub.trial_ends_at && sub.trial_ends_at >= new Date().toISOString().slice(0, 10);
        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({
            status: inTrial ? 'TRIALING' : 'ACTIVE',
            mandate_status: 'active',
            mandate_authorized_at: sub.mandate_authorized_at ?? new Date(),
            failed_charge_count: 0,
            paused_at: null,
            updated_at: new Date(),
          })
          .where(eq(invoiceSubscriptions.id, sub.id));
        break;
      }
      case 'subscription.charged': {
        const payment = this.paymentEntity(payload);
        const amountPaise = payment?.amount ?? cycleAmountCents(sub);
        const [attempt] = await this.dbAdmin
          .insert(subscriptionChargeAttempts)
          .values({
            tenant_id: tenantId,
            subscription_id: sub.id,
            razorpay_payment_id: payment?.id ?? null,
            status: 'captured',
            attempt_no: (sub.total_cycles_billed ?? 0) + 1,
            amount: (amountPaise / 100).toFixed(2),
            currency: sub.currency,
          })
          .returning({ id: subscriptionChargeAttempts.id });
        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({ status: 'ACTIVE', failed_charge_count: 0, mandate_status: 'active', updated_at: new Date() })
          .where(eq(invoiceSubscriptions.id, sub.id));
        await this.settleGeneratedInvoice(
          tenantId,
          sub.id,
          amountPaise,
          payment?.id ?? null,
          attempt?.id ?? null,
        );
        void this.analytics.track({
          event: 'subscription_charged',
          tenantId,
          properties: { amount_paise: amountPaise },
        });
        break;
      }
      case 'subscription.pending': {
        // THE canonical per-cycle failure signal. Razorpay ALSO emits
        // payment.failed for the same failed charge — counting both would
        // double the strikes and duplicate the customer email, so the strike
        // is driven ONLY from subscription.pending (payment.failed no-ops).
        const failures = (sub.failed_charge_count ?? 0) + 1;
        const exhausted = failures >= MAX_FAILED_CHARGES;
        await this.dbAdmin.insert(subscriptionChargeAttempts).values({
          tenant_id: tenantId,
          subscription_id: sub.id,
          razorpay_payment_id: this.paymentEntity(payload)?.id ?? null,
          status: 'failed',
          attempt_no: failures,
          amount: (mandateChargeCents(sub) / 100).toFixed(2),
          currency: sub.currency,
          failure_reason: this.failureReason(payload),
          failure_code: this.failureCode(payload),
        });
        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({
            status: exhausted ? 'PAUSED' : 'PAST_DUE',
            failed_charge_count: failures,
            last_failure_at: new Date(),
            ...(exhausted ? { paused_at: new Date() } : {}),
            updated_at: new Date(),
          })
          .where(eq(invoiceSubscriptions.id, sub.id));
        await this.sendChargeFailedEmail(tenantId, sub.id, exhausted);
        break;
      }
      case 'subscription.halted': {
        // Razorpay gave up on the mandate (dunning exhausted at their end).
        // Distinct from a plain pause: the mandate itself is dead, so reflect
        // it in mandate_status (drives the D14b "Halted" chip) AND tell the
        // TENANT — a halt means their auto-collection has stopped.
        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({
            status: 'PAUSED',
            mandate_status: 'halted',
            paused_at: new Date(),
            updated_at: new Date(),
          })
          .where(eq(invoiceSubscriptions.id, sub.id));
        await this.notifyTenantMandateHalted(tenantId, sub.id);
        break;
      }
      case 'subscription.paused': {
        // A pause is reversible and the mandate stays valid — status only.
        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({ status: 'PAUSED', paused_at: new Date(), updated_at: new Date() })
          .where(eq(invoiceSubscriptions.id, sub.id));
        break;
      }
      case 'subscription.resumed': {
        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({ status: 'ACTIVE', paused_at: null, updated_at: new Date() })
          .where(eq(invoiceSubscriptions.id, sub.id));
        break;
      }
      case 'subscription.cancelled': {
        // Customer revoked (or Razorpay killed) the mandate → back to manual
        // collection; the profile itself stays for manual invoicing. Clear the
        // public token + plan so the /sub page stops resolving and a future
        // re-enable mints fresh (never a stale plan/link).
        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({
            collection_mode: 'manual',
            mandate_status: 'revoked',
            mandate_revoked_at: new Date(),
            mandate_short_url: null,
            mandate_token: null,
            mandate_token_expires_at: null,
            razorpay_plan_id: null,
            updated_at: new Date(),
          })
          .where(eq(invoiceSubscriptions.id, sub.id));
        await this.sendMandateRevokedEmail(tenantId, sub.id);
        break;
      }
      default:
        this.logger.log(`tenant webhook ${eventType} acknowledged (no-op)`);
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  /**
   * Mark the newest open generated invoice PAID via the charge (§8A.4) and
   * stamp the charge-attempt row with the settled invoice. An attempt whose
   * invoice_id stays NULL is UNRECONCILED — the charge landed before the
   * cycle's invoice was generated; the generation job settles it then
   * (settleUnreconciledCharge below).
   */
  private async settleGeneratedInvoice(
    tenantId: string,
    subscriptionId: string,
    amountPaise: number,
    paymentId: string | null,
    attemptId: string | null,
  ): Promise<void> {
    const [inv] = await this.dbAdmin
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.subscription_id, subscriptionId),
          eq(invoices.tenant_id, tenantId),
          inArray(invoices.status, ['SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID']),
        ),
      )
      .orderBy(desc(invoices.created_at))
      .limit(1);
    if (!inv) {
      this.logger.warn(
        `subscription.charged for ${subscriptionId}: no open generated invoice yet — charge recorded, will reconcile at generation`,
      );
      return;
    }
    try {
      await this.invoices.recordPayment(
        inv.id,
        {
          amount: (amountPaise / 100).toFixed(2),
          payment_method: 'RAZORPAY_UPI',
          reference_number: paymentId ?? undefined,
          notes: 'Auto-debit mandate charge',
        } as never,
        null,
        tenantId,
        'subscription_charge',
      );
      if (attemptId) {
        await this.dbAdmin
          .update(subscriptionChargeAttempts)
          .set({ invoice_id: inv.id })
          .where(eq(subscriptionChargeAttempts.id, attemptId));
      }
    } catch (err) {
      this.logger.error(
        `recordPayment(subscription_charge) failed for invoice ${inv.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Reconciliation for the charged-before-generation race: called by the
   * generation job right after it creates a cycle's invoice. If a captured
   * charge attempt is still unreconciled (invoice_id NULL), settle the fresh
   * invoice from it and stamp the attempt. Idempotent: the stamp prevents a
   * second settle, and duplicate webhook deliveries are already deduped by
   * event_id upstream.
   */
  async settleUnreconciledCharge(tenantId: string, subscriptionId: string, invoiceId: string): Promise<boolean> {
    const [attempt] = await this.dbAdmin
      .select({
        id: subscriptionChargeAttempts.id,
        amount: subscriptionChargeAttempts.amount,
        razorpay_payment_id: subscriptionChargeAttempts.razorpay_payment_id,
      })
      .from(subscriptionChargeAttempts)
      .where(
        and(
          eq(subscriptionChargeAttempts.subscription_id, subscriptionId),
          eq(subscriptionChargeAttempts.tenant_id, tenantId),
          eq(subscriptionChargeAttempts.status, 'captured'),
          sql`${subscriptionChargeAttempts.invoice_id} is null`,
        ),
      )
      .orderBy(desc(subscriptionChargeAttempts.attempted_at))
      .limit(1);
    if (!attempt) return false;
    try {
      await this.invoices.recordPayment(
        invoiceId,
        {
          amount: attempt.amount,
          payment_method: 'RAZORPAY_UPI',
          reference_number: attempt.razorpay_payment_id ?? undefined,
          notes: 'Auto-debit mandate charge (reconciled at generation)',
        } as never,
        null,
        tenantId,
        'subscription_charge',
      );
      await this.dbAdmin
        .update(subscriptionChargeAttempts)
        .set({ invoice_id: invoiceId })
        .where(eq(subscriptionChargeAttempts.id, attempt.id));
      this.logger.log(
        `reconciled pre-generation charge ${attempt.id} against invoice ${invoiceId}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `reconciliation settle failed for invoice ${invoiceId}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  private async sendChargeFailedEmail(
    tenantId: string,
    subscriptionId: string,
    exhausted: boolean,
  ): Promise<void> {
    try {
      const info = await this.subscriptionEmailInfo(subscriptionId);
      if (!info?.customer_email) return;
      await this.notifications.sendEmail('charge-failed-retry', info.customer_email, {
        customerName: info.customer_name,
        subscriptionName: info.name,
        sellerName: info.tenant_name,
        exhausted,
      });
    } catch (err) {
      this.logger.warn(`charge-failed email skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async sendMandateRevokedEmail(tenantId: string, subscriptionId: string): Promise<void> {
    try {
      const info = await this.subscriptionEmailInfo(subscriptionId);
      // The SELLER needs to know their customer revoked — notify the creator
      // falling back to nothing (FAM can see it in the audit trail).
      if (!info?.creator_email) return;
      await this.notifications.sendEmail('mandate-revoked', info.creator_email, {
        subscriptionName: info.name,
        customerName: info.customer_name,
      });
    } catch (err) {
      this.logger.warn(`mandate-revoked email skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async subscriptionEmailInfo(subscriptionId: string) {
    const [row] = await this.dbAdmin
      .select({
        name: invoiceSubscriptions.name,
        customer_name: customers.display_name,
        customer_email: customers.email,
        tenant_name: tenants.name,
        creator_email: sql<string | null>`(SELECT email FROM users WHERE id = ${invoiceSubscriptions.created_by})`,
      })
      .from(invoiceSubscriptions)
      .innerJoin(customers, eq(customers.id, invoiceSubscriptions.customer_id))
      .innerJoin(tenants, eq(tenants.id, invoiceSubscriptions.tenant_id))
      .where(eq(invoiceSubscriptions.id, subscriptionId))
      .limit(1);
    return row ?? null;
  }

  private subscriptionEntity(
    payload: Record<string, unknown>,
  ): { id?: string } | null {
    const p = payload as {
      payload?: {
        subscription?: { entity?: { id?: string } };
        payment?: { entity?: { subscription_id?: string } };
      };
    };
    const direct = p.payload?.subscription?.entity;
    if (direct?.id) return direct;
    const viaPayment = p.payload?.payment?.entity?.subscription_id;
    return viaPayment ? { id: viaPayment } : null;
  }

  private paymentEntity(payload: Record<string, unknown>): { id?: string; amount?: number } | null {
    const p = payload as { payload?: { payment?: { entity?: { id?: string; amount?: number } } } };
    return p.payload?.payment?.entity ?? null;
  }

  private failureReason(payload: Record<string, unknown>): string | null {
    const p = payload as {
      payload?: { payment?: { entity?: { error_description?: string; error_code?: string } } };
    };
    const e = p.payload?.payment?.entity;
    return e?.error_description ?? e?.error_code ?? null;
  }

  private failureCode(payload: Record<string, unknown>): string | null {
    const p = payload as {
      payload?: { payment?: { entity?: { error_code?: string } } };
    };
    return p.payload?.payment?.entity?.error_code ?? null;
  }

  /**
   * §8.5.3 — a halt kills auto-collection, so the TENANT must hear about it
   * (the revoke path only emails the seller). In-app to every owner/admin plus
   * the profile creator, and reuse the D15 revoked/halted email for the creator.
   */
  private async notifyTenantMandateHalted(tenantId: string, subscriptionId: string): Promise<void> {
    try {
      const info = await this.subscriptionEmailInfo(subscriptionId);
      const name = info?.name ?? 'a recurring profile';
      const admins = await this.dbAdmin
        .select({ user_id: memberships.user_id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.status, 'active'),
            inArray(memberships.role, ['owner', 'admin']),
          ),
        );
      const creatorId = await this.dbAdmin
        .select({ created_by: invoiceSubscriptions.created_by })
        .from(invoiceSubscriptions)
        .where(eq(invoiceSubscriptions.id, subscriptionId))
        .limit(1)
        .then((r) => r[0]?.created_by ?? null);
      const recipients = new Set<string>(admins.map((a) => a.user_id));
      if (creatorId) recipients.add(creatorId);
      const message = `Auto-debit was halted on "${name}" after repeated failed charges — it's back to manual collection.`;
      for (const userId of recipients) {
        await this.notifications.createInAppNotification(
          userId,
          'invoicing.mandate_halted',
          message,
          '/invoicing/recurring',
          tenantId,
        );
      }
      if (info?.creator_email) {
        await this.notifications.sendEmail('mandate-revoked', info.creator_email, {
          subscriptionName: info.name,
          customerName: info.customer_name,
          reason: 'halted',
        });
      }
    } catch (err) {
      this.logger.warn(`mandate-halted notify skipped: ${err instanceof Error ? err.message : err}`);
    }
  }
}
