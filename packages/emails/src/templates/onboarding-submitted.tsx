import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface OnboardingSubmittedEmailProps {
  adminName: string;
  employeeName: string;
  employeeEmail: string;
  reviewUrl: string;
}

export const subject = (props: OnboardingSubmittedEmailProps) =>
  `${props.employeeName} has completed self-onboarding — review required`;

// ─── Template ─────────────────────────────────────────────────────────────────

export function OnboardingSubmittedEmail({
  adminName,
  employeeName,
  employeeEmail,
  reviewUrl,
}: OnboardingSubmittedEmailProps) {
  return (
    <EmailLayout
      previewText={`${employeeName} has submitted their onboarding details and is waiting for your review.`}
    >
      <div style={styles.badge}>Action Required</div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Onboarding ready for review
      </Heading>

      <Text style={styles.p}>
        Hi {adminName}, <strong>{employeeName}</strong> has finished filling in their self-onboarding
        details and is waiting for your review and activation.
      </Text>

      {/* Employee Summary */}
      <div
        style={{
          backgroundColor: '#F8FAFC',
          border: '1px solid #E2E8F0',
          borderRadius: '8px',
          padding: '20px',
          margin: '20px 0',
        }}
      >
        <table style={styles.table}>
          <tbody>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Employee</td>
              <td style={styles.tableValue}>{employeeName}</td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Work Email</td>
              <td style={styles.tableValue}>{employeeEmail}</td>
            </tr>
            <tr>
              <td style={styles.tableLabel}>Status</td>
              <td style={{ ...styles.tableValue, color: '#D97706', fontWeight: '600' }}>
                Pending Review
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Text style={styles.p}>
        Click the button below to review their information, verify documents, and either activate
        their account or request corrections.
      </Text>

      <Button href={reviewUrl} style={styles.button}>
        Review &amp; Activate
      </Button>

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          The employee will receive an email notification once you approve or request changes.
          Their account will only be activated after your explicit approval.
        </Text>
      </div>
    </EmailLayout>
  );
}

OnboardingSubmittedEmail.subject = subject;

export default OnboardingSubmittedEmail;

OnboardingSubmittedEmail.PreviewProps = {
  adminName: 'Rajan Mehta',
  employeeName: 'Priya Sharma',
  employeeEmail: 'priya.sharma@acme.com',
  reviewUrl: 'https://app.flickssuite.com/hr/employees/preview/onboarding',
} satisfies OnboardingSubmittedEmailProps;
