import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy · Flicks Suite',
  description:
    'How Flicks Suite collects, processes, stores and protects personal data — DPDP (India), GDPR (EU/UK) and CCPA (California) in one policy.',
}

// PRD v4 Appendix B (draft — counsel sign-off pending, §15.1). Version is the
// shared PRIVACY_VERSION constant; bumping it triggers in-app re-acceptance.
const PRIVACY_VERSION = 'privacy-2026-07-01'
const EFFECTIVE_DATE = '1 July 2026'

// Appendix C — published with the policy and linked from Settings → Privacy &
// data and Org settings → Data & legal.
const SUB_PROCESSORS: Array<{ name: string; purpose: string; data: string; region: string }> = [
  { name: 'Supabase (AWS)', purpose: 'Primary database', data: 'Account + Customer Data', region: 'India (Mumbai, ap-south-1)' },
  { name: 'Cloudflare R2', purpose: 'File storage (PDFs, images, exports)', data: 'Documents, avatars/logos, export archives', region: 'Global (Cloudflare)' },
  { name: 'Vercel', purpose: 'Web hosting/CDN', data: 'Technical/request data', region: 'Global edge' },
  { name: 'Railway', purpose: 'API hosting', data: 'Request/processing data', region: 'US/EU (per deployment)' },
  { name: 'Razorpay', purpose: 'Payments, subscriptions, mandates (tenant + platform billing)', data: 'Payment/billing metadata', region: 'India' },
  { name: 'Resend', purpose: 'Transactional & (consented) marketing email', data: 'Email address, message content', region: 'United States' },
  { name: 'Sentry (Functional Software)', purpose: 'Error monitoring', data: 'PII-minimized error/technical data', region: 'EU (Frankfurt)' },
  { name: 'Upstash', purpose: 'Cache/queues', data: 'Ephemeral operational data', region: 'Global (region-pinned)' },
]

