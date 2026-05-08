import { Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface LeaveRejectedEmailProps {
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  approverName: string;
  comment?: string;
}

export const subject = (props: LeaveRejectedEmailProps) =>
  `Your ${props.leaveType} leave request has been declined`;

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

export function LeaveRejectedEmail({
  employeeName,
  leaveType,
  startDate,
  endDate,
  totalDays,
  approverName,
  comment,
}: LeaveRejectedEmailProps) {
  return (
    <EmailLayout
      previewText={`Your ${leaveType} leave request from ${formatDate(startDate)} has been declined.`}
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
          Leave Declined
        </Text>
      </div>

      <Heading style={styles.h1}>Your leave request has been declined</Heading>

      <Text style={styles.p}>
        Hi <strong>{employeeName}</strong>, your leave request has been reviewed and declined
        by <strong>{approverName}</strong>. Your leave balance has not been deducted.
      </Text>

      {/* Leave Summary */}
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
              <td style={styles.tableLabel}>Leave Type</td>
              <td style={{ ...styles.tableValue, color: '#DC2626', fontWeight: '600' }}>{leaveType}</td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>From</td>
              <td style={styles.tableValue}>{formatDate(startDate)}</td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>To</td>
              <td style={styles.tableValue}>{formatDate(endDate)}</td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Total Days</td>
              <td style={{ ...styles.tableValue, fontWeight: '700' }}>
                {totalDays} day{totalDays !== 1 ? 's' : ''}
              </td>
            </tr>
            <tr>
              <td style={styles.tableLabel}>Reviewed by</td>
              <td style={styles.tableValue}>{approverName}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {comment && (
        <>
          <Heading as="h2" style={styles.h2}>Reason for declining</Heading>
          <div
            style={{
              backgroundColor: '#F8FAFC',
              borderLeft: '3px solid #DC2626',
              borderRadius: '0 6px 6px 0',
              padding: '12px 16px',
              margin: '0 0 24px',
            }}
          >
            <Text style={{ ...styles.p, margin: '0', fontStyle: 'italic' }}>
              &ldquo;{comment}&rdquo;
            </Text>
          </div>
        </>
      )}

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          If you believe this decision needs to be reconsidered, please speak to{' '}
          <strong>{approverName}</strong> or your HR admin directly. You can also apply for
          alternative dates from the Flicks Suite app.
        </Text>
      </div>
    </EmailLayout>
  );
}

LeaveRejectedEmail.subject = subject;

export default LeaveRejectedEmail;

LeaveRejectedEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  leaveType: 'Casual Leave',
  startDate: '2026-05-15',
  endDate: '2026-05-17',
  totalDays: 3,
  approverName: 'Rajan Mehta',
  comment: 'We have a critical release scheduled during this period. Please apply for different dates.',
} satisfies LeaveRejectedEmailProps;
