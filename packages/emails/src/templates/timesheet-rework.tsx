import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TimesheetReworkEmailProps {
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  totalHours: number;
  approverName: string;
  comment?: string;
  reworkUrl: string;
}

export const subject = (props: TimesheetReworkEmailProps) =>
  `Timesheet rework requested for ${props.periodStart} – ${props.periodEnd}`;

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

export function TimesheetReworkEmail({
  employeeName,
  periodStart,
  periodEnd,
  totalHours,
  approverName,
  comment,
  reworkUrl,
}: TimesheetReworkEmailProps) {
  return (
    <EmailLayout
      previewText={`${approverName} has requested changes to your timesheet. Please update and resubmit.`}
    >
      <div style={styles.warningBox}>
        <Text
          style={{
            color: '#92400E',
            fontSize: '14px',
            fontWeight: '700',
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
            margin: '0',
          }}
        >
          Rework Requested
        </Text>
      </div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Timesheet rework requested
      </Heading>

      <Text style={styles.p}>
        Hi <strong>{employeeName}</strong>, <strong>{approverName}</strong> has reviewed your
        timesheet and requested some changes before approving it.
      </Text>

      <div
        style={{
          backgroundColor: '#FFFBEB',
          border: '1px solid #FDE68A',
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
        <>
          <Heading as="h2" style={styles.h2}>What needs to be changed</Heading>
          <div
            style={{
              backgroundColor: '#F8FAFC',
              borderLeft: '3px solid #D97706',
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

      <Button href={reworkUrl} style={styles.button}>
        Update Timesheet
      </Button>

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          Your timesheet is back in <strong>draft</strong> state. Make the requested changes and
          resubmit for approval. If you have questions, please reach out to{' '}
          <strong>{approverName}</strong>.
        </Text>
      </div>
    </EmailLayout>
  );
}

TimesheetReworkEmail.subject = subject;

export default TimesheetReworkEmail;

TimesheetReworkEmail.PreviewProps = {
  employeeName: 'Priya Sharma',
  periodStart: '2026-04-28',
  periodEnd: '2026-05-04',
  totalHours: 42.5,
  approverName: 'Rajan Mehta',
  comment: 'Please add project codes for the Tuesday and Wednesday entries. The descriptions are also too vague.',
  reworkUrl: 'https://app.flickssuite.com/timesheets/preview/edit',
} satisfies TimesheetReworkEmailProps;
