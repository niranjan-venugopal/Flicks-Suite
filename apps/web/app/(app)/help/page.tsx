'use client'

import { motion } from 'framer-motion'
import { BookOpen, LifeBuoy, MessageCircle, Mail } from 'lucide-react'
import { PageGlows } from '@/components/layout/PageGlows'
import { Button } from '@/components/ui/button'

const RESOURCES = [
  {
    icon: BookOpen,
    title: 'Documentation',
    description: 'Guides and how-tos for every part of Flicks.',
    cta: 'Browse docs',
  },
  {
    icon: MessageCircle,
    title: 'Community',
    description: 'Chat with other admins and the Flicks team.',
    cta: 'Open Slack',
  },
  {
    icon: Mail,
    title: 'Email support',
    description: 'Get a response within one business day.',
    cta: 'support@flicks.app',
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
          <h1 className="text-3xl font-bold text-white font-gilroy">Help & support</h1>
          <p className="text-brand-muted mt-1">
            Find answers, learn the product, or talk to our team
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
              <h2 className="text-base font-bold text-white font-gilroy mb-1">
                {r.title}
              </h2>
              <p className="text-sm text-brand-muted mb-4">{r.description}</p>
              <Button variant="outline" size="sm">
                {r.cta}
              </Button>
            </motion.div>
          ))}
        </div>

        <div className="glass rounded-xl p-6 flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-brand-yellow/10 flex items-center justify-center shrink-0">
            <LifeBuoy className="w-5 h-5 text-brand-yellow" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white font-gilroy">
              Need urgent help?
            </h3>
            <p className="text-sm text-brand-muted mt-1">
              For payroll or account-blocking issues, reach out to your customer success
              manager — they’ll prioritise your ticket.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
