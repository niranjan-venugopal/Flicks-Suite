import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  invoices,
  customers,
  reminderSchedule,
  reminderSent,
} from '@flicks/db/schema';
import { NotificationsService } from '../modules/notifications/notifications.service';
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
    // Sprint 7: invoice_subscriptions due on next_billing_date.
    this.logger.debug('generate-subscription-invoices (stub)');
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'send-pre-debit-notifications' })
  async sendPreDebitNotifications(): Promise<void> {
    // Sprint 7: 24h before next charge.
    this.logger.debug('send-pre-debit-notifications (stub)');
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'retry-failed-subscription-charges' })
  async retryFailedSubscriptionCharges(): Promise<void> {
    // Sprint 7: dunning — 3 retries / 7 days → pause.
    this.logger.debug('retry-failed-subscription-charges (stub)');
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
