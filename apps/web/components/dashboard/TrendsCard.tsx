'use client'

import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { AdminOverview } from '@/lib/api/queries/use-dashboard'

export function TrendsCard({
  overview,
  isLoading,
}: {
  overview?: AdminOverview
  isLoading: boolean
}) {
  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-baseline justify-between mb-5">
        <h2 className="text-lg font-bold text-white font-gilroy">Last 30 days</h2>
        <span className="text-xs text-white/40 font-gilroy">
          {dateRangeLabel()}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-5">
        <Tile
          label="Attendance compliance"
          value={
            overview?.trends.attendanceCompliancePct == null
              ? null
              : `${overview.trends.attendanceCompliancePct.toFixed(1)}%`
          }
          target="target 95%"
          delta={
            overview?.trends.attendanceCompliancePct == null
              ? null
              : overview.trends.attendanceCompliancePct - 95
          }
          deltaUnit="pts"
          isLoading={isLoading}
        />
        <Tile
          label="Leave consumed"
          value={`${overview?.trends.leaveDaysConsumed ?? 0} days`}
          isLoading={isLoading}
        />
        <Tile
          label="Net headcount"
          value={
            overview
              ? formatNet(overview.trends.headcountDelta.net)
              : null
          }
          subtext={
            overview
              ? `+${overview.trends.headcountDelta.joiners} joiners · ${overview.trends.headcountDelta.exits} exits`
              : undefined
          }
          isLoading={isLoading}
        />
        <Tile
          label="Avg working hours"
          value={
            overview?.trends.avgWorkingHours == null
              ? null
              : `${formatHours(overview.trends.avgWorkingHours)} / day`
          }
          isLoading={isLoading}
        />
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  subtext,
  target,
  delta,
  deltaUnit,
  isLoading,
}: {
  label: string
  value: string | null
  subtext?: string
  target?: string
  delta?: number | null
  deltaUnit?: string
  isLoading: boolean
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-white/40 font-gilroy font-medium mb-1.5">
        {label}
      </div>
      {isLoading ? (
        <div className="w-24 h-7 bg-white/[0.06] rounded animate-pulse" />
      ) : value === null ? (
        <div
          className="text-2xl font-bold text-white/30 font-gilroy"
          title="Need 30 days of activity to compute trends"
        >
          —
        </div>
      ) : (
        <div className="text-2xl font-bold text-white font-gilroy tabular-nums">
          {value}
        </div>
      )}
      {!isLoading && (subtext || target || delta != null) && (
        <div className="mt-1 text-xs font-gilroy flex items-center gap-1.5 text-white/40">
          {delta != null && (
            <DeltaPill value={delta} unit={deltaUnit ?? ''} />
          )}
          {subtext}
          {target}
        </div>
      )}
    </div>
  )
}

function DeltaPill({ value, unit }: { value: number; unit: string }) {
  const Icon = value > 0 ? TrendingUp : value < 0 ? TrendingDown : Minus
  const color =
    value > 0
      ? 'text-brand-green'
      : value < 0
        ? 'text-brand-coral'
        : 'text-white/40'
  const sign = value > 0 ? '+' : ''
  return (
    <span className={`inline-flex items-center gap-1 ${color}`}>
      <Icon className="w-3 h-3" />
      {sign}
      {value.toFixed(1)}
      {unit}
    </span>
  )
}

function formatNet(n: number): string {
  if (n > 0) return `+${n}`
  return String(n)
}

function formatHours(decimalHours: number): string {
  const h = Math.floor(decimalHours)
  const m = Math.round((decimalHours - h) * 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

function dateRangeLabel(): string {
  const now = new Date()
  const past = new Date(now)
  past.setDate(now.getDate() - 30)
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  return `${fmt(past)} – ${fmt(now)}`
}
