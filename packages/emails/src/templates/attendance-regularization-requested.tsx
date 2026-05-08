import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AttendanceRegularizationRequestedEmailProps {
  managerName: string;
  employeeName: string;
  attendanceDate: string;
  requestType: string;
  reason: string;
  reviewUrl: string;
}

export const subject = (props: AttendanceRegularizationRequestedEmailProps) =>
  `Attendance regularization request from ${props.employeeName}`;

const formatDate = (dateStr: string) => {
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
};

const formatRequestType = (type: string) => {
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
};

// ─── Template ─────────────────────────────────────────────────────────────────

export function AttendanceRegularizationRequestedEmail({
  managerName,
  employeeName,
  attendanceDate,
  requestType,
  reason,
  reviewUrl,
}: AttendanceRegularizationRequestedEmailProps) {
  return (
    <EmailLayout
      previewText={`${employeeName} has requested attendance regularization for ${formatDate(attendanceDate)}.`}
    >
      <div style={styles.badge}>Attendance Regularization</div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Regularization request — action needed
      </Heading>

      <Text style={styles.p}>
        Hi {managerName}, <strong>{employeeName}</strong> has submitted an attendance
        regularization request that requires your review.
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
              <td style={styles.tableLabel}>Date</td>
              <td style={{ ...styles.tableValue, color: '#2563EB', fontWeight: '600' }}>
                {formatDate(attendanceDate)}
              </td>
            </tr>
            <tr>
              <td style={styles.tableLabel}>Request Type</td>
              <td style={styles.tableValue}>{formatRequestType(requestType)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Heading as="h2" style={styles.h2}>Reason</Heading>
      <div
        style={{
          backgroundColor: '#F8FAFC',
          borderLeft: '3px solid #2563EB',
          borderRadius: '0 6px 6px 0',
          padding: '12px 16px',
          margin: '0 0 24px',
        }}
      >
        <Text style={{ ...styles.p, margin: '0', fontStyle: 'italic' }}>
          &ldquo;{reason}&rdquo;
        </Text>
      </div>

      <Button href={reviewUrl} style={styles.button}>
        Review Request
      </Button>

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          Approving this request will update the employee&apos;s attendance record for the date
          in question. The employee will be notified once you respond.
        </Text>
      </div>
    </EmailLayout>
  );
}

AttendanceRegularizationRequestedEmail.subject = subject;

export default AttendanceRegularizationRequestedEmail;

AttendanceRegularizationRequestedEmail.PreviewProps = {
  managerName: 'Rajan Mehta',
  employeeName: 'Priya Sharma',
  attendanceDate: '2026-05-05',
  requestType: 'forgot_punch_out',
  reason: 'I forgot to punch out when leaving the office. I left at 7:30 PM after the team meeting.',
  reviewUrl: 'https://app.flickssuite.com/attendance/regularization/preview/review',
} satisfies AttendanceRegularizationRequestedEmailProps;
