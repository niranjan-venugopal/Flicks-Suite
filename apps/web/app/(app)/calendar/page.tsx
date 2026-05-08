'use client'

import { motion } from 'framer-motion'
import { Calendar } from 'lucide-react'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'

export default function CalendarPage() {
  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold text-white font-gilroy">Calendar</h1>
          <p className="text-brand-muted mt-1">
            See holidays, leave and team availability in one view
          </p>
        </motion.div>

        <div className="glass rounded-xl">
          <EmptyState
            icon={Calendar}
            title="Calendar coming soon"
            description="A unified team calendar with holidays and leave overlays is on the way."
          />
        </div>
      </div>
    </div>
  )
}
