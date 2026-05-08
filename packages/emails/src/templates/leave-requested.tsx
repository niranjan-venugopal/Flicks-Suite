import { Button, Heading, Hr, Row, Column, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface LeaveRequestedEmailProps {
  managerName: string;
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  approveUrl: string;
  rejectUrl: string;
}

export const subject = (props: LeaveRequestedEmailProps) =>
  `Leave request from ${props.employeeName} — ${props.leaveType} (${props.totalDays} day${props.totalDays !== 1 ? 's' : ''})`;

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

export function LeaveRequestedEmail({
  managerName,
  employeeName,
  leaveType,
  startDate,
  endDate,
  totalDays,
  reason,
  approveUrl,
  rejectUrl,
}: LeaveRequestedEmailProps) {
  return (
    <EmailLayout
      previewText={`${employeeName} has requested ${totalDays} day(s) of ${leaveType} leave. Review and respond.`}
    >
      <div style={styles.badge}>Leave Request</div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Leave request — action needed
      </Heading>

      <Text style={styles.p}>
        Hi {managerName}, <strong>{employeeName}</strong> has submitted a leave request that
        requires your approval.
      </Text>

      {/* Leave Summary Table */}
      <div
        style={{
          backgroundColor: '#F8FAFC',
          border: '1px solid #E2E8F0',
          borderRadius: '8px',
          padding: '20px',
          margin: '20px 0',
        }}
      >
        <Heading as="h2" style={{ ...styles.h2, marginBottom: '16px' }}>
          Leave Summary
        </Heading>
        <table style={{ ...styles.table, margin: '0' }}>
          <tbody>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Employee</td>
              <td style={styles.tableValue}>{employeeName}</td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>Leave Type</td>
              <td style={{ ...styles.tableValue, color: '#2563EB', fontWeight: '600' }}>{leaveType}</td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>From</td>
              <td style={styles.tableValue}>{formatDate(startDate)}</td>
            </tr>
            <tr style={styles.tableRow}>
              <td style={styles.tableLabel}>To</td>
              <td style={styles.tableValue}>{formatDate(endDate)}</td>
            </tr>
            <tr>
              <td style={styles.tableLabel}>Total Days</td>
              <td style={{ ...styles.tableValue, fontSize: '18px', fontWeight: '700', color: '#0F172A' }}>
                {totalDays} day{totalDays !== 1 ? 's' : ''}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Reason */}
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

      <Hr style={styles.divider} />

      {/* One-click approve / reject */}
      <Heading as="h2" style={styles.h2}>Respond directly from email</Heading>
      <Text style={{ ...styles.pMuted, marginBottom: '20px' }}>
        You can approve or reject this request with a single click. You can also add a comment
        by visiting the platform.
      </Text>

      <Row>
        <Column style={{ paddingRight: '8px' }}>
          <Button href={approveUrl} style={styles.buttonSuccess}>
            Approve
          </Button>
        </Column>
        <Column style={{ paddingLeft: '8px' }}>
          <Button href={rejectUrl} style={styles.buttonDanger}>
            Reject
          </Button>
        </Column>
      </Row>

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          The employee will be notified automatically once you respond. If you need to delegate
          approval, log in to Flicks Suite to reassign.
        </Text>
      </div>
    </EmailLayout>
  );
}

LeaveRequestedEmail.subject = subject;

export default LeaveRequestedEmail;

LeaveRequestedEmail.PreviewProps = {
  managerName: 'Rajan Mehta',
  employeeName: 'Priya Sharma',
  leaveType: 'Casual Leave',
  startDate: '2026-05-15',
  endDate: '2026-05-17',
  totalDays: 3,
  reason: 'Attending my cousin\'s wedding in Jaipur.',
  approveUrl: 'https://app.flickssuite.com/leaves/preview/approve',
  rejectUrl: 'https://app.flickssuite.com/leaves/preview/reject',
} satisfies LeaveRequestedEmailProps;
