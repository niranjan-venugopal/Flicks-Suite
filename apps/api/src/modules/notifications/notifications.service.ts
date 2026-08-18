import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { notifications, notificationPreferences, users } from '@flicks/db/schema';
import type { Notification } from '@flicks/db/schema';
import { DB_TENANT, DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { EventEmitter2 } from '@nestjs/event-emitter';

// ─── Notification preference taxonomy (PRD §9.3) ───────────────────────────────
// User-configurable events. WhatsApp/SMS channels are Phase 2 — only in_app +
// email are exposed. Absence of a stored row = the default below.
export const NOTIFICATION_EVENTS = [
  'leave_requested',
  'leave_reviewed',
  'timesheet_submitted',
  'timesheet_reviewed',
  'regularization_requested',
  'regularization_reviewed',
  'onboarding_submitted',
  'onboarding_reviewed',
  // CRM (PRD v5 §6.3) — assignment pings + the morning digest.
  'crm_activity',
  'crm_digest',
  // PM Inbox (PRD v6 §11) — the P10 matrix rows.
  'pm_assigned',
  'pm_mention',
  'pm_comment',
  'pm_status',
  'pm_cycle_digest',
  'pm_project_nudge',
  'pm_github',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export type NotificationChannel = 'in_app' | 'email';

// PRD §9.3 defaults — mostly on; a couple of employee-facing emails default off.
const PREFERENCE_DEFAULTS: Record<
  NotificationEvent,
  { in_app: boolean; email: boolean }
> = {
  leave_requested: { in_app: true, email: true },
  leave_reviewed: { in_app: true, email: true },
  timesheet_submitted: { in_app: true, email: true },
  timesheet_reviewed: { in_app: true, email: false },
  regularization_requested: { in_app: true, email: true },
  regularization_reviewed: { in_app: true, email: true },
  onboarding_submitted: { in_app: true, email: true },
  onboarding_reviewed: { in_app: true, email: true },
  // CRM (§6.3/§6.4): pings default on in-app; email flavours join Sprint 29.
  crm_activity: { in_app: true, email: false },
  crm_digest: { in_app: true, email: false },
  // PM (§11.2 defaults): urgent things may email; ambient activity is in-app
  // only. Email cadence is further shaped by users.notification_email_digest.
  pm_assigned: { in_app: true, email: true },
  pm_mention: { in_app: true, email: true },
  pm_comment: { in_app: true, email: false },
  pm_status: { in_app: true, email: false },
  pm_cycle_digest: { in_app: true, email: true },
  pm_project_nudge: { in_app: true, email: false },
  pm_github: { in_app: true, email: false },
};

// Map the free-form in-app `type` string (e.g. 'timesheet.approve',
// 'leave.approved') to a preference event. Unmapped types are always
// delivered (critical/security — e.g. impersonation).
function eventForInAppType(type: string): NotificationEvent | null {
  if (type.startsWith('timesheet.')) return 'timesheet_reviewed';
  // The "*.requested" types go to the approver on submit; everything else on
  // the prefix is a review outcome to the requester. Kept specific-first so the
  // dedicated "requested" preferences actually gate the approver's bell.
  if (type === 'leave.requested') return 'leave_requested';
  if (type.startsWith('leave.')) return 'leave_reviewed';
  if (type === 'regularization.requested') return 'regularization_requested';
  if (type.startsWith('regularization.')) return 'regularization_reviewed';
  if (type.startsWith('onboarding.')) return 'onboarding_reviewed';
  if (type.startsWith('crm.digest')) return 'crm_digest';
  if (type.startsWith('crm.')) return 'crm_activity';
  // PM (PRD v6 §11) — specific-first, then a safe pm.* fallback so a new PM
  // type is at least gated by the ambient-comment preference, never ungated.
  if (type === 'pm.issue.assigned') return 'pm_assigned';
  if (type === 'pm.issue.mention') return 'pm_mention';
  if (type === 'pm.issue.status') return 'pm_status';
  if (type.startsWith('pm.cycle.')) return 'pm_cycle_digest';
  if (type === 'pm.project.stale') return 'pm_project_nudge';
  if (type.startsWith('pm.github.')) return 'pm_github';
  if (type.startsWith('pm.digest')) return 'pm_comment';
  if (type.startsWith('pm.')) return 'pm_comment';
  return null;
}

/** Preference event for the email flavour of an inbox row (sweep-time gate). */
export function emailEventForInAppType(type: string): NotificationEvent | null {
  return eventForInAppType(type);
}

// API shape returned to the client. Snake → camel.
export interface InAppNotification {
  id: string;
  userId: string;
  type: string;
  message: string;
  linkUrl: string | null;
  readAt: string | null;
  createdAt: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
  groupCount: number;
}

function toDto(row: Notification): InAppNotification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    message: row.message,
    linkUrl: row.link_url,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
    snoozedUntil: row.snoozed_until?.toISOString() ?? null,
    groupCount: row.group_count ?? 1,
  };
}

