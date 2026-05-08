'use client'

import { motion } from 'framer-motion'
import { PageGlows } from '@/components/layout/PageGlows'
import { DonutChart } from '@/components/charts/DonutChart'

// TODO: replace with real data from useLeaveReport.
const SAMPLE = [
  { name: 'Casual', value: 24, color: '#2B69F5' },
  { name: 'Sick', value: 18, color: '#FFC72C' },
  { name: 'Earned', value: 9, color: '#00C9A7' },
  { name: 'Unpaid', value: 3, color: '#FF6B6B' },
]

export default function LeaveReportPage() {
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
          <h1 className="text-3xl font-bold text-white font-gilroy">Leave report</h1>
          <p className="text-brand-muted mt-1">
            Track how leave is being used across your team
          </p>
        </motion.div>

        <div className="glass rounded-xl p-6">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <h2 className="text-lg font-bold text-white font-gilroy">
                Leave by type
              </h2>
              <p className="text-sm text-brand-muted mt-1">
                Approved leave days in the current period
              </p>
            </div>
            <DonutChart
              data={SAMPLE}
              size={160}
              innerRadius={50}
              outerRadius={70}
              centerLabel={String(total)}
              centerSubLabel="days"
            />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
            {SAMPLE.map((s) => (
              <div
                key={s.name}
                className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: s.color }}
                  />
                  <span className="text-xs font-gilroy text-white/50">{s.name}</span>
                </div>
                <div className="text-lg font-bold text-white font-gilroy mt-1">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
