import { Button, Heading, Hr, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DataExportReadyEmailProps {
  userName: string;
  downloadUrl: string;
  expiryHours?: number;
}

export const subject = (_props: DataExportReadyEmailProps) =>
  `Your data export is ready — download now`;

// ─── Template ─────────────────────────────────────────────────────────────────

export function DataExportReadyEmail({
  userName,
  downloadUrl,
  expiryHours = 24,
}: DataExportReadyEmailProps) {
  return (
    <EmailLayout
      previewText={`Your Flicks Suite data export is ready. Download it within ${expiryHours} hours.`}
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
          Export Ready ✓
        </Text>
      </div>

      <Heading style={{ ...styles.h1, marginTop: '16px' }}>
        Your data export is ready
      </Heading>

      <Text style={styles.p}>
        Hi <strong>{userName}</strong>, the data export you requested from Flicks Suite has been
        prepared and is ready for download.
      </Text>

      <Button href={downloadUrl} style={styles.button}>
        Download Export
      </Button>

      <Hr style={styles.divider} />

      <div style={styles.warningBox}>
        <Text style={{ ...styles.pMuted, margin: '0 0 4px', fontWeight: '600', color: '#92400E' }}>
          This link expires in {expiryHours} hours
        </Text>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          The download link is temporary and will expire in <strong>{expiryHours} hours</strong>{' '}
          for security reasons. If the link expires, you can request a new export from Flicks Suite.
        </Text>
      </div>

      <Hr style={styles.divider} />

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0 0 8px', fontWeight: '600' }}>
          Data privacy notice
        </Text>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          This export may contain personal and sensitive employee data. Please handle it in
          accordance with your organisation&apos;s data protection policies and applicable law
          (DPDP Act 2023). Do not share this file with unauthorised personnel.
        </Text>
      </div>
    </EmailLayout>
  );
}

DataExportReadyEmail.subject = subject;

export default DataExportReadyEmail;

DataExportReadyEmail.PreviewProps = {
  userName: 'Rajan Mehta',
  downloadUrl: 'https://app.flickssuite.com/exports/download?token=preview',
  expiryHours: 24,
} satisfies DataExportReadyEmailProps;
