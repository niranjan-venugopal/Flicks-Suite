'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { LifeBuoy, Mail, MessageCircle, ShieldCheck, type LucideIcon } from 'lucide-react'
import { PageGlows } from '@/components/layout/PageGlows'
import { Button } from '@/components/ui/button'

/** One support address everywhere (terms, contact, auth frame, here). */
const SUPPORT_EMAIL = 'support@flickssuite.com'
const mailto = (subject: string) => `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`

// Round P polish: every CTA here is a real link now. The old "Browse docs" /
// "Open Slack" buttons pointed at a documentation site and a community that
// do not exist yet — dead buttons on the one page people open when stuck.
interface Resource {
  icon: LucideIcon
  title: string
  description: string
  cta: string
  href: string
  external?: boolean
}

const RESOURCES: Resource[] = [
  {
    icon: Mail,
    title: 'Email support',
    description: 'Questions, how-tos, billing — we reply within one business day.',
    cta: SUPPORT_EMAIL,
    href: mailto('Flicks Suite — support request'),
    external: true,
  },
  {
    icon: MessageCircle,
    title: 'Report a problem',
    description: 'Something not working? Tell us what you expected and what happened instead.',
    cta: 'Report an issue',
    href: mailto('Flicks Suite — problem report'),
    external: true,
  },
  {
    icon: ShieldCheck,
    title: 'Contact & grievance',
    description: 'Data-protection requests, security disclosures and the live status page.',
    cta: 'Open contact page',
    href: '/contact',
  },
]

export default function HelpPage() {
  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold text-ink font-gilroy">Help & support</h1>
          <p className="text-brand-muted mt-1">
            Talk to our team — every button here reaches a real person
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {RESOURCES.map((r, i) => (
            <motion.div
              key={r.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="glass rounded-xl p-6"
            >
              <div className="w-10 h-10 rounded-lg bg-brand-blue/10 flex items-center justify-center mb-4">
                <r.icon className="w-5 h-5 text-brand-blue" />
              </div>
              <h2 className="text-base font-bold text-ink font-gilroy mb-1">
                {r.title}
              </h2>
              <p className="text-sm text-brand-muted mb-4">{r.description}</p>
              {/* asChild: the Button styles land on the anchor itself — no
                  button-inside-link nesting. */}
              <Button variant="outline" size="sm" asChild>
                {r.external ? (
                  <a href={r.href} data-testid={`help-cta-${i}`}>{r.cta}</a>
                ) : (
                  <Link href={r.href} data-testid={`help-cta-${i}`}>{r.cta}</Link>
                )}
              </Button>
            </motion.div>
          ))}
        </div>

        <div className="glass rounded-xl p-6 flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-brand-yellow/10 flex items-center justify-center shrink-0">
            <LifeBuoy className="w-5 h-5 text-brand-yellow" />
          </div>
          <div>
            <h3 className="text-base font-bold text-ink font-gilroy">
              Need urgent help?
            </h3>
            <p className="text-sm text-brand-muted mt-1">
              For payroll or account-blocking issues, email{' '}
              <a
                href={mailto('URGENT — Flicks Suite account issue')}
                className="font-bold text-brand-blue hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>{' '}
              with &ldquo;Urgent&rdquo; in the subject — those go to the front of the queue.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
