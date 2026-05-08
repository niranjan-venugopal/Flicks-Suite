'use client'

import { motion } from 'framer-motion'
import { Users, Clock, Calendar, TrendingUp, ArrowRight, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/lib/stores/auth.store'
import { ClockInCard } from '@/components/attendance/ClockInCard'

const STATS = [
  { label: 'Total Employees', value: '—', icon: Users, accent: 'text-brand-blue', bg: 'bg-brand-blue/10' },
  { label: 'Present Today', value: '—', icon: Clock, accent: 'text-brand-green', bg: 'bg-brand-green/10' },
  { label: 'On Leave', value: '—', icon: Calendar, accent: 'text-brand-yellow', bg: 'bg-brand-yellow/10' },
  { label: 'Pending Approvals', value: '—', icon: TrendingUp, accent: 'text-brand-coral', bg: 'bg-brand-coral/10' },
]

const SETUP_STEPS = [
  { label: 'Create your workspace', done: true },
  { label: 'Invite your team', done: false },
  { label: 'Set working hours & holidays', done: false },
  { label: 'Configure leave policies', done: false },
  { label: 'Add departments & locations', done: false },
]

export default function DashboardPage() {
  const { currentUser, currentTenant } = useAuthStore()
  const firstName = currentUser?.name?.split(' ')[0] ?? 'there'
  const completedCount = SETUP_STEPS.filter((s) => s.done).length
  const progress = Math.round((completedCount / SETUP_STEPS.length) * 100)

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8"
      >
        <h1 className="text-3xl font-bold text-white font-gilroy">Welcome back, {firstName}</h1>
        <p className="text-brand-muted mt-1">
          Here's what's happening at {currentTenant?.name ?? 'your workspace'} today
        </p>
      </motion.div>

      {/* Clock-in hero (PRD §10.2) — first thing the employee sees */}
      <div className="mb-8">
        <ClockInCard />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {STATS.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="glass rounded-xl p-5"
          >
            <div className="flex items-start justify-between mb-4">
              <div className={`w-10 h-10 rounded-lg ${stat.bg} flex items-center justify-center`}>
                <stat.icon className={`w-5 h-5 ${stat.accent}`} />
              </div>
            </div>
            <div className="text-3xl font-bold text-white font-gilroy">{stat.value}</div>
            <div className="text-sm text-brand-muted mt-1">{stat.label}</div>
          </motion.div>
        ))}
      </div>

      {/* Setup checklist */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="glass rounded-xl p-6"
      >
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold text-white font-gilroy">Get started</h2>
            <p className="text-sm text-brand-muted mt-1">
              Finish setting up your workspace ({completedCount}/{SETUP_STEPS.length} complete)
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-brand-blue font-gilroy">{progress}%</div>
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
                  {step.done && <CheckCircle2 className="w-4 h-4 text-brand-green" />}
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
                <Button variant="ghost" size="sm" className="text-brand-blue hover:text-brand-blue/80">
                  Start <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  )
}