export default function PrivacyPolicyPage() {
  return (
    <article style={{ lineHeight: 1.65 }}>
      <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6 }}>
        Privacy Policy
      </h1>
      <p style={{ color: 'var(--text-mute)', fontSize: 13, marginBottom: 28 }}>
        Effective {EFFECTIVE_DATE} · Version{' '}
        <code style={{ fontFamily: 'var(--font-mono)' }}>{PRIVACY_VERSION}</code> · DPDP Act 2023
        (India) · GDPR (EU/UK) · CCPA/CPRA (California)
      </p>

      <Section title="1. Who we are">
        Specflicks Private Limited, Chennai, Tamil Nadu, India — contact{' '}
        <strong>privacy@specflicks.com</strong>. <strong>Grievance Officer (DPDP):</strong>{' '}
        Venugopal Ramachandran (see the{' '}
        <Link href="/contact" style={{ color: 'var(--blue)', fontWeight: 700 }}>contact page</Link>
        ). We respond within timelines required by applicable law.
      </Section>

      <Section title="2. Our two roles">
        (a) <strong>Data Fiduciary / Controller</strong> for account holders and visitors (signup
        details, billing, consents, support/feedback, product usage of our app). (b){' '}
        <strong>Data Processor</strong> for Customer Data your organization stores in Flicks
        Suite (e.g., employee records, attendance, customer and invoice data) — your organization
        is the fiduciary/controller; we process on its instructions under the DPA. Individuals
        whose data appears in Customer Data should contact that organization first; we will
        assist it in honoring rights requests.
      </Section>

      <Section title="3. What we collect (as fiduciary/controller)">
        Account data (name, work email, phone); organization data (company name, GSTIN/PAN as
        provided); authentication metadata (login timestamps, hashed tokens); consent records
        (choice, version, timestamp, region, hashed IP); product usage events (feature actions
        such as &ldquo;invoice sent&rdquo; — identifiers and counts, no message content);{' '}
        <strong>
          subscription and billing metadata for your Flicks Suite plan (plan, seat count, charge
          status) processed via Razorpay — we never store card/UPI credentials
        </strong>
        ; device/technical data (browser, approximate region); support and feedback content.
      </Section>

      <Section title="4. Why we process (purposes & bases)">
        Providing the service (contract / DPDP consent at signup); billing and subscription
        administration (contract); security, fraud prevention, and error monitoring (legitimate
        interest / legitimate use — PII-minimized); product analytics (consent where required by
        your region — §6); marketing communications (consent, opt-out anytime); legal compliance
        (tax, accounting).
      </Section>

      <Section title="5. Cookies & similar">
        Essential cookies (session, security, consent memory) always on. Analytics runs per your
        consent choice (§6). We use <strong>no third-party advertising cookies</strong>.
      </Section>

      <Section title="6. Your choices">
        Region-aware consent banner + Settings → Privacy &amp; data: toggle product analytics
        and marketing email anytime; withdrawal is as easy as giving consent and takes effect
        immediately for future processing. Marketing emails include one-click unsubscribe.
      </Section>

      <Section title="7. Where your data lives & transfers">
        Primary database: <strong>AWS Mumbai (ap-south-1) via Supabase</strong>. Files
        (documents, images, exports): <strong>Cloudflare R2</strong> (global infrastructure).
        Error monitoring: <strong>Sentry, EU (Frankfurt)</strong>. Email delivery:{' '}
        <strong>Resend (US)</strong>. Hosting: <strong>Vercel</strong> (web, global edge) and{' '}
        <strong>Railway</strong> (API). Payments &amp; subscriptions:{' '}
        <strong>Razorpay (India)</strong>. Where personal data is transferred outside India, we
        do so consistent with the DPDP Act&rsquo;s cross-border framework and, for EU/UK personal
        data, with appropriate safeguards (SCCs where applicable). Full sub-processor list below.
      </Section>

      <Section title="8. Retention">
        Account data: life of account + up to 90 days; consent ledger: 7 years; product events:
        12 months; feedback: 24 months; error logs (Sentry): 90 days; billing records: as
        required by tax law; backups roll off per provider schedule; Customer Data: per your
        organization&rsquo;s instructions and the 30-day post-termination export window.
      </Section>

      <Section title="9. Your rights">
        <strong>India (DPDP):</strong> access/summary of processing, correction, erasure,
        grievance redressal (Grievance Officer above; escalation to the Data Protection Board of
        India), nomination. <strong>EU/UK (GDPR):</strong> access, rectification, erasure,
        restriction, portability, objection; complaint to your supervisory authority.{' '}
        <strong>California (CCPA/CPRA):</strong> know, delete, correct, opt out of
        &ldquo;sale&rdquo;/&ldquo;sharing&rdquo; (we do not sell personal information; the
        analytics toggle governs sharing for analytics), non-discrimination. Exercise via
        Settings → Privacy &amp; data (export/delete are self-service) or privacy@specflicks.com;
        we verify requests before acting.
      </Section>

      <Section title="10. Security">
        Row-level tenant isolation enforced in the database (continuously tested), encryption in
        transit and at rest, least-privilege roles, MFA for platform administrators, audit
        logging with PII masking, rate limiting. No method is 100% secure; we notify affected
        parties and authorities of breaches as required by law.
      </Section>

      <Section title="11. Children">
        The service is for users 18+; we do not knowingly process children&rsquo;s data.
      </Section>

      <Section title="12. Changes">
        Material changes are notified in-product and take effect per the Terms&rsquo;
        re-acceptance flow. Prior versions available on request.
      </Section>

      <section id="sub-processors" style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>Sub-processors</h2>
        <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
          We use the following sub-processors to provide the service. We give notice of changes
          to this list per the DPA.
          <div style={{ overflowX: 'auto', marginTop: 14 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bord)', textAlign: 'left' }}>
                  <Th>Sub-processor</Th>
                  <Th>Purpose</Th>
                  <Th>Data</Th>
                  <Th>Region</Th>
                </tr>
              </thead>
              <tbody>
                {SUB_PROCESSORS.map((row) => (
                  <tr key={row.name} style={{ borderBottom: '1px solid var(--bord)' }}>
                    <Td><strong>{row.name}</strong></Td>
                    <Td>{row.purpose}</Td>
                    <Td>{row.data}</Td>
                    <Td>{row.region}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <Section title="Related">
        <Link href="/terms" style={{ color: 'var(--blue)', fontWeight: 700 }}>Terms of Service</Link>
        {' · '}
        <Link href="/contact" style={{ color: 'var(--blue)', fontWeight: 700 }}>Contact &amp; Grievance Officer</Link>
        {' · '}A signed Data Processing Addendum is available on request from your Org settings.
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
