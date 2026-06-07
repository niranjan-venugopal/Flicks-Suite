import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

  constructor(private readonly db: DatabaseService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'mark-overdue-invoices' })
  async markOverdueInvoices(): Promise<void> {
    // Sprint 3/6: SENT/VIEWED/PARTIALLY_PAID past due_date → OVERDUE.
    this.logger.debug('mark-overdue-invoices (stub)');
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'expire-quotes' })
  async expireQuotes(): Promise<void> {
    // Sprint 3: SENT_AS_QUOTE past valid_until → QUOTE_EXPIRED.
    this.logger.debug('expire-quotes (stub)');
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'send-reminders' })
  async sendReminders(): Promise<void> {
    // Sprint 6: due reminder_schedule offsets; idempotent via reminder_sent.
    this.logger.debug('send-reminders (stub)');
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