type EmailTemplate =
  // Auth
  | 'login-otp'
  | 'magic-link'
  // Tenant + employee lifecycle
  | 'welcome-tenant'
  | 'welcome-employee'
  | 'onboarding-submitted'
  | 'onboarding-approved'
  | 'onboarding-rejected'
  // Leave
  | 'leave-requested'
  | 'leave-approved'
  | 'leave-rejected'
  // Attendance regularization
  | 'attendance-regularization-requested'
  | 'attendance-regularization-approved'
  | 'attendance-regularization-rejected'
  // Timesheet
  | 'timesheet-submitted'
  | 'timesheet-approved'
  | 'timesheet-rejected'
  | 'timesheet-rework'
  // Invoicing (v3)
  | 'invoice-sent'
  | 'payment-received'
  | 'invoice-reminder'
  | 'subscription-pre-debit'
  | 'mandate-authorization-request'
  | 'charge-failed-retry'
  | 'mandate-revoked'
  | 'auditor-invite'
  // Billing
  | 'trial-ending-soon'
  | 'trial-ended'
  | 'subscription-activated'
  | 'subscription-payment-success'
  | 'subscription-payment-failed'
  | 'payment-failed-retry'
  | 'cancellation-confirmed'
  // DPDP self-service
  | 'data-export-ready'
  | 'account-deletion-confirmation'
  // Platform
  | 'impersonation-started'
  // PM Inbox (PRD v6 §11)
  | 'pm-inbox-urgent'
  | 'pm-inbox-digest';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly resend: Resend;

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.resend = new Resend(
      this.configService.get<string>('RESEND_API_KEY'),
    );
  }

  /**
   * Raw send for CALLER-COMPOSED email (CRM compose/sequences, PRD v5 §7) —
   * subject/html arrive ready-made instead of a platform template. Returns the
   * provider message id (used to correlate Resend webhooks) or null on
   * failure/no-op. Never throws.
   */
  async sendRawEmail(args: {
    to: string;
    subject: string;
    html: string;
    fromName?: string;
    replyTo?: string;
    bcc?: string;
    headers?: Record<string, string>;
  }): Promise<string | null> {
    const from = `${args.fromName ?? this.configService.get('EMAIL_FROM_NAME', 'Flicks Suite')} <${this.configService.get('EMAIL_FROM', 'noreply@flicks.app')}>`;
    try {
      const { data, error } = await this.resend.emails.send({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        ...(args.replyTo ? { replyTo: args.replyTo } : {}),
        ...(args.bcc ? { bcc: args.bcc } : {}),
        ...(args.headers ? { headers: args.headers } : {}),
      });
      if (error) {
        this.logger.error(`Raw email to ${args.to} failed: ${error.name ?? ''} ${error.message ?? ''}`);
        return null;
      }
      return data?.id ?? null;
    } catch (err) {
      this.logger.error(`Raw email to ${args.to} threw: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Returns whether the email was accepted by Resend (or deliberately
   * suppressed by preference — a user choice, not a failure). Never throws:
   * email failures must not break flows. Callers that must not lose a notice
   * (the billing crons' dedupe markers) check the boolean before marking a
   * notice as sent.
   */
  async sendEmail(
    template: EmailTemplate,
    to: string,
    props: Record<string, unknown>,
    opts?: {
      userId?: string;
      event?: NotificationEvent;
      // Extra SMTP headers — used for marketing sends' List-Unsubscribe
      // (§3.1). Build via ConsentService.marketingEmailHeaders(userId).
      headers?: Record<string, string>;
    },
  ): Promise<boolean> {
    // Honour the recipient's per-event email preference when this send is
    // tied to a preference-managed event AND we know the recipient's user id.
    // Transactional emails (OTP, magic link, welcome, account deletion) pass
    // no event and are always delivered.
    if (opts?.userId && opts.event) {
      const allowed = await this.isChannelEnabled(
        opts.userId,
        opts.event,
        'email',
      );
      if (!allowed) {
        this.logger.log(
          `Email [${template}] to ${to} suppressed by preference (${opts.event}/email)`,
        );
        return true;
      }
    }

    const from = `${this.configService.get('EMAIL_FROM_NAME', 'Flicks Suite')} <${this.configService.get('EMAIL_FROM', 'noreply@flicks.app')}>`;

    try {
      const { subject, html } = this.renderTemplate(template, props);

      // Resend v4 resolves { data, error } and never rejects on API errors —
      // ignoring `error` logged every outage as "Email sent".
      const { error } = await this.resend.emails.send({
        from,
        to,
        subject,
        html,
        ...(opts?.headers ? { headers: opts.headers } : {}),
      });
      if (error) {
        this.logger.error(
          `Failed to send email [${template}] to ${to}: ${error.name ?? ''} ${error.message ?? ''}`,
        );
        return false;
      }

      this.logger.log(`Email sent [${template}] to ${to}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send email [${template}] to ${to}:`, err);
      // Don't throw — email failures should not break the flow
      return false;
    }
  }

  /**
   * Escape user-controlled strings before HTML interpolation — a tenant can
   * rename their workspace to markup and have it rendered inside official
   * billing emails otherwise.
   */
  private esc(v: unknown): string {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private renderTemplate(
    template: EmailTemplate,
    props: Record<string, unknown>,
  ): { subject: string; html: string } {
    const appName = 'Flicks Suite';

    switch (template) {
      case 'invoice-sent': {
        const viewUrl = String(props.viewUrl ?? '#');
        return {
          subject: `Invoice ${props.invoiceNumber} from ${props.tenantName ?? appName}`,
          html: `
            <p>Hi ${props.customerName ?? 'there'},</p>
            <p>${props.tenantName ?? 'We'} sent you invoice <strong>${props.invoiceNumber}</strong>
            for <strong>${props.amount}</strong>, due <strong>${props.dueDate}</strong>.</p>
            <p style="margin:24px 0;">
              <a href="${viewUrl}" style="background:#3E7BFA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">View &amp; Pay</a>
            </p>
            <p>You can view the invoice and pay online any time from the link above.</p>
          `,
        };
      }

      case 'payment-received': {
        return {
          subject: `Payment received — ${props.invoiceNumber}`,
          html: `
            <p>Hi ${props.customerName ?? 'there'},</p>
            <p>We've recorded a payment of <strong>${props.amount}</strong> against
            invoice <strong>${props.invoiceNumber}</strong>. ${props.outstanding ? `Outstanding balance: <strong>${props.outstanding}</strong>.` : 'The invoice is now fully paid — thank you!'}</p>
          `,
        };
      }

      case 'invoice-reminder': {
        return {
          subject: `${props.overdue ? 'Overdue' : 'Reminder'}: invoice ${props.invoiceNumber}`,
          html: `
            <p>Hi ${props.customerName ?? 'there'},</p>
            <p>This is a ${props.overdue ? '<strong>payment overdue</strong>' : 'friendly'} reminder for
            invoice <strong>${props.invoiceNumber}</strong> — <strong>${props.amount}</strong>
            ${props.overdue ? 'was due' : 'is due'} on <strong>${props.dueDate}</strong>.</p>
          `,
        };
      }

      case 'subscription-pre-debit': {
        // D15 / Appendix E: amount, date, invoice reference, and a
        // "Manage or cancel this mandate" link are all required.
        const invoiceRef = props.invoiceRef as string | undefined;
        const manageUrl = props.manageUrl as string | undefined;
        return {
          subject: `Upcoming auto-debit: ${this.esc(props.amount)} on ${this.esc(props.chargeDate)} — ${this.esc(props.name)}`,
          html: `
            <p>Hi ${this.esc(props.customerName ?? 'there')},</p>
            <p>As per your authorized e-mandate, <strong>${this.esc(props.amount)}</strong> for
            <strong>${this.esc(props.name)}</strong> will be auto-debited on
            <strong>${this.esc(props.chargeDate)}</strong>. No action is needed.</p>
            ${invoiceRef ? `<p style="font-size: 14px;">Invoice reference: <strong>${this.esc(invoiceRef)}</strong></p>` : ''}
            ${
              manageUrl
                ? `<p style="margin: 20px 0;"><a href="${String(manageUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none;">Manage or cancel this mandate</a></p>`
                : ''
            }
            <p style="color: #6b7280; font-size: 13px;">This notice is sent at least 24 hours
            before every debit (RBI e-mandate guidelines). To stop future charges, revoke the
            mandate from your UPI/banking app${manageUrl ? ', use the link above,' : ''} or contact the sender.</p>
          `,
        };
      }

      case 'mandate-authorization-request': {
        const { customerName, subscriptionName, amount, cadence, authorizeUrl } = props as {
          customerName: string;
          subscriptionName: string;
          amount: string;
          cadence: string;
          authorizeUrl: string;
        };
        return {
          subject: `Set up auto-pay for ${this.esc(subscriptionName)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2>Authorize automatic payments</h2>
              <p>Hi ${this.esc(customerName)}, you've been set up for automatic payments on <strong>${this.esc(subscriptionName)}</strong> — <strong>${this.esc(amount)}</strong> ${this.esc(cadence)}.</p>
              <p>Authorize the e-mandate once and future cycles are collected automatically. You'll always receive a notice at least 24 hours before every charge, and you can revoke anytime from your bank/UPI app.</p>
              <a href="${String(authorizeUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Review &amp; authorize</a>
              <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">Powered by Razorpay e-mandates (UPI AutoPay / card).</p>
            </div>
          `,
        };
      }

      case 'charge-failed-retry': {
        const { customerName, subscriptionName, sellerName, exhausted } = props as {
          customerName: string;
          subscriptionName: string;
          sellerName: string;
          exhausted?: boolean;
        };
        return {
          subject: `Payment failed for ${this.esc(subscriptionName)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #ef4444;">We couldn't collect your payment</h2>
              <p>Hi ${this.esc(customerName)}, the automatic payment for <strong>${this.esc(subscriptionName)}</strong> (billed by ${this.esc(sellerName)}) didn't go through.</p>
              ${exhausted
                ? '<p><strong>After several attempts the subscription is now paused.</strong> Please contact the seller to settle the outstanding amount and resume.</p>'
                : '<p>Razorpay will retry automatically over the next few days — often a top-up or unblocking the mandate in your UPI app is all it takes.</p>'}
            </div>
          `,
        };
      }

      case 'mandate-revoked': {
        // D15 "mandate revoked / halted" — one template, two triggers.
        const { subscriptionName, customerName, reason } = props as {
          subscriptionName: string;
          customerName: string;
          reason?: 'revoked' | 'halted';
        };
        const halted = reason === 'halted';
        const lead = halted
          ? `The auto-debit mandate on <strong>${this.esc(subscriptionName)}</strong> was <strong>halted</strong> after repeated failed charges${customerName ? ` for <strong>${this.esc(customerName)}</strong>` : ''}.`
          : `<strong>${this.esc(customerName)}</strong> revoked the auto-debit mandate on <strong>${this.esc(subscriptionName)}</strong>.`;
        return {
          subject: halted
            ? `Mandate halted — ${this.esc(subscriptionName)}`
            : `Mandate revoked — ${this.esc(subscriptionName)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2>Auto-debit mandate ${halted ? 'halted' : 'revoked'}</h2>
              <p>${lead}</p>
              <p>The profile has switched back to <strong>manual collection</strong> — future cycles will generate invoices to send as usual, and you can re-request a mandate anytime from the Recurring page.</p>
            </div>
          `,
        };
      }

      case 'auditor-invite': {
        return {
          subject: `You're invited to review ${props.companyName} on ${appName}`,
          html: `
            <p>Hi,</p>
            <p><strong>${props.inviterName}</strong> invited you as an <strong>auditor</strong>
            for <strong>${props.companyName}</strong> on ${appName}.</p>
            <p>Granted access: <strong>${props.scopeSummary}</strong>${
              props.accessExpiresAt ? ` (until ${props.accessExpiresAt})` : ''
            }.</p>
            ${props.note ? `<p>Note from the inviter: ${props.note}</p>` : ''}
            <p style="margin:24px 0;">
              <a href="${props.magicLinkUrl}" style="background:#3E7BFA;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Accept invite &amp; sign in</a>
            </p>
            <p>Auditor seats are non-billable. If the button doesn't work, you can also just
            <strong>sign in at ${appName} with this email address</strong> — your access to
            <strong>${props.companyName}</strong> activates automatically, and the company
            appears under <strong>My companies</strong>.</p>
          `,
        };
      }

      case 'login-otp': {
        // magicLinkUrl is OMITTED for brand-new accounts (first signup must
        // accept the ToS in the wizard, which a bare link can't carry) — the
        // email then shows only the code.
        const { otpCode, magicLinkUrl, expiryMinutes } = props as {
          otpCode: string;
          magicLinkUrl?: string;
          expiryMinutes: number;
        };
        const magicLinkBlock = magicLinkUrl
          ? `
              <p>Or use the magic link:</p>
              <a href="${String(magicLinkUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Sign in with Magic Link</a>`
          : '';
        return {
          subject: `${otpCode} — Your ${appName} login code`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Login to ${appName}</h2>
              <p>Your one-time login code is:</p>
              <div style="background: #f4f4f8; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
                <span style="font-size: 40px; font-weight: bold; letter-spacing: 8px; color: #6366f1;">${otpCode}</span>
              </div>
              <p>This code expires in ${expiryMinutes} minutes.</p>${magicLinkBlock}
              <p style="color: #666; font-size: 12px; margin-top: 32px;">If you didn't request this, please ignore this email.</p>
            </div>
          `,
        };
      }

      case 'welcome-employee': {
        const { employeeName, companyName, magicLinkUrl } = props as {
          employeeName: string;
          companyName: string;
          magicLinkUrl: string;
        };
        return {
          subject: `Welcome to ${String(companyName)} — Accept your invite`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Welcome, ${String(employeeName)}!</h2>
              <p>You've been invited to join <strong>${String(companyName)}</strong> on ${appName}.</p>
              <p>Click the secure link below to accept your invite and finish setting up your profile. The link is valid for 7 days.</p>
              <p style="margin: 24px 0;">
                <a href="${String(magicLinkUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Accept invite & set up profile</a>
              </p>
              <p style="color: #666; font-size: 12px; margin-top: 32px;">If you didn't expect this invite, you can safely ignore this email. The link will expire on its own.</p>
            </div>
          `,
        };
      }

      case 'onboarding-approved': {
        const { employeeName, loginUrl } = props as {
          employeeName: string;
          loginUrl: string;
        };
        return {
          subject: `Your onboarding has been approved — ${appName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Onboarding Approved!</h2>
              <p>Hi ${String(employeeName)}, your onboarding has been reviewed and approved.</p>
              <p>You now have full access to ${appName}.</p>
              <a href="${String(loginUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Login to Dashboard</a>
            </div>
          `,
        };
      }

      case 'leave-requested': {
        const { employeeName, leaveType, startDate, endDate, days, reason } =
          props as {
            employeeName: string;
            leaveType: string;
            startDate: string;
            endDate: string;
            days: number;
            reason?: string;
          };
        return {
          subject: `Leave Request — ${String(employeeName)} (${String(leaveType)})`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Leave Request Received</h2>
              <p>${String(employeeName)} has submitted a leave request:</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 8px; color: #666;">Type:</td><td style="padding: 8px;">${String(leaveType)}</td></tr>
                <tr><td style="padding: 8px; color: #666;">From:</td><td style="padding: 8px;">${String(startDate)}</td></tr>
                <tr><td style="padding: 8px; color: #666;">To:</td><td style="padding: 8px;">${String(endDate)}</td></tr>
                <tr><td style="padding: 8px; color: #666;">Days:</td><td style="padding: 8px;">${String(days)}</td></tr>
                ${reason ? `<tr><td style="padding: 8px; color: #666;">Reason:</td><td style="padding: 8px;">${String(reason)}</td></tr>` : ''}
              </table>
            </div>
          `,
        };
      }

      case 'leave-approved': {
        const { employeeName, leaveType, startDate, endDate, approverName } =
          props as {
            employeeName: string;
            leaveType: string;
            startDate: string;
            endDate: string;
            approverName: string;
          };
        return {
          subject: `Leave Approved — ${String(leaveType)} (${String(startDate)} - ${String(endDate)})`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #22c55e;">Leave Approved</h2>
              <p>Hi ${String(employeeName)}, your leave request has been approved by ${String(approverName)}.</p>
              <p>Dates: ${String(startDate)} to ${String(endDate)} (${String(leaveType)})</p>
            </div>
          `,
        };
      }

      case 'leave-rejected': {
        const { employeeName, leaveType, startDate, endDate, comment } =
          props as {
            employeeName: string;
            leaveType: string;
            startDate: string;
            endDate: string;
            comment?: string;
          };
        return {
          subject: `Leave Rejected — ${String(leaveType)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #ef4444;">Leave Rejected</h2>
              <p>Hi ${String(employeeName)}, unfortunately your leave request has been rejected.</p>
              <p>Dates: ${String(startDate)} to ${String(endDate)} (${String(leaveType)})</p>
              ${comment ? `<p>Comment: ${String(comment)}</p>` : ''}
            </div>
          `,
        };
      }

      case 'trial-ending-soon': {
        const { tenantName, trialEndsAt, upgradeUrl } = props as {
          tenantName: string;
          trialEndsAt: string;
          upgradeUrl: string;
        };
        return {
          subject: `Your ${appName} trial ends on ${String(trialEndsAt)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #f59e0b;">Trial Ending Soon</h2>
              <p>Hi ${this.esc(tenantName)},</p>
              <p>Your ${appName} trial ends on <strong>${String(trialEndsAt)}</strong>.</p>
              <p>Upgrade now to continue without interruption:</p>
              <a href="${String(upgradeUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Upgrade Now</a>
            </div>
          `,
        };
      }

      case 'timesheet-submitted': {
        const { approverName, periodStart, periodEnd, totalHours } = props as {
          approverName: string;
          periodStart: string;
          periodEnd: string;
          totalHours: number;
        };
        return {
          subject: `Timesheet awaiting your review — ${String(periodStart)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Hi ${String(approverName)},</h2>
              <p>A new timesheet has been submitted for your review.</p>
              <p style="background: #f4f6fa; border-radius: 8px; padding: 14px;">
                <strong>Week:</strong> ${String(periodStart)} → ${String(periodEnd)}<br/>
                <strong>Total hours:</strong> ${String(totalHours)}h
              </p>
              <p style="margin: 24px 0;">
                <a href="${this.configService.get<string>('APP_URL', 'http://localhost:3000')}/team/timesheets" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review timesheet</a>
              </p>
              <p style="color: #666; font-size: 12px; margin-top: 32px;">If the link doesn't work, sign in to ${appName} and head to Team → Timesheets.</p>
            </div>
          `,
        };
      }

      case 'pm-inbox-urgent': {
        const { line, linkUrl } = props as { line: string; linkUrl: string };
        return {
          subject: `${this.esc(line)} — ${appName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">You're needed on an issue</h2>
              <p>${this.esc(line)}</p>
              <p style="margin: 24px 0;">
                <a href="${this.configService.get<string>('APP_URL', 'http://localhost:3000')}${this.esc(linkUrl)}" style="display: inline-block; background: #3E7BFA; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Open in ${appName}</a>
              </p>
              <p style="color: #666; font-size: 12px; margin-top: 32px;">Sent because this was still unread after 5 minutes. Reading it in-app first cancels the email. Tune this under Settings → Notifications.</p>
            </div>
          `,
        };
      }

      case 'pm-inbox-digest': {
        const { count, lines, inboxUrl, cadence } = props as {
          count: number;
          lines: string[];
          inboxUrl: string;
          cadence: string;
        };
        const items = (lines ?? [])
          .slice(0, 10)
          .map((l) => `<li style="margin: 6px 0;">${this.esc(l)}</li>`)
          .join('');
        return {
          subject: `${String(count)} update${Number(count) === 1 ? '' : 's'} in your Projects inbox — ${appName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Your ${this.esc(cadence)} Projects digest</h2>
              <p>${String(count)} unread update${Number(count) === 1 ? '' : 's'} since your last look:</p>
              <ul style="padding-left: 18px; color: #333;">${items}</ul>
              <p style="margin: 24px 0;">
                <a href="${this.configService.get<string>('APP_URL', 'http://localhost:3000')}${this.esc(inboxUrl)}" style="display: inline-block; background: #3E7BFA; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Open Inbox</a>
              </p>
              <p style="color: #666; font-size: 12px; margin-top: 32px;">Only unread items are folded in — reading in-app removes them. Change the cadence under Settings → Notifications.</p>
            </div>
          `,
        };
      }

      case 'impersonation-started': {
        const { targetName, reason, endsAt } = props as {
          targetName: string;
          reason: string;
          endsAt: string;
        };
        return {
          subject: `Specflicks staff signed in as you — ${appName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Hi ${String(targetName)},</h2>
              <p>For your transparency, a Specflicks staff member just signed in to ${appName} as you.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #f4f6fa; border-radius: 8px;">
                <tr><td style="padding: 12px 14px; color: #666; width: 130px;">Reason</td><td style="padding: 12px 14px;">${String(reason)}</td></tr>
                <tr><td style="padding: 12px 14px; color: #666;">Session ends</td><td style="padding: 12px 14px;">${String(endsAt)} (15 min hard cap)</td></tr>
              </table>
              <p>Every action this staff member performs is recorded in your workspace's audit log and on Specflicks's platform audit log. You can review it under Settings → Audit log.</p>
              <p style="color: #666; font-size: 12px; margin-top: 32px;">If you didn't request support and this looks wrong, reply to this email or contact your workspace admin immediately.</p>
            </div>
          `,
        };
      }

      case 'magic-link': {
        const { magicLinkUrl, expiryMinutes } = props as {
          magicLinkUrl: string;
          expiryMinutes?: number;
        };
        return {
          subject: `Your ${appName} sign-in link`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Sign in to ${appName}</h2>
              <p>Click the secure link below to sign in. It expires in ${String(props.expiryMinutes ?? expiryMinutes ?? 30)} minutes.</p>
              <p style="margin: 24px 0;">
                <a href="${String(magicLinkUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Sign in</a>
              </p>
              <p style="color: #666; font-size: 12px; margin-top: 32px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
          `,
        };
      }

      case 'welcome-tenant': {
        const { ownerName, tenantName, dashboardUrl } = props as {
          ownerName: string;
          tenantName: string;
          dashboardUrl: string;
        };
        return {
          subject: `Welcome to ${appName}, ${this.esc(tenantName)}!`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Welcome aboard, ${String(ownerName)} 👋</h2>
              <p>Your workspace <strong>${this.esc(tenantName)}</strong> is live on ${appName}.</p>
              <p>You're set up as the Owner. Next, invite your team and configure your locations, departments and leave policies.</p>
              <p style="margin: 24px 0;">
                <a href="${String(dashboardUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Open your dashboard</a>
              </p>
              <p style="color: #666; font-size: 12px; margin-top: 32px;">Need a hand? Reply to this email or visit Help inside the app.</p>
            </div>
          `,
        };
      }

      case 'onboarding-submitted': {
        const { approverName, employeeName, reviewUrl } = props as {
          approverName: string;
          employeeName: string;
          reviewUrl: string;
        };
        return {
          subject: `Onboarding submitted for review — ${String(employeeName)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Hi ${String(approverName)},</h2>
              <p><strong>${String(employeeName)}</strong> has completed their self-onboarding and submitted it for your approval.</p>
              <p style="margin: 24px 0;">
                <a href="${String(reviewUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review onboarding</a>
              </p>
            </div>
          `,
        };
      }

      case 'onboarding-rejected': {
        const { employeeName, reason, resubmitUrl } = props as {
          employeeName: string;
          reason?: string;
          resubmitUrl: string;
        };
        return {
          subject: `Action needed — your onboarding was sent back`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #f59e0b;">Almost there, ${String(employeeName)}</h2>
              <p>Your onboarding details were sent back for a few changes before they can be approved.</p>
              ${reason ? `<p style="background: #fff7ed; border-left: 3px solid #f59e0b; padding: 12px 14px;"><strong>What to fix:</strong> ${String(reason)}</p>` : ''}
              <p style="margin: 24px 0;">
                <a href="${String(resubmitUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Update & resubmit</a>
              </p>
            </div>
          `,
        };
      }

      case 'attendance-regularization-requested': {
        const { managerName, employeeName, attendanceDate, requestType, reason } =
          props as {
            managerName: string;
            employeeName: string;
            attendanceDate: string;
            requestType?: string;
            reason?: string;
          };
        return {
          subject: `Attendance regularization — ${String(employeeName)} (${String(attendanceDate)})`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Hi ${String(managerName)},</h2>
              <p><strong>${String(employeeName)}</strong> has requested an attendance regularization.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 8px; color: #666;">Date:</td><td style="padding: 8px;">${String(attendanceDate)}</td></tr>
                ${requestType ? `<tr><td style="padding: 8px; color: #666;">Type:</td><td style="padding: 8px;">${String(requestType)}</td></tr>` : ''}
                ${reason ? `<tr><td style="padding: 8px; color: #666;">Reason:</td><td style="padding: 8px;">${String(reason)}</td></tr>` : ''}
              </table>
              <a href="${this.configService.get<string>('APP_URL', 'http://localhost:3000')}/inbox" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Review request</a>
            </div>
          `,
        };
      }

      case 'attendance-regularization-approved':
      case 'attendance-regularization-rejected': {
        const approved = template === 'attendance-regularization-approved';
        const { employeeName, attendanceDate, comment } = props as {
          employeeName: string;
          attendanceDate: string;
          comment?: string;
        };
        return {
          subject: `Attendance regularization ${approved ? 'approved' : 'rejected'} — ${String(attendanceDate)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: ${approved ? '#22c55e' : '#ef4444'};">Regularization ${approved ? 'Approved' : 'Rejected'}</h2>
              <p>Hi ${String(employeeName)}, your attendance regularization for <strong>${String(attendanceDate)}</strong> has been ${approved ? 'approved' : 'rejected'}.</p>
              ${comment ? `<p>Comment: ${String(comment)}</p>` : ''}
            </div>
          `,
        };
      }

      case 'timesheet-approved':
      case 'timesheet-rejected':
      case 'timesheet-rework': {
        const { employeeName, periodStart, periodEnd, comment } = props as {
          employeeName: string;
          periodStart: string;
          periodEnd: string;
          comment?: string;
        };
        const variant = {
          'timesheet-approved': { word: 'Approved', color: '#22c55e' },
          'timesheet-rejected': { word: 'Rejected', color: '#ef4444' },
          'timesheet-rework': { word: 'Sent back for rework', color: '#f59e0b' },
        }[template];
        return {
          subject: `Timesheet ${variant.word.toLowerCase()} — week of ${String(periodStart)}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: ${variant.color};">Timesheet ${variant.word}</h2>
              <p>Hi ${String(employeeName)}, your timesheet for <strong>${String(periodStart)} → ${String(periodEnd)}</strong> was ${variant.word.toLowerCase()}.</p>
              ${comment ? `<p style="background: #f4f6fa; border-radius: 8px; padding: 12px 14px;"><strong>Note:</strong> ${String(comment)}</p>` : ''}
              ${template === 'timesheet-approved' ? '' : `<p style="margin: 20px 0;"><a href="${this.configService.get<string>('APP_URL', 'http://localhost:3000')}/timesheets" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Open timesheet</a></p>`}
            </div>
          `,
        };
      }

      case 'subscription-payment-success': {
        const { tenantName, amount, periodEnd, invoiceUrl } = props as {
          tenantName: string;
          amount: string;
          periodEnd?: string;
          invoiceUrl?: string;
        };
        return {
          subject: `Payment received — ${appName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #22c55e;">Payment successful</h2>
              <p>Thanks ${this.esc(tenantName)} — we've received your payment of <strong>${String(amount)}</strong>.</p>
              ${periodEnd ? `<p>Your subscription is active until ${String(periodEnd)}.</p>` : ''}
              ${invoiceUrl ? `<p><a href="${String(invoiceUrl)}" style="color:#6366f1;">Download invoice</a></p>` : ''}
            </div>
          `,
        };
      }

      case 'subscription-payment-failed': {
        const { tenantName, amount, retryUrl } = props as {
          tenantName: string;
          amount: string;
          retryUrl: string;
        };
        return {
          subject: `Action required: payment failed — ${appName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #ef4444;">Payment failed</h2>
              <p>Hi ${this.esc(tenantName)}, we couldn't process your payment of <strong>${String(amount)}</strong>.</p>
              <p>Please update your payment method to avoid any interruption.</p>
              <a href="${String(retryUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Update payment</a>
            </div>
          `,
        };
      }

      case 'trial-ended': {
        const { tenantName, upgradeUrl } = props as {
          tenantName: string;
          upgradeUrl: string;
        };
        return {
          subject: `Your ${appName} trial has ended`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2>Your trial has ended</h2>
              <p>Hi ${this.esc(tenantName)}, your 7-day free trial is over. Your workspace and all its data are safe — it's now read-only until you subscribe.</p>
              <p>Plans are <strong>&#8377;499 per seat per month</strong>; auditors are never billed.</p>
              <a href="${String(upgradeUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Subscribe now</a>
              <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">Have a founder or community coupon? Apply it on the same page for free months.</p>
            </div>
          `,
        };
      }

      case 'subscription-activated': {
        const { tenantName, seats, amount, nextChargeDate } = props as {
          tenantName: string;
          seats: number;
          amount: string;
          nextChargeDate?: string;
        };
        return {
          subject: `Subscription active — welcome aboard, ${this.esc(tenantName)}!`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #22c55e;">You're all set</h2>
              <p>Hi ${this.esc(tenantName)}, your ${appName} subscription is now active: <strong>${String(seats)} seat${Number(seats) === 1 ? '' : 's'} · ${String(amount)}/month</strong>.</p>
              ${nextChargeDate ? `<p>Your next charge is on <strong>${String(nextChargeDate)}</strong>. We'll email a notice at least 24 hours before every debit.</p>` : ''}
              <p style="color: #6b7280; font-size: 13px;">Manage seats, receipts, and cancellation anytime under Settings &rarr; Billing &amp; plan.</p>
            </div>
          `,
        };
      }

      case 'payment-failed-retry': {
        const { tenantName, amount, graceEndsAt, retryUrl } = props as {
          tenantName: string;
          amount: string;
          graceEndsAt?: string;
          retryUrl: string;
        };
        return {
          subject: `Payment failed — we'll retry (${appName})`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #ef4444;">We couldn't collect ${String(amount)}</h2>
              <p>Hi ${this.esc(tenantName)}, your latest ${appName} charge didn't go through. Razorpay will retry automatically over the next few days — often it just works on the second attempt.</p>
              ${graceEndsAt ? `<p>Your workspace stays fully usable until <strong>${String(graceEndsAt)}</strong>. If no retry succeeds by then it becomes read-only (nothing is deleted).</p>` : ''}
              <p>If your card or mandate needs updating, start from your billing page:</p>
              <a href="${String(retryUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Open Billing &amp; plan</a>
            </div>
          `,
        };
      }

      case 'cancellation-confirmed': {
        const { tenantName, accessUntil } = props as {
          tenantName: string;
          accessUntil?: string;
        };
        return {
          subject: `Subscription cancelled — ${appName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2>Your subscription is cancelled</h2>
              <p>Hi ${this.esc(tenantName)}, your ${appName} subscription has ended${accessUntil ? ` — access continues until <strong>${String(accessUntil)}</strong>` : ''}. No further charges will be made.</p>
              <p>Your data stays safe and read-only, and you can subscribe again anytime from Settings &rarr; Billing &amp; plan to pick up exactly where you left off.</p>
              <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">Changed your mind by accident? Just subscribe again — your workspace is untouched.</p>
            </div>
          `,
        };
      }

      case 'data-export-ready': {
        const { userName, downloadUrl, expiryHours } = props as {
          userName: string;
          downloadUrl: string;
          expiryHours?: number;
        };
        return {
          subject: `Your ${appName} data export is ready`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Your data export is ready</h2>
              <p>Hi ${String(userName)}, the personal-data export you requested is ready to download.</p>
              <p style="margin: 24px 0;">
                <a href="${String(downloadUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Download my data</a>
              </p>
              <p style="color: #666; font-size: 12px;">This link expires in ${String(props.expiryHours ?? expiryHours ?? 24)} hours for your security.</p>
            </div>
          `,
        };
      }

      case 'account-deletion-confirmation': {
        const { userName, scheduledFor, cancelUrl } = props as {
          userName: string;
          scheduledFor: string;
          cancelUrl: string;
        };
        return {
          subject: `We've received your account deletion request — ${appName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Deletion request received</h2>
              <p>Hi ${String(userName)}, we've scheduled your account for deletion on <strong>${String(scheduledFor)}</strong> after a 7-day cool-off period.</p>
              <p>Changed your mind? You can cancel any time before then:</p>
              <p style="margin: 24px 0;">
                <a href="${String(cancelUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Cancel deletion</a>
              </p>
              <p style="color: #666; font-size: 12px;">After the cool-off period your personal data will be erased as required under the DPDP Act 2023.</p>
            </div>
          `,
        };
      }

      default:
        return {
          subject: `Notification from ${appName}`,
          html: `<p>You have a new notification from ${appName}.</p>`,
        };
    }
  }

  // ─── Preferences (PRD §9.3) ──────────────────────────────────────────────

  /** True if the user has the given channel enabled for the event (default-on). */
  async isChannelEnabled(
    userId: string,
    event: NotificationEvent,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const [row] = await this.dbAdmin
      .select({ enabled: notificationPreferences.enabled })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.user_id, userId),
          eq(notificationPreferences.event_type, event),
          eq(notificationPreferences.channel, channel),
        ),
      )
      .limit(1);
    if (row) return row.enabled;
    return PREFERENCE_DEFAULTS[event]?.[channel] ?? true;
  }

  /** The full preference matrix for a user, merging stored rows over defaults. */
  async getPreferences(userId: string) {
    const [stored, emailDigest] = await Promise.all([
      this.dbAdmin
        .select({
          event: notificationPreferences.event_type,
          channel: notificationPreferences.channel,
          enabled: notificationPreferences.enabled,
        })
        .from(notificationPreferences)
        .where(eq(notificationPreferences.user_id, userId)),
      this.getEmailDigestFreq(userId),
    ]);

    const overrides = new Map(
      stored.map((s) => [`${s.event}:${s.channel}`, s.enabled]),
    );

    return {
      emailDigest,
      events: NOTIFICATION_EVENTS.map((event) => ({
        event,
        inApp:
          overrides.get(`${event}:in_app`) ?? PREFERENCE_DEFAULTS[event].in_app,
        email:
          overrides.get(`${event}:email`) ?? PREFERENCE_DEFAULTS[event].email,
      })),
    };
  }

  /** Upsert a single (event, channel) preference for the user. */
  async setPreference(
    userId: string,
    event: NotificationEvent,
    channel: NotificationChannel,
    enabled: boolean,
  ) {
    await this.dbAdmin
      .insert(notificationPreferences)
      .values({ user_id: userId, event_type: event, channel, enabled })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.user_id,
          notificationPreferences.event_type,
          notificationPreferences.channel,
        ],
        set: { enabled, updated_at: new Date() },
      });
    return { event, channel, enabled };
  }

  async createInAppNotification(
    userId: string,
    type: string,
    message: string,
    linkUrl?: string | null,
    tenantId?: string | null,
    opts?: { groupKey?: string },
  ): Promise<void> {
    // Respect the user's in-app preference for preference-managed events.
    // Unmapped types (security/critical, e.g. impersonation) always deliver.
    const event = eventForInAppType(type);
    if (event) {
      const allowed = await this.isChannelEnabled(userId, event, 'in_app');
      if (!allowed) {
        this.logger.log(
          `In-app [${type}] for ${userId} suppressed by preference (${event}/in_app)`,
        );
        return;
      }
    }

    // §11.3 collapse: repeats of the same subject (group_key) bump the ONE
    // live inbox row — newest message wins, count climbs, snooze clears —
    // instead of stacking. Archived/read rows are history; those get a fresh
    // row so "done" items don't silently reopen with an old timestamp.
    if (opts?.groupKey) {
      const bumped = await this.dbAdmin
        .update(notifications)
        .set({
          type,
          message,
          link_url: linkUrl ?? null,
          created_at: new Date(),
          snoozed_until: null,
          emailed_at: null,
          group_count: sql`${notifications.group_count} + 1`,
        })
        .where(
          and(
            eq(notifications.user_id, userId),
            eq(notifications.group_key, opts.groupKey),
            isNull(notifications.read_at),
            isNull(notifications.archived_at),
          ),
        )
        .returning({ id: notifications.id });
      if (bumped.length > 0) {
        this.eventEmitter.emit('notification.created', {
          userId,
          type,
          message,
          linkUrl,
          tenantId,
          createdAt: new Date(),
        });
        return;
      }
    }

    await this.dbAdmin.insert(notifications).values({
      user_id: userId,
      type,
      message,
      link_url: linkUrl ?? null,
      tenant_id: tenantId ?? null,
      group_key: opts?.groupKey ?? null,
    });

    // Emit event for the future WebSocket bridge; current bell uses polling.
    this.eventEmitter.emit('notification.created', {
      userId,
      type,
      message,
      linkUrl,
      tenantId,
      createdAt: new Date(),
    });

    this.logger.log(`In-app notification created for user ${userId}: ${type}`);
  }

  /**
   * Tenant scope for every user-facing read/write. These run on dbAdmin
   * (notifications are deny-all under RLS), so the tenant predicate is the
   * ONLY thing stopping a multi-tenant user — a consultant, or someone whose
   * membership was revoked — from seeing another workspace's issue titles in
   * their feed. Platform rows (tenant_id NULL) stay visible everywhere.
   */
  private tenantScope(tenantId: string | null | undefined) {
    // Omitted tenant = trusted internal caller (jobs, sweeps, tests) → no
    // narrowing. Every HTTP entry point passes the JWT tenant, which is where
    // the untrusted input actually arrives.
    return tenantId
      ? sql`(${notifications.tenant_id} = ${tenantId}::uuid OR ${notifications.tenant_id} IS NULL)`
      : undefined;
  }

  async getUnread(
    userId: string,
    limit = 10,
    tenantId?: string,
  ): Promise<{ items: InAppNotification[]; total: number }> {
    const safeLimit = Math.max(1, Math.min(limit, 50));
    // Archived rows are done; snoozed rows are hidden until due (0045).
    const unreadVisible = and(
      eq(notifications.user_id, userId),
      this.tenantScope(tenantId),
      isNull(notifications.read_at),
      isNull(notifications.archived_at),
      sql`(${notifications.snoozed_until} IS NULL OR ${notifications.snoozed_until} <= now())`,
    );
    const [rows, [{ n }]] = await Promise.all([
      this.dbAdmin
        .select()
        .from(notifications)
        .where(unreadVisible)
        .orderBy(desc(notifications.created_at))
        .limit(safeLimit),
      this.dbAdmin
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(notifications)
        .where(unreadVisible),
    ]);
    return { items: rows.map(toDto), total: Number(n ?? 0) };
  }

  /**
   * The PM Inbox view (P9): active rows (unarchived, snooze elapsed) plus the
   * snoozed-for-later section. `scope: 'pm'` narrows to pm.* types so the PM
   * shell's Inbox stays about issues while the bell stays app-wide.
   */
  async getInbox(
    userId: string,
    opts: { scope?: 'pm' | 'all'; limit?: number; tenantId?: string } = {},
  ): Promise<{ items: InAppNotification[]; snoozed: InAppNotification[] }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
    const scopeCond =
      opts.scope === 'pm' ? sql`${notifications.type} LIKE 'pm.%'` : sql`true`;
    const tenantCond = this.tenantScope(opts.tenantId);
    const [items, snoozed] = await Promise.all([
      this.dbAdmin
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.user_id, userId),
            tenantCond,
            isNull(notifications.archived_at),
            sql`(${notifications.snoozed_until} IS NULL OR ${notifications.snoozed_until} <= now())`,
            scopeCond,
          ),
        )
        .orderBy(desc(notifications.created_at))
        .limit(limit),
      this.dbAdmin
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.user_id, userId),
            tenantCond,
            isNull(notifications.archived_at),
            sql`${notifications.snoozed_until} > now()`,
            scopeCond,
          ),
        )
        .orderBy(desc(notifications.created_at))
        .limit(limit),
    ]);
    return { items: items.map(toDto), snoozed: snoozed.map(toDto) };
  }

  /** Archive = done. Archiving also marks read (it left the inbox on purpose). */
  async archive(notificationId: string, userId: string, tenantId?: string): Promise<void> {
    await this.dbAdmin
      .update(notifications)
      .set({ archived_at: new Date(), read_at: sql`COALESCE(${notifications.read_at}, now())` })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.user_id, userId),
          this.tenantScope(tenantId),
          isNull(notifications.archived_at),
        ),
      );
  }

  /** Snooze until a future instant; the row hides from inbox + bell until due. */
  async snooze(
    notificationId: string,
    userId: string,
    until: Date,
    tenantId?: string,
  ): Promise<void> {
    await this.dbAdmin
      .update(notifications)
      .set({ snoozed_until: until })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.user_id, userId),
          this.tenantScope(tenantId),
          isNull(notifications.archived_at),
        ),
      );
  }

  /** The user's email digest cadence (P10 segmented control). */
  async getEmailDigestFreq(userId: string): Promise<'urgent' | 'hourly' | 'daily'> {
    const [row] = await this.dbAdmin
      .select({ freq: users.notification_email_digest })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const f = row?.freq;
    return f === 'urgent' || f === 'hourly' ? f : 'daily';
  }

  async setEmailDigestFreq(
    userId: string,
    freq: 'urgent' | 'hourly' | 'daily',
  ): Promise<void> {
    await this.dbAdmin
      .update(users)
      .set({ notification_email_digest: freq })
      .where(eq(users.id, userId));
  }

  async listAll(
    userId: string,
    opts: { filter?: 'all' | 'unread'; page?: number; pageSize?: number; tenantId?: string } = {},
  ): Promise<{
    items: InAppNotification[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const filter = opts.filter ?? 'all';
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.max(1, Math.min(opts.pageSize ?? 20, 100));
    const offset = (page - 1) * pageSize;

    const where =
      filter === 'unread'
        ? and(
            eq(notifications.user_id, userId),
            this.tenantScope(opts.tenantId),
            isNull(notifications.read_at),
          )
        : and(eq(notifications.user_id, userId), this.tenantScope(opts.tenantId));

    const [rows, [{ n }]] = await Promise.all([
      this.dbAdmin
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.created_at))
        .limit(pageSize)
        .offset(offset),
      this.dbAdmin
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(notifications)
        .where(where),
    ]);

    return {
      items: rows.map(toDto),
      total: Number(n ?? 0),
      page,
      pageSize,
    };
  }

  async markRead(notificationId: string, userId: string, tenantId?: string): Promise<void> {
    await this.dbAdmin
      .update(notifications)
      .set({ read_at: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.user_id, userId),
          this.tenantScope(tenantId),
          isNull(notifications.read_at),
        ),
      );
  }

  async markAllRead(userId: string, tenantId?: string): Promise<void> {
    await this.dbAdmin
      .update(notifications)
      .set({ read_at: new Date() })
      .where(
        and(
          eq(notifications.user_id, userId),
          this.tenantScope(tenantId),
          isNull(notifications.read_at),
        ),
      );
  }
}
