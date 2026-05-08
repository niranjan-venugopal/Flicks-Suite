import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface OnboardingApprovedEmailProps {
  employeeName: string;
  companyName: string;
  dashboardUrl: string;
}

export const subject = (props: OnboardingApprovedEmailProps) =>
  `You're all set, ${props.employeeName}! Welcome to ${props.companyName}`;

// ─── Template ─────────────────────────────────────────────────────────────────

export function OnboardingApprovedEmail({
  employeeName,
  companyName,
  dashboardUrl,
}: OnboardingApprovedEmailProps) {
  return (
    <EmailLayout
      previewText={`Great news! Your onboarding has been approved and your account is now active.`}
    >
      {/* Celebration Banner */}
      <div
        style={{
          textAlign: 'center' as const,
          padding: '8px 0 24px',
        }}
      >
        <Text style={{ fontSize: '48px', margin: '0', lineHeight: '1' }}>🎉</Text>
      </div>

      <Heading style={{ ...styles.h1, textAlign: 'center' as const }}>
        You&apos;re all set!
      </Heading>

      <Text style={{ ...styles.p, textAlign: 'center' as const }}>
        Hi <strong>{employeeName}</strong>, your onboarding details have been reviewed and
        approved by the HR team at <strong>{companyName}</strong>. Your account is now fully active!
      </Text>

      <div style={{ textAlign: 'center' as const, margin: '32px 0' }}>
        <Button href={dashboardUrl} style={styles.button}>
          Go to Dashboard
        </Button>
      </div>

      <Hr style={styles.divider} />

      <Heading as="h2" style={styles.h2}>What you can do now</Heading>

      {[
        { icon: '📅', title: 'Check your leave balance', desc: 'View your available leave days and apply for time off.' },
        { icon: '⏰', title: 'Mark your attendance', desc: 'Punch in from the web or mobile app to track your work hours.' },
        { icon: '🗓️', title: 'Log timesheets', desc: 'Track billable and non-billable hours for your projects.' },
        { icon: '👤', title: 'Complete your profile', desc: 'Add a profile picture and update any optional details.' },
      ].map((item, idx) => (
        <div
          key={idx}
          style={{
            display: 'flex',
            marginBottom: '16px',
            paddingLeft: '0',
          }}
        >
          <Text style={{ ...styles.p, margin: '0 0 4px' }}>
            <span style={{ fontSize: '20px', marginRight: '10px' }}>{item.icon}</span>
            <strong>{item.title}</strong>
            {' — '}{item.desc}
          </Text>
        </div>
      ))}

      <Hr style={styles.divider} />

      <div style={styles.successBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          If you have any questions about your profile, policies, or payroll, reach out to your
          HR admin or manager directly through the platform.
        </Text>
      </div>
    </EmailLayout>
  );
}

OnboardingApprovedEmail.subject = subject;

export default OnboardingApprovedEmail;

OnboardingApprovedEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  companyName: 'Acme Technologies',
  dashboardUrl: 'https://app.flickssuite.com/dashboard',
} satisfies OnboardingApprovedEmailProps;
