import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Contact & Grievance Officer',
  description:
    'Reach the Flicks Suite Grievance Officer for data-protection queries under the DPDP Act 2023.',
}

export default function ContactPage() {
  return (
    <article style={{ lineHeight: 1.65 }}>
      <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6 }}>
        Contact us
      </h1>
      <p style={{ color: 'var(--text-mute)', fontSize: 13, marginBottom: 28 }}>
        For data-protection requests, support, or anything else.
      </p>

      {/* Grievance Officer — DPDP Act requirement */}
      <div
        style={{
          padding: '20px 22px',
          background: 'var(--surf-1)',
          border: '1px solid var(--bord)',
          borderRadius: 12,
          marginBottom: 18,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 800,
            color: 'var(--text-faint)',
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}
        >
          Grievance Officer (DPDP Act 2023)
        </div>
        <div style={{ fontSize: 18, fontWeight: 800 }}>Niranjan V</div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 4 }}>
          Email:{' '}
          <a href="mailto:privacy@flickssuite.com" style={{ color: 'var(--blue)', fontWeight: 700 }}>
            privacy@flickssuite.com
          </a>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-mute)', marginTop: 10, lineHeight: 1.55 }}>
          For any concern about how your personal data is collected, used, or
          stored — including requests to access, correct, or erase your data —
          email our Grievance Officer. We acknowledge within 48 hours and
          resolve within 7 working days, as required by the DPDP Act.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <ContactCard title="Product support" lines={['support@flickssuite.com', 'In-app: Help → Contact support']} />
        <ContactCard title="Security disclosures" lines={['security@flickssuite.com', 'Responsible disclosure welcomed']} />
      </div>

      {/* System status — Better Stack hosted status page + uptime history. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '14px 18px',
          background: 'var(--surf-1)',
          border: '1px solid var(--bord)',
          borderRadius: 10,
          marginBottom: 18,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 800 }}>System status</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-mute)', marginTop: 2 }}>
            Live uptime &amp; incident history
          </div>
        </div>
        <a
          href="https://status.flickssuite.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--blue)', fontWeight: 700, fontSize: 12.5 }}
        >
          status.flickssuite.com →
        </a>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-mute)' }}>
        See also our{' '}
        <Link href="/privacy" style={{ color: 'var(--blue)', fontWeight: 700 }}>
          Privacy Policy
        </Link>{' '}
        for how we handle personal data and your rights as a data principal.
      </div>
    </article>
  )
}

function ContactCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div
      style={{
        padding: '16px 18px',
        background: 'var(--surf-1)',
        border: '1px solid var(--bord)',
        borderRadius: 10,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{title}</div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 2 }}>
          {l}
        </div>
      ))}
    </div>
  )
}
