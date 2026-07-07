import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface WelcomeTenantEmailProps {
  adminName: string;
  workspaceName: string;
  dashboardUrl: string;
}

export const subject = (props: WelcomeTenantEmailProps) =>
  `Welcome to Flicks Suite, ${props.workspaceName}!`;

// ─── Checklist items ──────────────────────────────────────────────────────────

const checklistItems = [
  { icon: '🏢', step: 'Complete company profile', desc: 'Add your logo, legal name, GSTIN, and registered address.' },
  { icon: '👥', step: 'Invite your team', desc: 'Add employees via bulk import or individual invitations.' },
  { icon: '📅', step: 'Configure leave policies', desc: 'Set up leave types, accrual rules, and holiday calendar.' },
  { icon: '⏰', step: 'Set up attendance rules', desc: 'Define work hours, geofencing zones, and overtime policies.' },
  { icon: '🗓️', step: 'Enable timesheets', desc: 'Configure billing categories and approval workflows.' },
  { icon: '💳', step: 'Choose a plan', desc: 'Upgrade before your trial ends to keep your data and access.' },
];

// ─── Template ─────────────────────────────────────────────────────────────────

export function WelcomeTenantEmail({
  adminName,
  workspaceName,
  dashboardUrl,
}: WelcomeTenantEmailProps) {
  return (
    <EmailLayout previewText={`Welcome to Flicks Suite, ${adminName}! Your workspace is ready.`}>
      <div style={styles.badge}>Welcome</div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Welcome to Flicks Suite, {adminName}!
      </Heading>

      <Text style={styles.p}>
        Your workspace <strong>{workspaceName}</strong> is ready. You&apos;re now on a{' '}
        <strong>7-day free trial</strong> with full access to all features — no credit card
        required.
      </Text>

      <Button href={dashboardUrl} style={styles.button}>
        Go to Dashboard
      </Button>

      <Hr style={styles.divider} />

      <Heading as="h2" style={styles.h2}>
        Your onboarding checklist
      </Heading>
      <Text style={{ ...styles.pMuted, marginBottom: '20px' }}>
        Complete these steps to get the most out of Flicks Suite:
      </Text>

      {checklistItems.map((item, idx) => (
        <div
          key={idx}
          style={{
            borderLeft: '3px solid #E2E8F0',
            marginBottom: '16px',
            paddingLeft: '16px',
          }}
        >
          <Text style={{ ...styles.p, margin: '0 0 4px', fontWeight: '600' }}>
            {item.icon} {item.step}
          </Text>
          <Text style={{ ...styles.pMuted, margin: '0' }}>{item.desc}</Text>
        </div>
      ))}

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          Need help? Our team is available at{' '}
          <a href="mailto:support@flickssuite.com" style={styles.footerLink as React.CSSProperties}>
            support@flickssuite.com
          </a>{' '}
          or via the in-app chat. We typically respond within a few hours.
        </Text>
      </div>
    </EmailLayout>
  );
}

WelcomeTenantEmail.subject = subject;

export default WelcomeTenantEmail;

WelcomeTenantEmail.PreviewProps = {
  adminName: 'Rajan Mehta',
  workspaceName: 'Acme Technologies',
  dashboardUrl: 'https://app.flickssuite.com/dashboard',
} satisfies WelcomeTenantEmailProps;
