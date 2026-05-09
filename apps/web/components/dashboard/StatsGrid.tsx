'use client'

import { motion } from 'framer-motion'
import { Users, Clock, Calendar, TrendingUp, type LucideIcon } from 'lucide-react'
import type { AdminOverview } from '@/lib/api/queries/use-dashboard'

interface StatTile {
  label: string
  value: string | number
  icon: LucideIcon
  accent: string
  bg: string
  href?: string
}

export function StatsGrid({
  overview,
  isLoading,
}: {
  overview?: AdminOverview
  isLoading: boolean
}) {
  const tiles: StatTile[] = [
    {
      label: 'Total Employees',
      value: overview?.stats.totalEmployees ?? 0,
      icon: Users,
      accent: 'text-brand-blue',
      bg: 'bg-brand-blue/10',
    },
    {
      label: 'Present Today',
      value: overview?.stats.presentToday ?? 0,
      icon: Clock,
      accent: 'text-brand-green',
      bg: 'bg-brand-green/10',
    },
    {
      label: 'On Leave',
      value: overview?.stats.onLeaveToday ?? 0,
      icon: Calendar,
      accent: 'text-brand-yellow',
      bg: 'bg-brand-yellow/10',
    },
    {
      label: 'Pending Approvals',
      value: overview?.stats.pendingApprovals ?? 0,
      icon: TrendingUp,
      accent: 'text-brand-coral',
      bg: 'bg-brand-coral/10',
    },
  ]

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {tiles.map((tile, i) => (
        <motion.div
          key={tile.label}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="glass rounded-xl p-5"
        >
          <div className="flex items-start justify-between mb-4">
            <div
              className={`w-10 h-10 rounded-lg ${tile.bg} flex items-center justify-center`}
            >
              <tile.icon className={`w-5 h-5 ${tile.accent}`} />
            </div>
          </div>
          <div className="text-3xl font-bold text-white font-gilroy tabular-nums">
            {isLoading ? (
              <span className="inline-block w-12 h-7 bg-white/[0.06] rounded animate-pulse" />
            ) : (
              tile.value
            )}
          </div>
          <div className="text-sm text-brand-muted mt-1">{tile.label}</div>
        </motion.div>
      ))}
    </div>
  )
}
