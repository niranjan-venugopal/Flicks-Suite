import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
  Hr,
  Link,
  Font,
} from '@react-email/components';
import * as React from 'react';

// ─── Brand Tokens ─────────────────────────────────────────────────────────────

const brand = {
  headerBg: '#01010D',
  primaryBlue: '#2563EB',
  bodyBg: '#FFFFFF',
  textPrimary: '#0F172A',
  textMuted: '#64748B',
  borderColor: '#E2E8F0',
  footerBg: '#F8FAFC',
};

// ─── Email Layout Props ───────────────────────────────────────────────────────

interface EmailLayoutProps {
  previewText: string;
  children: React.ReactNode;
}

// ─── Shared Styles ────────────────────────────────────────────────────────────

export const styles = {
  body: {
    backgroundColor: '#F1F5F9',
    fontFamily:
      "'Geist', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
    margin: '0',
    padding: '0',
  } as React.CSSProperties,

  outerContainer: {
    backgroundColor: '#F1F5F9',
    padding: '32px 16px',
  } as React.CSSProperties,

  container: {
    backgroundColor: brand.bodyBg,
    borderRadius: '12px',
    maxWidth: '600px',
    margin: '0 auto',
    overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  } as React.CSSProperties,

  header: {
    backgroundColor: brand.headerBg,
    padding: '28px 40px',
    textAlign: 'center' as const,
  } as React.CSSProperties,

  logoText: {
    color: '#FFFFFF',
    fontSize: '22px',
    fontWeight: '700',
    letterSpacing: '-0.02em',
    margin: '0',
    padding: '0',
    lineHeight: '1',
  } as React.CSSProperties,

  logoAccent: {
    color: brand.primaryBlue,
  } as React.CSSProperties,

  logoTagline: {
    color: '#94A3B8',
    fontSize: '11px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    margin: '6px 0 0',
    padding: '0',
  } as React.CSSProperties,

  content: {
    padding: '40px',
  } as React.CSSProperties,

  footer: {
    backgroundColor: brand.footerBg,
    borderTop: `1px solid ${brand.borderColor}`,
    padding: '24px 40px',
    textAlign: 'center' as const,
  } as React.CSSProperties,

  footerText: {
    color: brand.textMuted,
    fontSize: '12px',
    lineHeight: '1.6',
    margin: '0',
  } as React.CSSProperties,

  footerLink: {
    color: brand.primaryBlue,
    textDecoration: 'none',
  } as React.CSSProperties,

  h1: {
    color: brand.textPrimary,
    fontSize: '26px',
    fontWeight: '700',
    letterSpacing: '-0.02em',
    lineHeight: '1.3',
    margin: '0 0 16px',
  } as React.CSSProperties,

  h2: {
    color: brand.textPrimary,
    fontSize: '20px',
    fontWeight: '600',
    letterSpacing: '-0.01em',
    lineHeight: '1.4',
    margin: '0 0 12px',
  } as React.CSSProperties,

  p: {
    color: brand.textPrimary,
    fontSize: '15px',
    lineHeight: '1.7',
    margin: '0 0 16px',
  } as React.CSSProperties,

  pMuted: {
    color: brand.textMuted,
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '0 0 12px',
  } as React.CSSProperties,

  button: {
    backgroundColor: brand.primaryBlue,
    borderRadius: '8px',
    color: '#FFFFFF',
    display: 'inline-block',
    fontSize: '15px',
    fontWeight: '600',
    padding: '13px 28px',
    textDecoration: 'none',
    textAlign: 'center' as const,
  } as React.CSSProperties,

  buttonOutline: {
    backgroundColor: 'transparent',
    border: `2px solid ${brand.primaryBlue}`,
    borderRadius: '8px',
    color: brand.primaryBlue,
    display: 'inline-block',
    fontSize: '15px',
    fontWeight: '600',
    padding: '11px 26px',
    textDecoration: 'none',
    textAlign: 'center' as const,
  } as React.CSSProperties,

  buttonDanger: {
    backgroundColor: '#DC2626',
    borderRadius: '8px',
    color: '#FFFFFF',
    display: 'inline-block',
    fontSize: '15px',
    fontWeight: '600',
    padding: '13px 28px',
    textDecoration: 'none',
    textAlign: 'center' as const,
  } as React.CSSProperties,

  buttonSuccess: {
    backgroundColor: '#16A34A',
    borderRadius: '8px',
    color: '#FFFFFF',
    display: 'inline-block',
    fontSize: '15px',
    fontWeight: '600',
    padding: '13px 28px',
    textDecoration: 'none',
    textAlign: 'center' as const,
  } as React.CSSProperties,

  infoBox: {
    backgroundColor: '#EFF6FF',
    border: '1px solid #BFDBFE',
    borderRadius: '8px',
    padding: '16px 20px',
    margin: '20px 0',
  } as React.CSSProperties,

  warningBox: {
    backgroundColor: '#FFFBEB',
    border: '1px solid #FDE68A',
    borderRadius: '8px',
    padding: '16px 20px',
    margin: '20px 0',
  } as React.CSSProperties,

  successBox: {
    backgroundColor: '#F0FDF4',
    border: '1px solid #BBF7D0',
    borderRadius: '8px',
    padding: '16px 20px',
    margin: '20px 0',
  } as React.CSSProperties,

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    margin: '20px 0',
  } as React.CSSProperties,

  tableRow: {
    borderBottom: `1px solid ${brand.borderColor}`,
  } as React.CSSProperties,

  tableLabel: {
    color: brand.textMuted,
    fontSize: '13px',
    fontWeight: '500',
    padding: '10px 0',
    width: '40%',
  } as React.CSSProperties,

  tableValue: {
    color: brand.textPrimary,
    fontSize: '14px',
    fontWeight: '500',
    padding: '10px 0',
  } as React.CSSProperties,

  divider: {
    borderColor: brand.borderColor,
    margin: '28px 0',
  } as React.CSSProperties,

  otpCode: {
    backgroundColor: '#F8FAFC',
    border: `2px solid ${brand.borderColor}`,
    borderRadius: '12px',
    color: brand.textPrimary,
    display: 'block',
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: '42px',
    fontWeight: '700',
    letterSpacing: '0.25em',
    padding: '20px',
    textAlign: 'center' as const,
    margin: '24px 0',
  } as React.CSSProperties,

  badge: {
    backgroundColor: '#EFF6FF',
    borderRadius: '20px',
    color: brand.primaryBlue,
    display: 'inline-block',
    fontSize: '12px',
    fontWeight: '600',
    letterSpacing: '0.04em',
    padding: '4px 12px',
    textTransform: 'uppercase' as const,
  } as React.CSSProperties,
};

