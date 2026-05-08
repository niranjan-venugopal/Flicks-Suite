import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TimesheetSubmittedEmailProps {
  managerName: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  totalHours: number;
  reviewUrl: string;
}

export const subject = (props: TimesheetSubmittedEmailProps) =>
  `Timesheet submitted by ${props.employeeName} — review required`;

const formatDate = (dateStr: string) => {
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
};

// ─── Template ─────────────────────────────────────────────────────────────────

export function TimesheetSubmittedEmail({
  managerName,
  employeeName,
  periodStart,
  periodEnd,
  totalHours,
  reviewUrl,
}: TimesheetSubmittedEmailProps) {
  return (
    <EmailLayout
      previewText={`${employeeName} has submitted their timesheet for ${formatDate(periodStart)} – ${formatDate(periodEnd)}.`}
    >
      <div style={styles.badge}>Timesheet Review</div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Timesheet submitted for review
      </Heading>

      <Text style={styles.p}>
        Hi {managerName}, <strong>{employeeName}</strong> has submitted their timesheet and it&apos;s
        waiting for your review.
      </Text>

      {/* Summary */}
      <div
        style={{
          backgroundColor: '#F8FAFC',
          border: '1px solid #E2E8F0',
          borderRadius: '8px',
          padding: '20px',
          margin: '20px 0',
        }}
      >
        <table style={{ ...styles.table, margin: '0' }}>
          <tbody>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Employee</td>
              <td style={styles.tableValue}>{employeeName}</td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Period</td>
              <td style={styles.tableValue}>
                {formatDate(periodStart)} – {formatDate(periodEnd)}
              </td>
            </tr>
            <tr>
              <td style={styles.tableLabel}>Total Hours</td>
              <td
                style={{
                  ...styles.tableValue,
                  color: '#2563EB',
                  fontSize: '20px',
                  fontWeight: '700',
                }}
              >
                {totalHours} hrs
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Button href={reviewUrl} style={styles.button}>
        Review Timesheet
      </Button>

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          You can approve, reject, or request rework from the review page. The employee will be
          notified once you take action.
        </Text>
      </div>
    </EmailLayout>
  );
}

TimesheetSubmittedEmail.subject = subject;

export default TimesheetSubmittedEmail;

TimesheetSubmittedEmail.PreviewProps = {
  managerName: 'Rajan Mehta',
  employeeName: 'Priya Sharma',
  periodStart: '2026-04-28',
  periodEnd: '2026-05-04',
  totalHours: 42.5,
  reviewUrl: 'https://app.flickssuite.com/timesheets/preview/review',
} satisfies TimesheetSubmittedEmailProps;
