'use client'

import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/lib/stores/auth.store'
import { ClockInCard } from '@/components/attendance/ClockInCard'
import { useAdminOverview } from '@/lib/api/queries/use-dashboard'
import { StatsGrid } from '@/components/dashboard/StatsGrid'
import { PendingActionsCard } from '@/components/dashboard/PendingActionsCard'
import { TodaysSnapshotCard } from '@/components/dashboard/TodaysSnapshotCard'
import { TrendsCard } from '@/components/dashboard/TrendsCard'
import { ActivityFeedCard } from '@/components/dashboard/ActivityFeedCard'

const SETUP_STEPS = [
  { label: 'Create your workspace', done: true },
  { label: 'Invite your team', done: false },
  { label: 'Set working hours & holidays', done: false },
  { label: 'Configure leave policies', done: false },
  { label: 'Add departments & locations', done: false },
]

export default function DashboardPage() {
  const { currentUser, currentTenant } = useAuthStore()
  const overview = useAdminOverview()
  const qc = useQueryClient()

  const firstName = currentUser?.name?.split(' ')[0] ?? 'there'

  // Setup checklist is only useful while the workspace is genuinely empty.
  // Once 6+ employees are onboarded the operational widgets dominate.
  const employeeCount = overview.data?.stats.totalEmployees ?? 0
  const showSetupChecklist = !overview.isLoading && employeeCount <= 5

  // After Approve/Reject, drop dashboard cache so counts + lists refresh.
  const refreshOverview = () => {
    qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8"
      >
        <h1 className="text-3xl font-bold text-white font-gilroy">
          {greeting()}, {firstName}
        </h1>
        <p className="text-brand-muted mt-1">
          {todayLabel()} · {currentTenant?.name ?? 'Your workspace'}
        </p>
      </motion.div>

      {/* Clock-in hero */}
      <div className="mb-8">
        <ClockInCard />
      </div>

      {/* Stats grid */}
      <div className="mb-8">
        <StatsGrid
          overview={overview.data}
          isLoading={overview.isLoading}
        />
      </div>

      {/* Row 1: Pending actions (the most important card per PRD §10.2) */}
      <div className="mb-8">
        <PendingActionsCard
          overview={overview.data}
          isLoading={overview.isLoading}
          onMutated={refreshOverview}
        />
      </div>

      {/* Row 2 + 3: Snapshot + Trends side-by-side on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <TodaysSnapshotCard
          overview={overview.data}
          isLoading={overview.isLoading}
        />
        <TrendsCard
          overview={overview.data}
          isLoading={overview.isLoading}
        />
      </div>

      {/* Row 4: Activity feed */}
      <div className="mb-8">
        <ActivityFeedCard />
      </div>

      {/* Setup checklist — conditional, only for fresh tenants */}
      {showSetupChecklist && <SetupChecklist />}
    </div>
  )
}

function SetupChecklist() {
  const completedCount = SETUP_STEPS.filter((s) => s.done).length
  const progress = Math.round((completedCount / SETUP_STEPS.length) * 100)

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="glass rounded-xl p-6"
    >
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-lg font-bold text-white font-gilroy">
            Get started
          </h2>
          <p className="text-sm text-brand-muted mt-1">
            Finish setting up your workspace ({completedCount}/
            {SETUP_STEPS.length} complete)
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-brand-blue font-gilroy">
            {progress}%
          </div>
        </div>
      </div>

      <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden mb-6">
        <motion.div
          className="h-full bg-brand-blue shadow-glow-blue"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.6, delay: 0.3 }}
        />
      </div>

      <div className="space-y-2">
        {SETUP_STEPS.map((step) => (
          <div
            key={step.label}
            className="flex items-center justify-between py-3 px-4 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center ${
                  step.done ? 'bg-brand-green/20' : 'border border-white/20'
                }`}
              >
                {step.done && (
                  <CheckCircle2 className="w-4 h-4 text-brand-green" />
                )}
              </div>
              <span
                className={`text-sm font-gilroy ${
                  step.done ? 'text-white/40 line-through' : 'text-white'
                }`}
              >
                {step.label}
              </span>
            </div>
            {!step.done && (
              <Button
                variant="ghost"
                size="sm"
                className="text-brand-blue hover:text-brand-blue/80"
              >
                Start <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </motion.div>
  )
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function todayLabel(): string {
  return new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