// ─── Email Layout Component ───────────────────────────────────────────────────

export function EmailLayout({ previewText, children }: EmailLayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <Font
          fontFamily="Geist"
          fallbackFontFamily="Helvetica"
          webFont={{
            url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
            format: 'woff2',
          }}
          fontWeight={400}
          fontStyle="normal"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </Head>
      <Preview>{previewText}</Preview>
      <Body style={styles.body}>
        <Section style={styles.outerContainer}>
          <Container style={styles.container}>
            {/* Header */}
            <Section style={styles.header}>
              <Text style={styles.logoText}>
                Flicks<span style={styles.logoAccent}>Suite</span>
              </Text>
              <Text style={styles.logoTagline}>HRMS for Indian Startups</Text>
            </Section>

            {/* Main Content */}
            <Section style={styles.content}>{children}</Section>

            {/* Footer */}
            <Section style={styles.footer}>
              <Hr style={styles.divider} />
              <Text style={styles.footerText}>
                <strong>Flicks Suite</strong> by Specflicks Pvt Ltd | Bengaluru, India
              </Text>
              <Text style={styles.footerText}>
                You&apos;re receiving this email because you have an account with Flicks Suite.
                {' '}
                <Link href="https://app.flickssuite.com/unsubscribe" style={styles.footerLink}>
                  Unsubscribe
                </Link>
                {' '}·{' '}
                <Link href="https://flickssuite.com/privacy" style={styles.footerLink}>
                  Privacy Policy
                </Link>
              </Text>
              <Text style={styles.footerText}>
                © {new Date().getFullYear()} Specflicks Pvt Ltd. All rights reserved.
              </Text>
            </Section>
          </Container>
        </Section>
      </Body>
    </Html>
  );
}

export default EmailLayout;
