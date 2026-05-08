import { Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TimesheetApprovedEmailProps {
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  totalHours: number;
  approverName: string;
  comment?: string;
}

export const subject = (props: TimesheetApprovedEmailProps) =>
  `Your timesheet for ${props.periodStart} – ${props.periodEnd} has been approved`;

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

export function TimesheetApprovedEmail({
  employeeName,
  periodStart,
  periodEnd,
  totalHours,
  approverName,
  comment,
}: TimesheetApprovedEmailProps) {
  return (
    <EmailLayout
      previewText={`Your timesheet for ${formatDate(periodStart)} – ${formatDate(periodEnd)} has been approved.`}
    >
      <div style={styles.successBox}>
        <Text
          style={{
            color: '#15803D',
            fontSize: '14px',
            fontWeight: '700',
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
            margin: '0',
          }}
        >
          Timesheet Approved ✓
        </Text>
      </div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Timesheet approved!
      </Heading>

      <Text style={styles.p}>
        Hi <strong>{employeeName}</strong>, your timesheet has been reviewed and approved by{' '}
        <strong>{approverName}</strong>.
      </Text>

      <div
        style={{
          backgroundColor: '#F0FDF4',
          border: '1px solid #BBF7D0',
          borderRadius: '8px',
          padding: '20px',
          margin: '20px 0',
        }}
      >
        <table style={{ ...styles.table, margin: '0' }}>
          <tbody>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Period</td>
              <td style={styles.tableValue}>
                {formatDate(periodStart)} – {formatDate(periodEnd)}
              </td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Total Hours</td>
              <td style={{ ...styles.tableValue, color: '#15803D', fontWeight: '700', fontSize: '18px' }}>
                {totalHours} hrs
              </td>
            </tr>
            <tr>
              <td style={styles.tableLabel}>Approved by</td>
              <td style={styles.tableValue}>{approverName}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {comment && (
        <div
          style={{
            backgroundColor: '#F8FAFC',
            borderLeft: '3px solid #16A34A',
            borderRadius: '0 6px 6px 0',
            padding: '12px 16px',
            margin: '0 0 24px',
          }}
        >
          <Text style={{ ...styles.pMuted, margin: '0 0 4px', fontWeight: '600' }}>
            Comment from {approverName}
          </Text>
          <Text style={{ ...styles.p, margin: '0', fontStyle: 'italic' }}>
            &ldquo;{comment}&rdquo;
          </Text>
        </div>
      )}

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          Your approved hours are locked and will be used for payroll processing this period.
        </Text>
      </div>
    </EmailLayout>
  );
}

TimesheetApprovedEmail.subject = subject;

export default TimesheetApprovedEmail;

TimesheetApprovedEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  periodStart: '2026-04-28',
  periodEnd: '2026-05-04',
  totalHours: 42.5,
  approverName: 'Rajan Mehta',
  comment: 'Good work this week!',
} satisfies TimesheetApprovedEmailProps;
