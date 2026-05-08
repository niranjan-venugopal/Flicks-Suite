import { render } from '@react-email/components';
import * as React from 'react';

// ─── Template Exports ─────────────────────────────────────────────────────────

export { LoginOtpEmail } from './templates/login-otp.js';
export type { LoginOtpEmailProps } from './templates/login-otp.js';

export { WelcomeTenantEmail } from './templates/welcome-tenant.js';
export type { WelcomeTenantEmailProps } from './templates/welcome-tenant.js';

export { WelcomeEmployeeEmail } from './templates/welcome-employee.js';
export type { WelcomeEmployeeEmailProps } from './templates/welcome-employee.js';

export { OnboardingSubmittedEmail } from './templates/onboarding-submitted.js';
export type { OnboardingSubmittedEmailProps } from './templates/onboarding-submitted.js';

export { OnboardingApprovedEmail } from './templates/onboarding-approved.js';
export type { OnboardingApprovedEmailProps } from './templates/onboarding-approved.js';

export { OnboardingRejectedEmail } from './templates/onboarding-rejected.js';
export type { OnboardingRejectedEmailProps } from './templates/onboarding-rejected.js';

export { LeaveRequestedEmail } from './templates/leave-requested.js';
export type { LeaveRequestedEmailProps } from './templates/leave-requested.js';

export { LeaveApprovedEmail } from './templates/leave-approved.js';
export type { LeaveApprovedEmailProps } from './templates/leave-approved.js';

export { LeaveRejectedEmail } from './templates/leave-rejected.js';
export type { LeaveRejectedEmailProps } from './templates/leave-rejected.js';

export { TimesheetSubmittedEmail } from './templates/timesheet-submitted.js';
export type { TimesheetSubmittedEmailProps } from './templates/timesheet-submitted.js';

export { TimesheetApprovedEmail } from './templates/timesheet-approved.js';
export type { TimesheetApprovedEmailProps } from './templates/timesheet-approved.js';

export { TimesheetRejectedEmail } from './templates/timesheet-rejected.js';
export type { TimesheetRejectedEmailProps } from './templates/timesheet-rejected.js';

export { TimesheetReworkEmail } from './templates/timesheet-rework.js';
export type { TimesheetReworkEmailProps } from './templates/timesheet-rework.js';

export {
  AttendanceRegularizationRequestedEmail,
} from './templates/attendance-regularization-requested.js';
export type { AttendanceRegularizationRequestedEmailProps } from './templates/attendance-regularization-requested.js';

export {
  AttendanceRegularizationApprovedEmail,
} from './templates/attendance-regularization-approved.js';
export type { AttendanceRegularizationApprovedEmailProps } from './templates/attendance-regularization-approved.js';

export {
  AttendanceRegularizationRejectedEmail,
} from './templates/attendance-regularization-rejected.js';
export type { AttendanceRegularizationRejectedEmailProps } from './templates/attendance-regularization-rejected.js';

export { DataExportReadyEmail } from './templates/data-export-ready.js';
export type { DataExportReadyEmailProps } from './templates/data-export-ready.js';

export { TrialEndingSoonEmail } from './templates/trial-ending-soon.js';
export type { TrialEndingSoonEmailProps } from './templates/trial-ending-soon.js';

// ─── Layout & Shared ─────────────────────────────────────────────────────────

export { EmailLayout, styles as emailStyles } from './components/EmailLayout.js';

// ─── renderEmail Helper ───────────────────────────────────────────────────────

/**
 * Renders a React Email component to HTML + plain-text strings and returns
 * the email subject line.
 *
 * Usage:
 * ```ts
 * const { html, text, subject } = await renderEmail(LoginOtpEmail, {
 *   email: 'user@example.com',
 *   otpCode: '123456',
 *   magicLinkUrl: 'https://...',
 * });
 * ```
 */
export async function renderEmail<TProps>(
  Template: React.ComponentType<TProps> & {
    subject?: (props: TProps) => string;
  },
  props: TProps,
): Promise<{ html: string; text: string; subject: string }> {
  const element = React.createElement(Template, props);

  const [html, text] = await Promise.all([
    render(element, { pretty: false }),
    render(element, { plainText: true }),
  ]);

  const subject =
    typeof Template.subject === 'function'
      ? Template.subject(props)
      : 'Flicks Suite Notification';

  return { html, text, subject };
}

/**
 * Synchronous version of renderEmail for use in non-async contexts.
 * Prefer `renderEmail` (async) for better performance.
 */
export function renderEmailSync<TProps>(
  Template: React.ComponentType<TProps> & {
    subject?: (props: TProps) => string;
  },
  props: TProps,
): { html: string; text: string; subject: string } {
  const element = React.createElement(Template, props);

  // @react-email/components render is synchronous in its base form
  const html = render(element, { pretty: false }) as unknown as string;
  const text = render(element, { plainText: true }) as unknown as string;

  const subject =
    typeof Template.subject === 'function'
      ? Template.subject(props)
      : 'Flicks Suite Notification';

  return { html, text, subject };
}
