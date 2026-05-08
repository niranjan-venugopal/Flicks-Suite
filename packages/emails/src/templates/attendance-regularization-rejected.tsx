import { Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AttendanceRegularizationRejectedEmailProps {
  employeeName: string;
  attendanceDate: string;
  requestType: string;
  approverName: string;
  comment?: string;
}

export const subject = (_props: AttendanceRegularizationRejectedEmailProps) =>
  `Your attendance regularization request has been declined`;

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

export function AttendanceRegularizationRejectedEmail({
  employeeName,
  attendanceDate,
  requestType,
  approverName,
  comment,
}: AttendanceRegularizationRejectedEmailProps) {
  return (
    <EmailLayout
      previewText={`Your attendance regularization for ${formatDate(attendanceDate)} has been declined.`}
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
          Regularization Declined
        </Text>
      </div>

      <Heading style={styles.h1}>Attendance regularization declined</Heading>

      <Text style={styles.p}>
        Hi <strong>{employeeName}</strong>, your attendance regularization request has been
        reviewed and declined by <strong>{approverName}</strong>. Your attendance record
        remains unchanged.
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
              <td style={styles.tableLabel}>Date</td>
              <td style={{ ...styles.tableValue, color: '#DC2626', fontWeight: '600' }}>
                {formatDate(attendanceDate)}
              </td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Request Type</td>
              <td style={styles.tableValue}>{formatRequestType(requestType)}</td>
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
          If you believe this decision is incorrect, please speak directly with{' '}
          <strong>{approverName}</strong> or escalate to your HR admin.
        </Text>
      </div>
    </EmailLayout>
  );
}

AttendanceRegularizationRejectedEmail.subject = subject;

export default AttendanceRegularizationRejectedEmail;

AttendanceRegularizationRejectedEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  attendanceDate: '2026-05-05',
  requestType: 'forgot_punch_out',
  approverName: 'Rajan Mehta',
  comment: 'Access logs show you left at 5:15 PM. The regularization request does not match our records.',
} satisfies AttendanceRegularizationRejectedEmailProps;
