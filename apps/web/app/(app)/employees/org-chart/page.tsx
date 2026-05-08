'use client'

import { motion } from 'framer-motion'
import { GitBranch } from 'lucide-react'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'

export default function OrgChartPage() {
  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold text-white font-gilroy">Org Chart</h1>
          <p className="text-brand-muted mt-1">
            Visualise reporting lines across your organisation
          </p>
        </motion.div>

        <div className="glass rounded-xl">
          <EmptyState
            icon={GitBranch}
            title="Org chart coming soon"
            description="An interactive view of your reporting structure is on the way."
          />
        </div>
      </div>
    </div>
  )
}
