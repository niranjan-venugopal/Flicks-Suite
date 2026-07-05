import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms of Service · Flicks Suite',
  description: 'The terms that govern access to and use of Flicks Suite.',
}

// PRD v4 Appendix A (draft — counsel sign-off pending, §15.1). Version is the
// shared TERMS_VERSION constant; bumping it triggers in-app re-acceptance.
const TERMS_VERSION = 'tos-2026-07-01'
const EFFECTIVE_DATE = '1 July 2026'

export default function TermsPage() {
  return (
    <article style={{ lineHeight: 1.65 }}>
      <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6 }}>
        Terms of Service
      </h1>
      <p style={{ color: 'var(--text-mute)', fontSize: 13, marginBottom: 28 }}>
        Effective {EFFECTIVE_DATE} · Version{' '}
        <code style={{ fontFamily: 'var(--font-mono)' }}>{TERMS_VERSION}</code>
      </p>

      <Section title="1. Agreement">
        These Terms govern access to Flicks Suite, provided by{' '}
        <strong>Specflicks Private Limited</strong>, Chennai, Tamil Nadu, India
        (&ldquo;Specflicks&rdquo;, &ldquo;we&rdquo;). By creating an account or clicking
        &ldquo;I agree,&rdquo; you accept these Terms on behalf of yourself and, where
        applicable, the organization you represent (you confirm you have authority to bind it).
      </Section>

      <Section title="2. The service">
        Flicks Suite is a business software suite (including HR, attendance, leave, timesheet,
        and invoicing modules) provided on a subscription basis. During the{' '}
        <strong>beta period</strong>, features may change, and the service is provided with
        beta-level availability; we will give reasonable notice of material changes.
      </Section>

      <Section title="3. Accounts & eligibility">
        You must be 18+ and use the service for business purposes. You are responsible for
        safeguarding credentials and for activities under your account. Notify us promptly of
        unauthorized use.
      </Section>

      <Section title="4. Your data">
        As between the parties, you own the content and data you submit (&ldquo;Customer
        Data&rdquo;). You grant us a limited license to host, process, and display Customer Data
        solely to provide and improve the service. We process personal data per our{' '}
        <Link href="/privacy" style={{ color: 'var(--blue)', fontWeight: 700 }}>
          Privacy Policy
        </Link>{' '}
        and, for organizational Customer Data, as a processor under the DPA (available on request).
      </Section>

      <Section title="5. Acceptable use">
        No unlawful content or use; no infringing, malicious, or abusive activity; no attempts
        to breach security, probe tenant isolation, or access other customers&rsquo; data; no
        reverse engineering except as permitted by law; no reselling without written consent. We
        may suspend accounts for material violations, with notice where practicable.
      </Section>

      <Section title="6. Fees, subscriptions & coupons">
        The beta plan is priced per seat per month as shown in-product (auditor seats are free).
        Charges recur via the auto-debit mandate you authorize with our payment partner
        (Razorpay) under applicable RBI rules, with advance pre-debit notice. Promotional coupon
        codes extend the free period as stated on the code, are limited to{' '}
        <strong>one redemption per organization</strong>, and may expire or be withdrawn.
        Post-beta pricing changes take effect with prior notice at your next billing cycle.
        Taxes (including GST) apply as required.
      </Section>

      <Section title="7. Third-party services">
        The service relies on sub-processors listed in our{' '}
        <Link href="/privacy#sub-processors" style={{ color: 'var(--blue)', fontWeight: 700 }}>
          Privacy Policy
        </Link>
        . We are not responsible for third-party services you connect at your option.
      </Section>

      <Section title="8. Intellectual property">
        We retain all rights in the service, software, and branding. Feedback you provide may be
        used without obligation.
      </Section>

      <Section title="9. Availability & support">
        We target commercially reasonable uptime during beta; scheduled maintenance and factors
        beyond our control excepted. Support via in-app feedback and support@specflicks.com.
      </Section>

      <Section title="10. Disclaimers">
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; DURING BETA. TO THE MAXIMUM EXTENT PERMITTED
        BY LAW, WE DISCLAIM IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
        PURPOSE, AND NON-INFRINGEMENT. Flicks Suite outputs (including GST/TDS computations and
        exports) support, but do not replace, professional review; you are responsible for
        statutory filings.
      </Section>

      <Section title="11. Limitation of liability">
        To the maximum extent permitted by law, neither party is liable for indirect,
        incidental, special, or consequential damages, or loss of profits/data. Our aggregate
        liability is capped at the fees paid by you in the <strong>12 months</strong> preceding
        the claim (or <strong>₹10,000</strong> if no fees were paid, e.g., during a free beta).
        Nothing limits liability that cannot be limited by law.
      </Section>

      <Section title="12. Indemnity">
        You will indemnify us against third-party claims arising from Customer Data or your
        unlawful use of the service.
      </Section>

      <Section title="13. Term & termination">
        Either party may terminate for material breach uncured within 30 days of notice. You may
        stop using the service and request deletion/export at any time (Privacy Policy §Rights).
        On termination we will make Customer Data available for export for{' '}
        <strong>30 days</strong>, then delete per our retention schedule.
      </Section>

      <Section title="14. Governing law & disputes">
        These Terms are governed by the laws of India; courts at{' '}
        <strong>Chennai, Tamil Nadu</strong> have exclusive jurisdiction.
      </Section>

      <Section title="15. Changes">
        We may update these Terms; material changes take effect on re-acceptance or 15 days
        after in-product notice, whichever is earlier.
      </Section>

      <Section title="16. Contact">
        legal@specflicks.com · Specflicks Private Limited, Chennai, Tamil Nadu, India. See also
        our{' '}
        <Link href="/contact" style={{ color: 'var(--blue)', fontWeight: 700 }}>
          contact &amp; grievance page
        </Link>
        .
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
