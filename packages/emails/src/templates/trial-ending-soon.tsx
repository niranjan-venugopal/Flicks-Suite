import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TrialEndingSoonEmailProps {
  adminName: string;
  workspaceName: string;
  trialEndDate: string;
  upgradeUrl: string;
  daysRemaining?: number;
}

export const subject = (props: TrialEndingSoonEmailProps) =>
  `Your Flicks Suite trial ends in ${props.daysRemaining ?? 3} day${(props.daysRemaining ?? 3) !== 1 ? 's' : ''} — upgrade now`;

const formatDate = (dateStr: string) => {
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
};

// ─── Template ─────────────────────────────────────────────────────────────────

export function TrialEndingSoonEmail({
  adminName,
  workspaceName,
  trialEndDate,
  upgradeUrl,
  daysRemaining = 3,
}: TrialEndingSoonEmailProps) {
  const isLastDay = daysRemaining <= 1;

  return (
    <EmailLayout
      previewText={`Your Flicks Suite trial for ${workspaceName} ends on ${formatDate(trialEndDate)}. Upgrade to keep full access.`}
    >
      {/* Urgency Banner */}
      <div
        style={{
          backgroundColor: isLastDay ? '#FEF2F2' : '#FFFBEB',
          border: `1px solid ${isLastDay ? '#FECACA' : '#FDE68A'}`,
          borderRadius: '8px',
          padding: '4px 12px',
          display: 'inline-block',
          marginBottom: '16px',
        }}
      >
        <Text
          style={{
            color: isLastDay ? '#DC2626' : '#92400E',
            fontSize: '12px',
            fontWeight: '700',
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
            margin: '0',
          }}
        >
          {isLastDay ? 'Trial Ends Today' : `Trial ends in ${daysRemaining} days`}
        </Text>
      </div>

      <Heading style={styles.h1}>
        Your trial is ending{isLastDay ? ' today' : ` in ${daysRemaining} days`}
      </Heading>

      <Text style={styles.p}>
        Hi <strong>{adminName}</strong>, your free trial for <strong>{workspaceName}</strong> on
        Flicks Suite ends on <strong>{formatDate(trialEndDate)}</strong>.
      </Text>

      <Text style={styles.p}>
        After the trial ends, your workspace will be locked and your team will lose access to{' '}
        <strong>attendance tracking, leave management, timesheets, and all HR data</strong>.
      </Text>

      <Button href={upgradeUrl} style={styles.button}>
        Upgrade Now — Keep Full Access
      </Button>

      <Hr style={styles.divider} />

      <Heading as="h2" style={styles.h2}>What you&apos;ll lose if you don&apos;t upgrade</Heading>

      {[
        { icon: '⏰', item: 'Attendance tracking & punch history' },
        { icon: '📅', item: 'Leave management & balance records' },
        { icon: '🗓️', item: 'Timesheet data & approvals' },
        { icon: '👥', item: 'Employee profiles & onboarding data' },
        { icon: '📊', item: 'Reports & analytics' },
        { icon: '💳', item: 'Payroll integration data' },
      ].map((item, idx) => (
        <Text key={idx} style={{ ...styles.p, margin: '0 0 8px' }}>
          {item.icon} {item.item}
        </Text>
      ))}

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0 0 8px', fontWeight: '600' }}>
          Your data is safe
        </Text>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          If your trial expires before you upgrade, your data is retained for 30 days. You can
          reactivate at any time during this grace period without losing any records.
        </Text>
      </div>

      <Hr style={styles.divider} />

      <Text style={styles.pMuted}>
        Questions about pricing? Reply to this email or reach us at{' '}
        <a href="mailto:sales@flickssuite.com" style={styles.footerLink as React.CSSProperties}>
          sales@flickssuite.com
        </a>
        . We&apos;re happy to help you find the right plan.
      </Text>
    </EmailLayout>
  );
}

TrialEndingSoonEmail.subject = subject;

export default TrialEndingSoonEmail;

TrialEndingSoonEmail.PreviewProps = {
  adminName: 'Rajan Mehta',
  workspaceName: 'Acme Technologies',
  trialEndDate: '2026-05-10',
  upgradeUrl: 'https://app.flickssuite.com/billing/upgrade',
  daysRemaining: 3,
} satisfies TrialEndingSoonEmailProps;
