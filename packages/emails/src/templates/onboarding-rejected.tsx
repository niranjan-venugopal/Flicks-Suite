import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface OnboardingRejectedEmailProps {
  employeeName: string;
  reason: string;
  fixUrl: string;
  sections: string[];
}

export const subject = (_props: OnboardingRejectedEmailProps) =>
  `Action required: Please update your onboarding details`;

// ─── Template ─────────────────────────────────────────────────────────────────

export function OnboardingRejectedEmail({
  employeeName,
  reason,
  fixUrl,
  sections,
}: OnboardingRejectedEmailProps) {
  return (
    <EmailLayout
      previewText={`Your onboarding submission needs a few corrections before it can be approved.`}
    >
      <div
        style={{
          backgroundColor: '#FEF2F2',
          border: '1px solid #FECACA',
          borderRadius: '8px',
          padding: '4px 12px',
          display: 'inline-block',
          marginBottom: '16px',
        }}
      >
        <Text
          style={{
            color: '#DC2626',
            fontSize: '12px',
            fontWeight: '700',
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
            margin: '0',
          }}
        >
          Action Required
        </Text>
      </div>

      <Heading style={styles.h1}>
        Hi {employeeName}, your onboarding needs a few corrections
      </Heading>

      <Text style={styles.p}>
        Your HR team has reviewed your onboarding submission and found some information that needs
        to be updated before your account can be activated.
      </Text>

      {/* Reviewer Message */}
      <div
        style={{
          backgroundColor: '#FFF7ED',
          border: '1px solid #FED7AA',
          borderRadius: '8px',
          padding: '16px 20px',
          margin: '20px 0',
        }}
      >
        <Text style={{ ...styles.pMuted, margin: '0 0 4px', fontWeight: '600', color: '#9A3412' }}>
          Note from HR
        </Text>
        <Text style={{ ...styles.p, margin: '0', color: '#7C2D12' }}>
          &ldquo;{reason}&rdquo;
        </Text>
      </div>

      {/* Sections to fix */}
      {sections.length > 0 && (
        <>
          <Heading as="h2" style={styles.h2}>Sections that need attention</Heading>
          {sections.map((section, idx) => (
            <div
              key={idx}
              style={{
                borderLeft: '3px solid #DC2626',
                marginBottom: '10px',
                paddingLeft: '14px',
              }}
            >
              <Text style={{ ...styles.p, margin: '0', color: '#DC2626', fontWeight: '600' }}>
                {section}
              </Text>
            </div>
          ))}
          <Hr style={styles.divider} />
        </>
      )}

      <Text style={styles.p}>
        Please click the button below to revisit your onboarding form and make the necessary
        corrections.
      </Text>

      <Button href={fixUrl} style={styles.button}>
        Fix &amp; Resubmit
      </Button>

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          If you&apos;re unsure what changes are needed, please contact your HR admin or manager
          for guidance. Your account will be activated once your updated submission is approved.
        </Text>
      </div>
    </EmailLayout>
  );
}

OnboardingRejectedEmail.subject = subject;

export default OnboardingRejectedEmail;

OnboardingRejectedEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  reason: 'The bank account number appears to be incorrect and the PAN card document is unclear. Please re-upload a clearer image.',
  fixUrl: 'https://app.flickssuite.com/onboarding?token=preview&fix=true',
  sections: ['Banking Details', 'Identity Documents'],
} satisfies OnboardingRejectedEmailProps;
