'use client'

import { motion } from 'framer-motion'
import { TrendingUp } from 'lucide-react'
import { PageGlows } from '@/components/layout/PageGlows'
import { SparkLine } from '@/components/charts/SparkLine'

// TODO: replace with real data from useHeadcountTrend.
const SAMPLE = [
  { value: 18, label: 'Nov' },
  { value: 21, label: 'Dec' },
  { value: 24, label: 'Jan' },
  { value: 27, label: 'Feb' },
  { value: 31, label: 'Mar' },
  { value: 34, label: 'Apr' },
  { value: 38, label: 'May' },
]

export default function HeadcountReportPage() {
  const current = SAMPLE[SAMPLE.length - 1].value
  const prev = SAMPLE[SAMPLE.length - 2].value
  const delta = current - prev

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
            Headcount report
          </h1>
          <p className="text-brand-muted mt-1">
            See how your team has grown month over month
          </p>
        </motion.div>

        <div className="glass rounded-xl p-6">
          <div className="flex items-start justify-between gap-6 flex-wrap mb-6">
            <div>
              <h2 className="text-lg font-bold text-white font-gilroy">
                Active employees
              </h2>
              <p className="text-sm text-brand-muted mt-1">
                Last 7 months trend
              </p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold text-white font-gilroy">
                {current}
              </div>
              <div className="flex items-center gap-1 justify-end text-xs font-gilroy text-brand-green mt-1">
                <TrendingUp className="w-3 h-3" />
                +{delta} vs last month
              </div>
            </div>
          </div>
          <SparkLine data={SAMPLE} height={120} showTooltip color="#2B69F5" />
        </div>
      </div>
    </div>
  )
}
