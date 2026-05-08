import { Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AttendanceRegularizationApprovedEmailProps {
  employeeName: string;
  attendanceDate: string;
  requestType: string;
  approverName: string;
  comment?: string;
}

export const subject = (_props: AttendanceRegularizationApprovedEmailProps) =>
  `Your attendance regularization request has been approved`;

const formatDate = (dateStr: string) => {
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
};

const formatRequestType = (type: string) =>
  type.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// ─── Template ─────────────────────────────────────────────────────────────────

export function AttendanceRegularizationApprovedEmail({
  employeeName,
  attendanceDate,
  requestType,
  approverName,
  comment,
}: AttendanceRegularizationApprovedEmailProps) {
  return (
    <EmailLayout
      previewText={`Your attendance regularization for ${formatDate(attendanceDate)} has been approved.`}
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
          Regularization Approved ✓
        </Text>
      </div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Attendance regularization approved
      </Heading>

      <Text style={styles.p}>
        Hi <strong>{employeeName}</strong>, your attendance regularization request has been
        approved by <strong>{approverName}</strong>. Your attendance record has been updated.
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
              <td style={styles.tableLabel}>Date</td>
              <td style={{ ...styles.tableValue, color: '#15803D', fontWeight: '600' }}>
                {formatDate(attendanceDate)}
              </td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Request Type</td>
              <td style={styles.tableValue}>{formatRequestType(requestType)}</td>
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
          Your attendance summary for this month has been updated to reflect this change.
          You can view the updated records in the Flicks Suite app.
        </Text>
      </div>
    </EmailLayout>
  );
}

AttendanceRegularizationApprovedEmail.subject = subject;

export default AttendanceRegularizationApprovedEmail;

AttendanceRegularizationApprovedEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  attendanceDate: '2026-05-05',
  requestType: 'forgot_punch_out',
  approverName: 'Rajan Mehta',
  comment: 'Updated. Please remember to punch out before leaving.',
} satisfies AttendanceRegularizationApprovedEmailProps;
