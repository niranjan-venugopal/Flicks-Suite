import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface WelcomeEmployeeEmailProps {
  employeeName: string;
  companyName: string;
  managerName: string;
  joiningDate: string;
  onboardingUrl: string;
  expiryDays?: number;
}

export const subject = (props: WelcomeEmployeeEmailProps) =>
  `You've been invited to join ${props.companyName} on Flicks Suite`;

// ─── Template ─────────────────────────────────────────────────────────────────

export function WelcomeEmployeeEmail({
  employeeName,
  companyName,
  managerName,
  joiningDate,
  onboardingUrl,
  expiryDays = 14,
}: WelcomeEmployeeEmailProps) {
  const formattedDate = (() => {
    try {
      return new Date(joiningDate).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      return joiningDate;
    }
  })();

  return (
    <EmailLayout
      previewText={`${companyName} has invited you to complete your onboarding on Flicks Suite.`}
    >
      <div style={styles.badge}>{companyName}</div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Welcome to {companyName}, {employeeName}!
      </Heading>

      <Text style={styles.p}>
        Congratulations and welcome aboard! <strong>{managerName}</strong> has set up your profile
        on Flicks Suite, the HRMS platform used by {companyName}.
      </Text>

      <Text style={styles.p}>
        Please complete your self-onboarding so HR can activate your account before your joining
        date.
      </Text>

      {/* Joining Date Highlight */}
      <div
        style={{
          backgroundColor: '#EFF6FF',
          border: '1px solid #BFDBFE',
          borderRadius: '10px',
          padding: '20px',
          margin: '24px 0',
          textAlign: 'center' as const,
        }}
      >
        <Text style={{ ...styles.pMuted, margin: '0 0 4px', fontSize: '12px', letterSpacing: '0.06em', textTransform: 'uppercase' as const, fontWeight: '600' }}>
          Your Joining Date
        </Text>
        <Text
          style={{
            color: '#1D4ED8',
            fontSize: '28px',
            fontWeight: '700',
            letterSpacing: '-0.01em',
            margin: '0',
          }}
        >
          {formattedDate}
        </Text>
      </div>

      <Button href={onboardingUrl} style={styles.button}>
        Start Self-Onboarding
      </Button>

      <Hr style={styles.divider} />

      <Heading as="h2" style={styles.h2}>What you&apos;ll need to fill in</Heading>
      <Text style={{ ...styles.pMuted, margin: '0 0 12px' }}>
        The onboarding form has 4 quick sections:
      </Text>

      {[
        'Personal information (name, date of birth, gender)',
        'Current & permanent address',
        'Emergency contact details',
        'Identity documents (PAN) and bank account for payroll',
      ].map((item, idx) => (
        <Text key={idx} style={{ ...styles.p, margin: '0 0 8px' }}>
          <span style={{ color: '#2563EB', fontWeight: '700', marginRight: '8px' }}>
            {idx + 1}.
          </span>
          {item}
        </Text>
      ))}

      <Hr style={styles.divider} />

      <div style={styles.warningBox}>
        <Text style={{ ...styles.pMuted, margin: '0 0 4px', fontWeight: '600' }}>
          Link expires in {expiryDays} days
        </Text>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          This onboarding link is unique to you and expires in <strong>{expiryDays} days</strong>.
          Please complete your onboarding before it expires. If your link has expired, contact{' '}
          <strong>{managerName}</strong> or your HR team to get a new one.
        </Text>
      </div>
    </EmailLayout>
  );
}

WelcomeEmployeeEmail.subject = subject;

export default WelcomeEmployeeEmail;

WelcomeEmployeeEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  companyName: 'Acme Technologies',
  managerName: 'Rajan Mehta',
  joiningDate: '2026-06-01',
  onboardingUrl: 'https://app.flickssuite.com/onboarding?token=preview',
  expiryDays: 14,
} satisfies WelcomeEmployeeEmailProps;
