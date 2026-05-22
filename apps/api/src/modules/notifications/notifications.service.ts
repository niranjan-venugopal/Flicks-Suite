import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { notifications } from '@flicks/db/schema';
import type { Notification } from '@flicks/db/schema';
import { DB_TENANT, DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import { EventEmitter2 } from '@nestjs/event-emitter';

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
  | 'otp-login'
  | 'magic-link'
  | 'welcome-employee'
  | 'onboarding-approved'
  | 'leave-request'
  | 'leave-approved'
  | 'leave-rejected'
  | 'timesheet-submitted'
  | 'trial-ending-soon'
  | 'timesheet-approved'
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
    linkUrl?: string | null,
    tenantId?: string | null,
  ): Promise<void> {
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
