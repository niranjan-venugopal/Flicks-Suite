import { Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TimesheetRejectedEmailProps {
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  totalHours: number;
  approverName: string;
  comment?: string;
}

export const subject = (props: TimesheetRejectedEmailProps) =>
  `Your timesheet for ${props.periodStart} – ${props.periodEnd} has been rejected`;

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

export function TimesheetRejectedEmail({
  employeeName,
  periodStart,
  periodEnd,
  totalHours,
  approverName,
  comment,
}: TimesheetRejectedEmailProps) {
  return (
    <EmailLayout
      previewText={`Your timesheet for ${formatDate(periodStart)} – ${formatDate(periodEnd)} has been rejected.`}
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
          Timesheet Rejected
        </Text>
      </div>

      <Heading style={styles.h1}>Your timesheet has been rejected</Heading>

      <Text style={styles.p}>
        Hi <strong>{employeeName}</strong>, your timesheet submission has been rejected by{' '}
        <strong>{approverName}</strong>. Please review the feedback below and resubmit.
      </Text>

      <div
        style={{
          backgroundColor: '#FEF2F2',
          border: '1px solid #FECACA',
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
              <td style={{ ...styles.tableValue, fontWeight: '700' }}>{totalHours} hrs</td>
            </tr>
            <tr>
              <td style={styles.tableLabel}>Reviewed by</td>
              <td style={styles.tableValue}>{approverName}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {comment && (
        <div
          style={{
            backgroundColor: '#F8FAFC',
            borderLeft: '3px solid #DC2626',
            borderRadius: '0 6px 6px 0',
            padding: '12px 16px',
            margin: '0 0 24px',
          }}
        >
          <Text style={{ ...styles.pMuted, margin: '0 0 4px', fontWeight: '600' }}>
            Reason from {approverName}
          </Text>
          <Text style={{ ...styles.p, margin: '0', fontStyle: 'italic' }}>
            &ldquo;{comment}&rdquo;
          </Text>
        </div>
      )}

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          Please log in to Flicks Suite to update your timesheet entries and resubmit for approval.
        </Text>
      </div>
    </EmailLayout>
  );
}

TimesheetRejectedEmail.subject = subject;

export default TimesheetRejectedEmail;

TimesheetRejectedEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  periodStart: '2026-04-28',
  periodEnd: '2026-05-04',
  totalHours: 42.5,
  approverName: 'Rajan Mehta',
  comment: 'The hours logged for Monday seem inconsistent with the project status. Please review.',
} satisfies TimesheetRejectedEmailProps;
