'use client'

import { motion } from 'framer-motion'
import { PageGlows } from '@/components/layout/PageGlows'
import { SparkLine } from '@/components/charts/SparkLine'

// TODO: replace with real data from useAuditLog.
const SAMPLE = [
  { value: 12, label: 'Mon' },
  { value: 18, label: 'Tue' },
  { value: 24, label: 'Wed' },
  { value: 9, label: 'Thu' },
  { value: 30, label: 'Fri' },
  { value: 4, label: 'Sat' },
  { value: 2, label: 'Sun' },
]

export default function AuditReportPage() {
  const total = SAMPLE.reduce((acc, s) => acc + s.value, 0)

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold text-white font-gilroy">Audit log</h1>
          <p className="text-brand-muted mt-1">
            Sensitive actions taken across your workspace
          </p>
        </motion.div>

        <div className="glass rounded-xl p-6">
          <div className="flex items-start justify-between gap-6 flex-wrap mb-6">
            <div>
              <h2 className="text-lg font-bold text-white font-gilroy">
                Activity this week
              </h2>
              <p className="text-sm text-brand-muted mt-1">
                {total} events recorded across the last 7 days
              </p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold text-white font-gilroy">
                {total}
              </div>
              <div className="text-xs text-white/40 font-gilroy mt-1">events</div>
            </div>
          </div>
          <SparkLine data={SAMPLE} height={120} showTooltip color="#00C9A7" />
        </div>
      </div>
    </div>
  )
}
