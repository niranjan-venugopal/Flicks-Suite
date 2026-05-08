import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { eq, and, isNull } from 'drizzle-orm';
import { DB_TENANT } from '../../core/database/database.module';
import type { Db } from '@flicks/db';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Inline notifications table type (until added to schema)
interface InAppNotification {
  id: string;
  userId: string;
  type: string;
  message: string;
  linkUrl?: string;
  readAt?: Date | null;
  createdAt: Date;
}

type EmailTemplate =
  | 'otp-login'
  | 'magic-link'
  | 'welcome-employee'
  | 'onboarding-approved'
  | 'leave-request'
  | 'leave-approved'
  | 'leave-rejected'
  | 'trial-ending-soon'
  | 'timesheet-submitted'
  | 'timesheet-approved';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly resend: Resend;

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
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
  ): Promise<void> {
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
      case 'otp-login': {
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
        const { employeeName, companyName, onboardingUrl } = props as {
          employeeName: string;
          companyName: string;
          onboardingUrl: string;
        };
        return {
          subject: `Welcome to ${String(companyName)} — Complete your onboarding`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #1a1a2e;">Welcome, ${String(employeeName)}!</h2>
              <p>You've been invited to join ${String(companyName)} on ${appName}.</p>
              <p>Please complete your onboarding to get started:</p>
              <a href="${String(onboardingUrl)}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Complete Onboarding</a>
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

      case 'leave-request': {
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

      default:
        return {
          subject: `Notification from ${appName}`,
          html: `<p>You have a new notification from ${appName}.</p>`,
        };
    }
  }

  async createInAppNotification(
    userId: string,
    type: string,
    message: string,
    linkUrl?: string,
  ): Promise<void> {
    // Emit event for real-time push via WebSocket
    this.eventEmitter.emit('notification.created', {
      userId,
      type,
      message,
      linkUrl,
      createdAt: new Date(),
    });

    this.logger.log(`In-app notification created for user ${userId}: ${type}`);
  }

  async getUnread(userId: string): Promise<InAppNotification[]> {
    // This would query a notifications table - returning empty for now
    // as the notifications table schema needs to be added to @flicks/db
    return [];
  }

  async markRead(notificationId: string, userId: string): Promise<void> {
    this.logger.log(`Marking notification ${notificationId} as read for user ${userId}`);
  }
}
