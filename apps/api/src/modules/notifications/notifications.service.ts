import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { notifications, notificationPreferences } from '@flicks/db/schema';
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
};

// Map the free-form in-app `type` string (e.g. 'timesheet.approve',
// 'leave.approved') to a preference event. Unmapped types are always
// delivered (critical/security — e.g. impersonation).
function eventForInAppType(type: string): NotificationEvent | null {
  if (type.startsWith('timesheet.')) return 'timesheet_reviewed';
  if (type.startsWith('leave.')) return 'leave_reviewed';
  if (type.startsWith('regularization.')) return 'regularization_reviewed';
  if (type.startsWith('onboarding.')) return 'onboarding_reviewed';
  return null;
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
  // Billing
  | 'trial-ending-soon'
  | 'subscription-payment-success'
  | 'subscription-payment-failed'
  // DPDP self-service
  | 'data-export-ready'
  | 'account-deletion-confirmation'
  // Platform
  | 'impersonation-started';

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

  async sendEmail(
    template: EmailTemplate,
    to: string,
    props: Record<string, unknown>,
    opts?: { userId?: string; event?: NotificationEvent },
  ): Promise<void> {
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
        return;
      }
    }

    const from = `${this.configService.get('EMAIL_FROM_NAME', 'Flicks Suite')} <${this.configService.get('EMAIL_FROM', 'noreply@flicks.app')}>`;

    try {
      const { subject, html } = this.renderTemplate(template, props);

      await this.resend.emails.send({
        from,
        to,
        subject,
        html,
      });

      this.logger.log(`Email sent [${template}] to ${to}`);
    } catch (err) {
      this.logger.error(`Failed to send email [${template}] to ${to}:`, err);
      // Don't throw — email failures should not break the flow
    }
  }

  private renderTemplate(
    template: EmailTemplate,
    props: Record<string, unknown>,
  ): { subject: string; html: string } {
    const appName = 'Flicks Suite';

    switch (template) {
      case 'login-otp': {
        const { otpCode, magicLinkUrl, expiryMinutes } = props as {
          otpCode: string;
          magicLinkUrl: string;
          expiryMinutes: number;
        };
        return {
          subject: `${otpCode} — Your ${appName} login code`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Login to ${appName}</h2>
              <p>Your one-time login code is:</p>
              <div style="background: #f4f4f8; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
                <span style="font-size: 40px; font-weight: bold; letter-spacing: 8px; color: #6366f1;">${otpCode}</span>
              </div>
              <p>This code expires in ${expiryMinutes} minutes.</p>
              <p>Or use the magic link:</p>
              <a href="${String(magicLinkUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Sign in with Magic Link</a>
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
              <p>Hi ${String(tenantName)},</p>
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
          subject: `Welcome to ${appName}, ${String(tenantName)}!`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Welcome aboard, ${String(ownerName)} 👋</h2>
              <p>Your workspace <strong>${String(tenantName)}</strong> is live on ${appName}.</p>
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
              <p>Thanks ${String(tenantName)} — we've received your payment of <strong>${String(amount)}</strong>.</p>
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
              <p>Hi ${String(tenantName)}, we couldn't process your payment of <strong>${String(amount)}</strong>.</p>
              <p>Please update your payment method to avoid any interruption.</p>
              <a href="${String(retryUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Update payment</a>
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
    const stored = await this.dbAdmin
      .select({
        event: notificationPreferences.event_type,
        channel: notificationPreferences.channel,
        enabled: notificationPreferences.enabled,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.user_id, userId));

    const overrides = new Map(
      stored.map((s) => [`${s.event}:${s.channel}`, s.enabled]),
    );

    return {
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

    await this.dbAdmin.insert(notifications).values({
      user_id: userId,
      type,
      message,
      link_url: linkUrl ?? null,
      tenant_id: tenantId ?? null,
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

  async getUnread(
    userId: string,
    limit = 10,
  ): Promise<{ items: InAppNotification[]; total: number }> {
    const safeLimit = Math.max(1, Math.min(limit, 50));
    const [rows, [{ n }]] = await Promise.all([
      this.dbAdmin
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.user_id, userId),
            isNull(notifications.read_at),
          ),
        )
        .orderBy(desc(notifications.created_at))
        .limit(safeLimit),
      this.dbAdmin
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.user_id, userId),
            isNull(notifications.read_at),
          ),
        ),
    ]);
    return { items: rows.map(toDto), total: Number(n ?? 0) };
  }

  async listAll(
    userId: string,
    opts: { filter?: 'all' | 'unread'; page?: number; pageSize?: number } = {},
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
        ? and(eq(notifications.user_id, userId), isNull(notifications.read_at))
        : eq(notifications.user_id, userId);

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

  async markRead(notificationId: string, userId: string): Promise<void> {
    await this.dbAdmin
      .update(notifications)
      .set({ read_at: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.user_id, userId),
          isNull(notifications.read_at),
        ),
      );
  }

  async markAllRead(userId: string): Promise<void> {
    await this.dbAdmin
      .update(notifications)
      .set({ read_at: new Date() })
      .where(
        and(
          eq(notifications.user_id, userId),
          isNull(notifications.read_at),
        ),
      );
  }
}
