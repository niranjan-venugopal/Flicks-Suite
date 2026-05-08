import { Button, Heading, Hr, Link, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, styles } from '../components/EmailLayout.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface LoginOtpEmailProps {
  email: string;
  otpCode: string;
  magicLinkUrl: string;
  expiryMinutes?: number;
}

// ─── Subject helper ───────────────────────────────────────────────────────────

export const subject = (props: LoginOtpEmailProps) =>
  `Your Flicks Suite login code: ${props.otpCode}`;

// ─── Template ─────────────────────────────────────────────────────────────────

export function LoginOtpEmail({
  email,
  otpCode,
  magicLinkUrl,
  expiryMinutes = 10,
}: LoginOtpEmailProps) {
  return (
    <EmailLayout previewText={`Your login code is ${otpCode} — valid for ${expiryMinutes} minutes`}>
      <Heading style={styles.h1}>Your login code</Heading>
      <Text style={styles.p}>
        Use the one-time code below to sign in to Flicks Suite. This code was requested for{' '}
        <strong>{email}</strong>.
      </Text>

      {/* OTP Block */}
      <Text style={styles.otpCode}>{otpCode}</Text>

      <div style={styles.infoBox}>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          This code expires in <strong>{expiryMinutes} minutes</strong> and can only be used once.
        </Text>
      </div>

      <Hr style={styles.divider} />

      <Heading as="h2" style={styles.h2}>Or click to log in instantly</Heading>
      <Text style={styles.p}>
        Prefer not to type the code? Click the button below for a one-click login.
      </Text>

      <Button href={magicLinkUrl} style={styles.button}>
        Click to log in instantly
      </Button>

      <Hr style={styles.divider} />

      <div style={styles.warningBox}>
        <Text style={{ ...styles.pMuted, margin: '0 0 8px', fontWeight: '600' }}>
          Security notice
        </Text>
        <Text style={{ ...styles.pMuted, margin: '0' }}>
          If you did not request this code, someone may have entered your email address by mistake.
          You can safely ignore this email — your account remains secure.{' '}
          <Link href="https://app.flickssuite.com/security" style={styles.footerLink as React.CSSProperties}>
            Learn more
          </Link>
        </Text>
      </div>
    </EmailLayout>
  );
}

LoginOtpEmail.subject = subject;

export default LoginOtpEmail;

// ─── Preview Data ─────────────────────────────────────────────────────────────

LoginOtpEmail.PreviewProps = {
  email: 'priya@example.com',
  otpCode: '482610',
  magicLinkUrl: 'https://app.flickssuite.com/auth/magic?token=preview',
  expiryMinutes: 10,
} satisfies LoginOtpEmailProps;
