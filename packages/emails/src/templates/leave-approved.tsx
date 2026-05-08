import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface LeaveApprovedEmailProps {
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  approverName: string;
  comment?: string;
}

export const subject = (props: LeaveApprovedEmailProps) =>
  `Your ${props.leaveType} leave request has been approved`;

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

export function LeaveApprovedEmail({
  employeeName,
  leaveType,
  startDate,
  endDate,
  totalDays,
  approverName,
  comment,
}: LeaveApprovedEmailProps) {
  return (
    <EmailLayout
      previewText={`Your ${leaveType} leave request has been approved by ${approverName}.`}
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
          Leave Approved ✓
        </Text>
      </div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Your leave request is approved!
      </Heading>

      <Text style={styles.p}>
        Hi <strong>{employeeName}</strong>, great news! Your leave request has been approved
        by <strong>{approverName}</strong>.
      </Text>

      {/* Leave Summary */}
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
              <td style={styles.tableLabel}>Leave Type</td>
              <td style={{ ...styles.tableValue, color: '#15803D', fontWeight: '600' }}>{leaveType}</td>
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
              <td style={{ ...styles.tableValue, fontWeight: '700', fontSize: '18px' }}>
                {totalDays} day{totalDays !== 1 ? 's' : ''}
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
        <>
          <Heading as="h2" style={styles.h2}>Comment from {approverName}</Heading>
          <div
            style={{
              backgroundColor: '#F8FAFC',
              borderLeft: '3px solid #16A34A',
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
          If your plans change, you can cancel this leave from the Flicks Suite app before the
          start date. Contact HR if you need to make changes after the leave has started.
        </Text>
      </div>
    </EmailLayout>
  );
}

LeaveApprovedEmail.subject = subject;

export default LeaveApprovedEmail;

LeaveApprovedEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  leaveType: 'Casual Leave',
  startDate: '2026-05-15',
  endDate: '2026-05-17',
  totalDays: 3,
  approverName: 'Rajan Mehta',
  comment: 'Enjoy the wedding! Have fun.',
} satisfies LeaveApprovedEmailProps;
