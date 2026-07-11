import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  invoices,
  customers,
  reminderSchedule,
  reminderSent,
  invoiceSubscriptions,
  invoiceSubscriptionProrationEvents,
  auditLog,
} from '@flicks/db/schema';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';
import { SubscriptionMandatesService } from '../modules/invoicing/subscription-mandates.service';
import { advanceDate, cycleAmountCents, SUBSCRIPTION_GST_RATE } from '../modules/invoicing/subscriptions.service';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../core/database/database.module';
import { DatabaseService } from '../core/database/database.service';

/**
 * Invoicing scheduled jobs (PRD §5 "Background jobs"), scaffolded as
 * @nestjs/schedule @Cron providers — consistent with the existing V1 jobs
 * (BullMQ/Upstash deferred). Each is a logged no-op here; the real sweeps land
 * in the sprint that owns the feature (reminders/reports → Sprint 6,
 * subscriptions/dunning/FX → Sprint 7). Times are IST where the PRD specifies.
 */
@Injectable()
export class InvoicingJobs {
  private readonly logger = new Logger(InvoicingJobs.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly notifications: NotificationsService,
    private readonly invoicesService: InvoicesService,
    private readonly config: ConfigService,
    private readonly mandates: SubscriptionMandatesService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'mark-overdue-invoices' })
  async markOverdueInvoices(): Promise<void> {
    // SENT/VIEWED/PARTIALLY_PAID past due_date → OVERDUE (§6.5). Cross-tenant
    // sweep on the service role; RLS-scoped reads are unaffected.
    const today = new Date().toISOString().slice(0, 10);
    const updated = await this.dbAdmin
      .update(invoices)
      .set({ status: 'OVERDUE', updated_at: new Date() })
      .where(
        and(
          inArray(invoices.status, ['SENT', 'VIEWED', 'PARTIALLY_PAID']),
          lt(invoices.due_date, today),
        ),
      )
      .returning({ id: invoices.id });
    if (updated.length > 0) {
      this.logger.log(`mark-overdue-invoices: ${updated.length} invoice(s) → OVERDUE`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'expire-quotes' })
  async expireQuotes(): Promise<void> {
    // Sprint 3: SENT_AS_QUOTE past valid_until → QUOTE_EXPIRED.
    this.logger.debug('expire-quotes (stub)');
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'send-reminders' })
  async sendReminders(): Promise<void> {
    const sent = await this.runRemindersSweep();
    if (sent > 0) this.logger.log(`send-reminders: ${sent} reminder(s) sent`);
  }

  /**
   * Reminder sweep (§6.9): for every open invoice, fire any tenant-level
   * schedule step whose offset (days relative to due date) has been reached.
   * Idempotent via the reminder_sent (invoice, reminder_number) unique key —
   * ON CONFLICT DO NOTHING means a step can never double-send. Exposed for the
   * integration test.
   */
  async runRemindersSweep(): Promise<number> {
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    const open = await this.dbAdmin
      .select({
        id: invoices.id,
        tenant_id: invoices.tenant_id,
        invoice_number: invoices.invoice_number,
        due_date: invoices.due_date,
        currency: invoices.currency,
        amount_outstanding: invoices.amount_outstanding,
        customer_id: invoices.customer_id,
      })
      .from(invoices)
      .where(inArray(invoices.status, ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE']));
    if (!open.length) return 0;

    const schedules = await this.dbAdmin
      .select()
      .from(reminderSchedule)
      .where(and(eq(reminderSchedule.active, true), eq(reminderSchedule.scope, 'tenant')));
    if (!schedules.length) return 0;
    const byTenant = new Map<string, typeof schedules>();
    for (const s of schedules) {
      const arr = byTenant.get(s.tenant_id) ?? [];
      arr.push(s);
      byTenant.set(s.tenant_id, arr);
    }

    let sentCount = 0;
    for (const inv of open) {
      const steps = byTenant.get(inv.tenant_id);
      if (!steps) continue;
      const daysFromDue = Math.floor(
        (today - new Date(`${inv.due_date}T00:00:00Z`).getTime()) / 86400000,
      );
      for (const step of steps) {
        // A step fires once its offset is reached (e.g. −3 fires from 3 days
        // before due, +7 from 7 days after).
        if (daysFromDue < step.offset_days) continue;
        const inserted = await this.dbAdmin
          .insert(reminderSent)
          .values({
            tenant_id: inv.tenant_id,
            invoice_id: inv.id,
            reminder_number: step.reminder_number,
            offset_days: step.offset_days,
          })
          .onConflictDoNothing({
            target: [reminderSent.invoice_id, reminderSent.reminder_number],
          })
          .returning({ id: reminderSent.id });
        if (!inserted[0]) continue; // already sent — idempotent

        const [customer] = await this.dbAdmin
          .select({ email: customers.email, name: customers.display_name })
          .from(customers)
          .where(eq(customers.id, inv.customer_id))
          .limit(1);
        if (customer?.email) {
          await this.notifications.sendEmail('invoice-reminder', customer.email, {
            invoiceNumber: inv.invoice_number,
            customerName: customer.name,
            amount: `${inv.currency} ${inv.amount_outstanding}`,
            dueDate: inv.due_date,
            overdue: daysFromDue > 0,
          });
        }
        sentCount++;
      }
    }
    return sentCount;
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'generate-subscription-invoices' })
  async generateSubscriptionInvoices(): Promise<void> {
    const n = await this.runSubscriptionGeneration();
    if (n > 0) this.logger.log(`generate-subscription-invoices: ${n} invoice(s) generated`);
  }

  /**
   * Generation sweep (§6.8): ACTIVE/TRIALING subscriptions whose
   * next_billing_date has arrived get a real invoice through the same
   * InvoicesService path as manual ones (numbering, GST, §8 bank selection),
   * with pending proration events folded in as extra lines. The invoice is
   * auto-sent when the customer has an email (SCHEDULED→AUTO_GENERATING→SENT),
   * the cycle advances, and end conditions retire the profile to EXPIRED.
   */
  async runSubscriptionGeneration(): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const due = await this.dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(
        and(
          inArray(invoiceSubscriptions.status, ['ACTIVE', 'TRIALING']),
          sql`${invoiceSubscriptions.next_billing_date} <= ${today}`,
        ),
      );

    let generated = 0;
    for (const sub of due) {
      try {
        // Pending prorations → extra lines (negative for seat removals).
        const prorations = await this.dbAdmin
          .select()
          .from(invoiceSubscriptionProrationEvents)
          .where(
            and(
              eq(invoiceSubscriptionProrationEvents.subscription_id, sub.id),
              sql`${invoiceSubscriptionProrationEvents.applied_to_invoice_id} is null`,
            ),
          );

        const baseLine =
          sub.pricing_model === 'per_seat'
            ? {
                item_name: `${sub.name} (${sub.seat_count} seats)`,
                quantity: String(sub.seat_count ?? 1),
                rate: sub.seat_rate ?? '0',
                gst_rate: String(SUBSCRIPTION_GST_RATE),
              }
            : {
                item_name: sub.name,
                quantity: '1',
                rate: sub.flat_amount ?? '0',
                gst_rate: String(SUBSCRIPTION_GST_RATE),
              };
        const prorationLines = prorations.map((ev) => ({
          item_name: `Proration · ${ev.event_type.replace(/_/g, ' ')} (${ev.event_date})`,
          quantity: '1',
          rate: ev.amount,
          gst_rate: String(SUBSCRIPTION_GST_RATE),
        }));

        const billDate = sub.next_billing_date ?? today;
        const created = await this.invoicesService.create(
          {
            customer_id: sub.customer_id,
            invoice_date: billDate,
            due_date: advanceDate(billDate, 'custom', 15), // net-15 on subscription invoices
            currency: sub.currency,
            reference: `Subscription ${sub.name}`,
            line_items: [baseLine, ...prorationLines],
          },
          sub.created_by ?? '',
          sub.tenant_id,
        );

        await this.dbAdmin
          .update(invoices)
          .set({ subscription_id: sub.id })
          .where(eq(invoices.id, created.data.id));
        for (const ev of prorations) {
          await this.dbAdmin
            .update(invoiceSubscriptionProrationEvents)
            .set({ applied_to_invoice_id: created.data.id })
            .where(eq(invoiceSubscriptionProrationEvents.id, ev.id));
        }

        // Auto-send (lifecycle …→SENT). Failure to email must not lose the cycle.
        try {
          await this.invoicesService.send(created.data.id, sub.created_by ?? '', sub.tenant_id);
        } catch (err) {
          this.logger.warn(
            `Subscription ${sub.id}: invoice ${created.data.invoice_number} generated but not sent (${err instanceof Error ? err.message : 'unknown'})`,
          );
        }

        // Charged-before-generation race: if Razorpay's subscription.charged
        // landed before this invoice existed, the captured attempt is still
        // unreconciled — settle this invoice from it now (idempotent stamp).
        if (sub.collection_mode === 'auto_debit') {
          await this.mandates.settleUnreconciledCharge(sub.tenant_id, sub.id, created.data.id);
        }

        // Advance the cycle + counters; apply end conditions.
        const nextDate = advanceDate(billDate, sub.billing_period, sub.custom_period_days);
        const cycles = (sub.total_cycles_billed ?? 0) + 1;
        const billedCents =
          Math.round(parseFloat(sub.total_amount_billed ?? '0') * 100) +
          Math.round(parseFloat(created.data.total_amount) * 100);
        const expired =
          (sub.end_condition === 'after_n_cycles' && sub.end_after_cycles != null && cycles >= sub.end_after_cycles) ||
          (sub.end_condition === 'on_date' && sub.end_date != null && nextDate > sub.end_date);

        await this.dbAdmin
          .update(invoiceSubscriptions)
          .set({
            next_billing_date: expired ? null : nextDate,
            next_billing_amount: (cycleAmountCents(sub) / 100).toFixed(2),
            total_cycles_billed: cycles,
            total_amount_billed: (billedCents / 100).toFixed(2),
            status: expired ? 'EXPIRED' : sub.status === 'TRIALING' && sub.trial_ends_at && nextDate > sub.trial_ends_at ? 'ACTIVE' : sub.status,
            updated_at: new Date(),
          })
          .where(eq(invoiceSubscriptions.id, sub.id));
        generated++;
      } catch (err) {
        this.logger.error(
          `Subscription ${sub.id} generation failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return generated;
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'send-pre-debit-notifications' })
  async sendPreDebitNotifications(): Promise<void> {
    const n = await this.runPreDebitSweep();
    if (n > 0) this.logger.log(`send-pre-debit-notifications: ${n} notice(s) sent`);
  }

  /**
   * Pre-debit sweep (§6.8): 24h before the next mandate charge, notify the
   * customer. Idempotent per (subscription, billing date) via an audit-log
   * marker — the hourly cron can run all day without double-sending.
   */
  async runPreDebitSweep(): Promise<number> {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const upcoming = await this.dbAdmin
      .select({
        sub: invoiceSubscriptions,
        customer_email: customers.email,
        customer_name: customers.display_name,
      })
      .from(invoiceSubscriptions)
      .leftJoin(customers, eq(invoiceSubscriptions.customer_id, customers.id))
      .where(
        and(
          inArray(invoiceSubscriptions.status, ['ACTIVE', 'TRIALING']),
          // RBI pre-debit notices are an AUTO-DEBIT obligation — manual
          // profiles get normal invoices, never "you will be charged" emails.
          eq(invoiceSubscriptions.collection_mode, 'auto_debit'),
          sql`${invoiceSubscriptions.mandate_authorized_at} is not null`,
          eq(invoiceSubscriptions.next_billing_date, tomorrow),
        ),
      );

    let sent = 0;
    for (const { sub, customer_email, customer_name } of upcoming) {
      // Idempotency marker: one pre-debit audit row per (sub, billing date).
      const [already] = await this.dbAdmin
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, sub.tenant_id),
            eq(auditLog.action, 'invoicing.subscription.pre_debit'),
            eq(auditLog.resource_id, sub.id),
            sql`${auditLog.metadata} ->> 'billing_date' = ${tomorrow}`,
          ),
        )
        .limit(1);
      if (already) continue;

      if (customer_email) {
        // D15/Appendix E: include the upcoming cycle's invoice ref + a
        // manage/cancel link (the public /sub/<token> mandate page).
        const [latestInv] = await this.dbAdmin
          .select({ invoice_number: invoices.invoice_number })
          .from(invoices)
          .where(
            and(
              eq(invoices.subscription_id, sub.id),
              inArray(invoices.status, ['SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID']),
            ),
          )
          .orderBy(desc(invoices.created_at))
          .limit(1);
        const base = this.config.get<string>(
          'PUBLIC_INVOICE_BASE_URL',
          'http://localhost:3000',
        );
        await this.notifications.sendEmail('subscription-pre-debit', customer_email, {
          customerName: customer_name,
          name: sub.name,
          amount: `${sub.currency} ${sub.next_billing_amount ?? '0.00'}`,
          chargeDate: tomorrow,
          invoiceRef: latestInv?.invoice_number,
          manageUrl: sub.mandate_token ? `${base}/sub/${sub.mandate_token}` : undefined,
        });
      }
      await this.dbAdmin.insert(auditLog).values({
        tenant_id: sub.tenant_id,
        action: 'invoicing.subscription.pre_debit',
        resource_type: 'invoice_subscription',
        resource_id: sub.id,
        metadata: { billing_date: tomorrow, notified: !!customer_email },
      });
      sent++;
    }
    return sent;
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'retry-failed-subscription-charges' })
  async retryFailedSubscriptionCharges(): Promise<void> {
    const n = await this.runDunningSweep();
    if (n > 0) this.logger.log(`dunning: ${n} subscription(s) processed`);
  }

  /**
   * Dunning sweep (§6.8, reworked for real auto-debit in Sprint 23): the
   * failure COUNTER is owned by the subscription webhooks now (each real
   * failed charge writes a subscription_charge_attempts row and increments
   * failed_charge_count; 3 strikes → PAUSED happens there, immediately).
   * This sweep is the SAFETY NET for profiles stranded PAST_DUE with a dead
   * mandate — no webhook activity for 7+ days → pause + audit, so the seller
   * sees a decisive state instead of an eternal PAST_DUE.
   */
  async runDunningSweep(): Promise<number> {
    const pastDue = await this.dbAdmin
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.status, 'PAST_DUE'));

    let processed = 0;
    for (const sub of pastDue) {
      const lastSignal = sub.last_failure_at ?? sub.updated_at;
      const stranded =
        !lastSignal ||
        Date.now() - new Date(lastSignal).getTime() > 7 * 24 * 60 * 60 * 1000;
      if (!stranded) continue;
      await this.dbAdmin
        .update(invoiceSubscriptions)
        .set({ status: 'PAUSED', paused_at: new Date(), updated_at: new Date() })
        .where(eq(invoiceSubscriptions.id, sub.id));
      await this.dbAdmin.insert(auditLog).values({
        tenant_id: sub.tenant_id,
        action: 'invoicing.subscription.dunning_paused',
        resource_type: 'invoice_subscription',
        resource_id: sub.id,
        metadata: { reason: 'past_due_stranded_7d', failures: sub.failed_charge_count ?? 0 },
      });
      processed++;
    }
    return processed;
  }

  @Cron('0 6 * * *', { name: 'refresh-fx-rates', timeZone: 'Asia/Kolkata' })
  async refreshFxRates(): Promise<void> {
    // Sprint 7: pull daily from openexchangerates (stub source).
    this.logger.debug('refresh-fx-rates (stub)');
  }

  @Cron('0 9 1 * *', { name: 'notify-gstr1-export-ready', timeZone: 'Asia/Kolkata' })
  async notifyGstr1ExportReady(): Promise<void> {
    // Sprint 6: 1st of month — nudge GSTR-1 export.
    this.logger.debug('notify-gstr1-export-ready (stub)');
  }

  @Cron('0 9 1 1,4,7,10 *', { name: 'quarterly-form-131-reminder', timeZone: 'Asia/Kolkata' })
  async quarterlyForm131Reminder(): Promise<void> {
    // Sprint 6: quarterly Form 131 follow-up.
    this.logger.debug('quarterly-form-131-reminder (stub)');
  }
}
