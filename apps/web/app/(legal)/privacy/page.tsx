import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy · Flicks Suite',
  description:
    'How Flicks Suite collects, processes, stores and protects personal data under the DPDP Act 2023.',
}

const LAST_UPDATED = '23 May 2026'
const CONSENT_VERSION = '2026-05-v1'

// Purpose specification per data category (DPDP Act 2023 §6 — purpose
// limitation). Kept in sync with the consent rows written at onboarding.
const DATA_CATEGORIES: Array<{ category: string; data: string; purpose: string; retention: string }> = [
  {
    category: 'Identity',
    data: 'Name, date of birth, PAN, Aadhaar (last 4 digits only)',
    purpose: 'Statutory compliance (TDS, PF/ESI), identity verification',
    retention: '8 years post-exit (Income Tax Act)',
  },
  {
    category: 'Contact',
    data: 'Personal email, phone, address, emergency contact',
    purpose: 'HR communication, emergency response',
    retention: '8 years post-exit',
  },
  {
    category: 'Financial',
    data: 'Bank account (masked), IFSC, UAN',
    purpose: 'Salary disbursement, PF contributions',
    retention: '8 years post-exit',
  },
  {
    category: 'Attendance & leave',
    data: 'Clock-in/out times, geolocation at punch, leave records',
    purpose: 'Payroll, compliance with working-hours law',
    retention: '3 years (attendance), 8 years (leave ledger)',
  },
  {
    category: 'Audit',
    data: 'Action logs, IP address, device, consent records',
    purpose: 'Security, dispute resolution, regulatory audit',
    retention: '1 year minimum',
  },
]

const RIGHTS: Array<{ right: string; how: string; href?: string }> = [
  { right: 'Right to access', how: 'Download a copy of all your data', href: '/profile' },
  { right: 'Right to correction', how: 'Edit your details from your profile', href: '/profile' },
  { right: 'Right to erasure', how: 'Request account deletion (7-day cool-off)', href: '/profile' },
  { right: 'Right to grievance', how: 'Contact our Grievance Officer', href: '/contact' },
]

export default function PrivacyPolicyPage() {
  return (
    <article style={{ lineHeight: 1.65 }}>
      <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6 }}>
        Privacy Policy
      </h1>
      <p style={{ color: 'var(--text-mute)', fontSize: 13, marginBottom: 28 }}>
        Last updated {LAST_UPDATED} · Consent version <code style={{ fontFamily: 'var(--font-mono)' }}>{CONSENT_VERSION}</code> · Compliant with the
        Digital Personal Data Protection Act, 2023 (India)
      </p>

      <Section title="1. Who we are">
        Flicks Suite is an HR management platform operated by Specflicks. We act
        as a <strong>Data Processor</strong> on behalf of your employer (the{' '}
        <strong>Data Fiduciary</strong>) for employee records, and as a Data
        Fiduciary for the workspace administrator's own account data.
      </Section>

      <Section title="2. What we collect & why">
        We practise <strong>purpose limitation</strong> — every category of
        personal data is collected for a specific, stated purpose and kept only
        as long as needed:
        <div style={{ overflowX: 'auto', marginTop: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bord)', textAlign: 'left' }}>
                <Th>Category</Th>
                <Th>Data</Th>
                <Th>Purpose</Th>
                <Th>Retention</Th>
              </tr>
            </thead>
            <tbody>
              {DATA_CATEGORIES.map((row) => (
                <tr key={row.category} style={{ borderBottom: '1px solid var(--bord)' }}>
                  <Td><strong>{row.category}</strong></Td>
                  <Td>{row.data}</Td>
                  <Td>{row.purpose}</Td>
                  <Td>{row.retention}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="3. Consent">
        Sensitive data (PAN, Aadhaar last-4, bank, location) is collected only
        with your <strong>explicit, granular, revocable</strong> consent,
        captured during onboarding. You can withdraw any consent at any time
        from your profile; withdrawing data-processing consent may limit
        payroll and statutory features. We never store your full Aadhaar number —
        only the last 4 digits.
      </Section>

      <Section title="4. Your rights">
        Under the DPDP Act you have the following rights:
        <ul style={{ marginTop: 12, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
          {RIGHTS.map((r) => (
            <li
              key={r.right}
              style={{
                display: 'flex',
                gap: 12,
                padding: '10px 12px',
                background: 'var(--surf-1)',
                border: '1px solid var(--bord)',
                borderRadius: 8,
              }}
            >
              <span style={{ fontWeight: 800, minWidth: 170 }}>{r.right}</span>
              <span style={{ flex: 1, color: 'var(--text-2)' }}>{r.how}</span>
              {r.href && (
                <Link href={r.href} style={{ color: 'var(--blue)', fontWeight: 700 }}>
                  Go →
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="5. Data localization">
        All Indian customer data is stored in the{' '}
        <strong>Mumbai region (ap-south-1)</strong>. We do not transfer personal
        data outside India except where required by law.
      </Section>

      <Section title="6. Security">
        Data is isolated per workspace using row-level security. Access is
        audit-logged. Specflicks staff support access (impersonation) is
        time-boxed to 15 minutes, requires a stated reason, notifies you by
        email, and is recorded in both the platform and your workspace audit
        logs.
      </Section>

      <Section title="7. Breach notification">
        In the event of a personal data breach, we will notify the Data
        Protection Board of India and affected data principals within 72 hours.
      </Section>

      <Section title="8. Grievance Officer">
        Questions or complaints about your data? Contact our Grievance Officer,{' '}
        <strong>Niranjan V</strong>, via the{' '}
        <Link href="/contact" style={{ color: 'var(--blue)', fontWeight: 700 }}>
          contact page
        </Link>
        . We respond within 7 working days.
      </Section>
    </article>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>{title}</h2>
      <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>{children}</div>
    </section>
  )
}
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: '8px 10px', fontSize: 11, fontWeight: 800, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
      {children}
    </th>
  )
}
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: '10px', color: 'var(--text-2)', verticalAlign: 'top' }}>{children}</td>
}
