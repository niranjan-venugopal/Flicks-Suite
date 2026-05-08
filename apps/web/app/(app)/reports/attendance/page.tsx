'use client'

import { motion } from 'framer-motion'
import { PageGlows } from '@/components/layout/PageGlows'
import { DonutChart } from '@/components/charts/DonutChart'

// TODO: replace with real data from useAttendanceReport once available.
const SAMPLE = [
  { name: 'Present', value: 142, color: '#00C9A7' },
  { name: 'Late', value: 18, color: '#FFC72C' },
  { name: 'Absent', value: 6, color: '#FF6B6B' },
  { name: 'On leave', value: 12, color: '#2B69F5' },
]

export default function AttendanceReportPage() {
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
          <h1 className="text-3xl font-bold text-white font-gilroy">
            Attendance report
          </h1>
          <p className="text-brand-muted mt-1">
            Headline attendance metrics across your workspace this period
          </p>
        </motion.div>

        <div className="glass rounded-xl p-6">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <h2 className="text-lg font-bold text-white font-gilroy">
                This month
              </h2>
              <p className="text-sm text-brand-muted mt-1">
                Breakdown of marked attendance entries
              </p>
            </div>
            <DonutChart
              data={SAMPLE}
              size={160}
              innerRadius={50}
              outerRadius={70}
              centerLabel={String(total)}
              centerSubLabel="entries"
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
                  <span className="text-xs font-gilroy text-white/50">
                    {s.name}
                  </span>
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
