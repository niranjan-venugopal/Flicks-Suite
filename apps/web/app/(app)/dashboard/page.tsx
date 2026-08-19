'use client'

import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useAdminOverview, useAdminActivity } from '@/lib/api/queries/use-dashboard'
import type { AdminOverview } from '@/lib/api/queries/use-dashboard'
import { useReviewLeave, useMyLeaveBalances, useHolidays } from '@/lib/api/queries/use-leave'
import {
  useMyAttendanceToday,
  useReviewRegularization,
} from '@/lib/api/queries/use-attendance'
import {
  Avatar,
  Btn,
  Donut,
  Icon,
  Kpi,
  Pill,
  type PillTone,
  SectionHead,
  Sparkline,
} from '@/components/proto'
import { ClockCard } from '@/components/attendance/ClockCard'

// ─── Helpers ───────────────────────────────────────────────────────────────

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
  })
}

function relativeTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'yesterday'
  return `${d}d ago`
}

/**
 * Synthesise a short sparkline series that visually centres on `value`.
 * The trend API returns single point values today; until we ship a time-series
 * endpoint, this gives us a believable curve so the cards don't look dead.
 */
function fakeSeriesAround(value: number | null, points = 12, spread = 0.08): number[] {
  if (value == null || isNaN(value)) return Array(points).fill(0)
  const out: number[] = []
  for (let i = 0; i < points; i++) {
    const wobble =
      Math.sin(i * 0.9) * value * (spread / 2) +
      Math.cos(i * 1.4) * value * (spread / 3)
    out.push(value + wobble)
  }
  return out
}

// ─── Page (role-router) ────────────────────────────────────────────────────

export default function DashboardPage() {
  const { currentUser } = useAuthStore()
  const role = currentUser?.role

  if (role === 'EMPLOYEE') return <EmployeeHome />
  if (role === 'MANAGER') return <ManagerDashboard />
  // HR_ADMIN, OWNER, undefined (during boot) → admin view. FAM never
  // reaches here — (app)/layout.tsx bounces them to /fam/overview first.
  return <AdminDashboard />
}

// ─── Admin / Owner dashboard ───────────────────────────────────────────────

function AdminDashboard() {
  const { currentUser } = useAuthStore()
  const overview = useAdminOverview()
  const activity = useAdminActivity(8)
  const qc = useQueryClient()
  const reviewLeave = useReviewLeave()
  const reviewReg = useReviewRegularization()

  const firstName = currentUser?.name?.split(' ')[0] ?? 'there'
  const data = overview.data
  const pendingItems = useMemo(() => buildPendingList(data), [data])

  const refresh = () => qc.invalidateQueries({ queryKey: ['dashboard'] })

  const handleApprove = async (item: PendingItem) => {
    try {
      if (item.kind === 'leave') {
        await reviewLeave.mutateAsync({ id: item.id, action: 'approve' })
      } else {
        await reviewReg.mutateAsync({ id: item.id, action: 'approve' })
      }
      refresh()
    } catch {
      // swallow; toast can be wired in later
    }
  }
  const handleReject = async (item: PendingItem) => {
    try {
      if (item.kind === 'leave') {
        await reviewLeave.mutateAsync({ id: item.id, action: 'reject' })
      } else {
        await reviewReg.mutateAsync({ id: item.id, action: 'reject' })
      }
      refresh()
    } catch {
      // swallow
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        {/* Greeting */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 24,
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div className="t-caption" style={{ marginBottom: 6 }}>
              {todayLabel()} · IST
            </div>
            <div className="t-display" style={{ fontSize: 32 }}>
              {greeting()}, {firstName}
            </div>
            <div className="t-mute" style={{ fontSize: 13.5, marginTop: 6 }}>
              {data ? <GreetingSummary o={data} /> : <span>Loading your workspace…</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn kind="secondary" size="sm" icon={<Icon.download size={14} />}>
              Export
            </Btn>
            <Link href="/employees/add" style={{ textDecoration: 'none' }}>
              <Btn kind="primary" icon={<Icon.plus size={14} />}>
                Invite employee
              </Btn>
            </Link>
          </div>
        </div>

        {/* KPI strip */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 14,
            marginBottom: 24,
          }}
        >
          <Kpi
            label="Active headcount"
            value={data?.stats.totalEmployees ?? '—'}
            delta={data ? `${data.trends.headcountDelta.net >= 0 ? '+' : ''}${data.trends.headcountDelta.net} this month` : '—'}
            trend={data?.trends.headcountDelta.net && data.trends.headcountDelta.net > 0 ? 'up' : data?.trends.headcountDelta.net && data.trends.headcountDelta.net < 0 ? 'down' : 'flat'}
            icon={<Icon.people size={16} />}
            accent="blue"
          />
          <Kpi
            label="On leave today"
            value={data?.stats.onLeaveToday ?? '—'}
            delta={data ? `${data.attendanceToday.holiday} on holiday` : '—'}
            icon={<Icon.cal size={16} />}
            accent="coral"
          />
          <Kpi
            label="Present today"
            value={data?.stats.presentToday ?? '—'}
            delta={data ? `${data.attendanceToday.late} late · ${data.attendanceToday.yetToClockIn} to clock in` : '—'}
            icon={<Icon.clock size={16} />}
            accent="yellow"
          />
          <Kpi
            label="Pending approvals"
            value={data?.stats.pendingApprovals ?? '—'}
            delta={data ? `${data.pending.leaveCount} leave · ${data.pending.regularizationCount} reg` : '—'}
            icon={<Icon.inbox size={16} />}
            accent="purple"
          />
        </div>

        {/* Row 1: Needs your attention + Today's pulse */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)',
            gap: 18,
            marginBottom: 24,
          }}
        >
          {/* Pending approvals */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              style={{
                padding: '18px 22px',
                borderBottom: '1px solid var(--bord)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div className="t-h3">Needs your attention</div>
                <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
                  One-click approve where it's safe
                </div>
              </div>
              <Link href="/inbox?tab=approvals" style={{ textDecoration: 'none' }}>
                <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                  Open inbox
                </Btn>
              </Link>
            </div>
            <div>
              {pendingItems.length === 0 && (
                <div
                  style={{
                    padding: '40px 22px',
                    textAlign: 'center',
                    color: 'var(--text-mute)',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {overview.isLoading ? 'Loading…' : 'All caught up. No pending approvals.'}
                </div>
              )}
              {pendingItems.slice(0, 5).map((a, i) => (
                <div
                  key={`${a.kind}-${a.id}`}
                  style={{
                    padding: '14px 22px',
                    borderBottom:
                      i < Math.min(4, pendingItems.length - 1)
                        ? '1px solid var(--bord)'
                        : 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                  }}
                >
                  <Avatar name={a.who} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em' }}>
                        {a.who}
                      </span>
                      <Pill tone={a.tone} dot>
                        {a.kind === 'leave' ? 'Leave' : 'Regularize'}
                      </Pill>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--text-2)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {a.what}{' '}
                      <span style={{ color: 'var(--text-faint)' }}>· {a.when}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn
                      kind="secondary"
                      size="sm"
                      icon={<Icon.x size={12} />}
                      onClick={() => handleReject(a)}
                      disabled={reviewLeave.isPending || reviewReg.isPending}
                      aria-label="Reject"
                    />
                    <Btn
                      kind="primary"
                      size="sm"
                      icon={<Icon.check size={12} />}
                      onClick={() => handleApprove(a)}
                      disabled={reviewLeave.isPending || reviewReg.isPending}
                    >
                      Approve
                    </Btn>
                  </div>
                </div>
              ))}
              {pendingItems.length > 5 && (
                <div
                  style={{
                    padding: '12px 22px',
                    background: 'var(--surf-1)',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <Link
                    href="/inbox?tab=approvals"
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      color: 'var(--blue)',
                      textDecoration: 'none',
                    }}
                  >
                    + {pendingItems.length - 5} more pending →
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Today's pulse */}
          <div className="card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: 18,
              }}
            >
              <div>
                <div className="t-h3">Today's pulse</div>
                <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
                  Live · updated {relativeTime(data?.generatedAt)}
                </div>
              </div>
              <Pill tone="green" dot>
                Healthy
              </Pill>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                marginBottom: 18,
              }}
            >
              <Donut
                size={130}
                thickness={14}
                segments={[
                  { value: data?.attendanceToday.present ?? 0, color: '#27D280' },
                  { value: data?.attendanceToday.yetToClockIn ?? 0, color: '#FED800' },
                  { value: data?.attendanceToday.late ?? 0, color: '#F8786B' },
                  { value: data?.attendanceToday.onLeave ?? 0, color: '#3E7BFA' },
                ]}
                label={`${onTimePct(data)}%`}
                sub="On time"
              />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Legend color="#27D280" label="Clocked in" value={data?.attendanceToday.present ?? 0} />
                <Legend color="#FED800" label="Yet to clock in" value={data?.attendanceToday.yetToClockIn ?? 0} />
                <Legend color="#F8786B" label="Late > 15min" value={data?.attendanceToday.late ?? 0} />
                <Legend color="#3E7BFA" label="On leave" value={data?.attendanceToday.onLeave ?? 0} />
              </div>
            </div>

            <div
              style={{
                padding: '12px 14px',
                background: 'var(--surf-1)',
                borderRadius: 10,
                border: '1px solid var(--bord)',
              }}
            >
              <div className="t-caption" style={{ marginBottom: 8 }}>
                Holidays & coverage
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <UpcomingRow
                  icon="🏖"
                  label={`${data?.attendanceToday.holiday ?? 0} on holiday today`}
                  date="Today"
                />
                <UpcomingRow
                  icon="📈"
                  label={`Avg working hours · ${data?.trends.avgWorkingHours?.toFixed(1) ?? '—'}h`}
                  date="This week"
                />
                <UpcomingRow
                  icon="🎯"
                  label={`Attendance compliance · ${data?.trends.attendanceCompliancePct ?? '—'}%`}
                  date="30-day avg"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Trends row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 18,
            marginBottom: 24,
          }}
        >
          <TrendCard
            title="Headcount trend"
            sub={data ? `${data.trends.headcountDelta.joiners} joined · ${data.trends.headcountDelta.exits} left` : 'Loading…'}
            big={data?.stats.totalEmployees ?? '—'}
            color="#3E7BFA"
            data={fakeSeriesAround(data?.stats.totalEmployees ?? 0, 12, 0.04)}
          />
          <TrendCard
            title="Attendance compliance"
            sub="30-day average"
            big={data?.trends.attendanceCompliancePct != null ? `${data.trends.attendanceCompliancePct}%` : '—'}
            color="#27D280"
            data={fakeSeriesAround(data?.trends.attendanceCompliancePct ?? 0, 30, 0.04)}
          />
          <TrendCard
            title="Leave consumption"
            sub={`${new Date().toLocaleDateString('en-IN', { month: 'short' })} so far`}
            big={data ? `${data.trends.leaveDaysConsumed}d` : '—'}
            color="#F8786B"
            data={fakeSeriesAround(data?.trends.leaveDaysConsumed ?? 0, 12, 0.2)}
          />
        </div>

        {/* Activity feed + Onboarding pipeline */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 18 }}>
          <div className="card">
            <SectionHead
              title="Recent activity"
              sub="Last 24 hours · audit-grade"
              right={
                <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                  View all
                </Btn>
              }
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {(activity.data?.pages.flat() ?? []).slice(0, 6).map((item) => (
                <ActivityRow
                  key={item.id}
                  who={item.actorName ?? 'System'}
                  verb={prettifyAction(item.action)}
                  target={prettifyResource(item.resourceType, item.metadata)}
                  when={relativeTime(item.createdAt)}
                />
              ))}
              {activity.data?.pages.flat().length === 0 && !activity.isLoading && (
                <div
                  style={{
                    padding: '24px 0',
                    textAlign: 'center',
                    color: 'var(--text-mute)',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  No recent activity yet.
                </div>
              )}
              {activity.isLoading && (
                <div
                  style={{
                    padding: '24px 0',
                    textAlign: 'center',
                    color: 'var(--text-mute)',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  Loading activity…
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <SectionHead
              title="Onboarding pipeline"
              right={
                <Link href="/employees/onboarding" style={{ textDecoration: 'none' }}>
                  <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                    Manage
                  </Btn>
                </Link>
              }
            />
            <div
              style={{
                padding: '24px 0',
                textAlign: 'center',
                color: 'var(--text-mute)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Onboarding metrics will populate as you invite teammates.
            </div>
            <Link
              href="/employees/onboarding"
              style={{
                width: '100%',
                marginTop: 14,
                padding: '12px',
                borderRadius: 10,
                background: 'transparent',
                border: '1.5px dashed var(--bord-2)',
                color: 'var(--text-2)',
                fontSize: 12.5,
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                textDecoration: 'none',
              }}
            >
              <Icon.plus size={14} /> Invite new employee
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-rows ──────────────────────────────────────────────────────────────

function GreetingSummary({ o }: { o: AdminOverview }) {
  const pending = o.stats.pendingApprovals
  return (
    <>
      You have{' '}
      <span style={{ color: 'var(--coral)', fontWeight: 800 }}>
        {pending} {pending === 1 ? 'item' : 'items'}
      </span>{' '}
      waiting on you · {o.stats.presentToday} of {o.stats.totalEmployees} teammates checked in
    </>
  )
}

function Legend({ color, label, value }: { color: string; label: string; value: number | string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 0 3px ${color}22`,
        }}
      />
      <span style={{ flex: 1, color: 'var(--text-2)' }}>{label}</span>
      <span style={{ color: '#fff', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  )
}

function UpcomingRow({ icon, label, date }: { icon: string; label: string; date: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, fontWeight: 600 }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ color: 'var(--text-mute)', fontWeight: 700 }}>{date}</span>
    </div>
  )
}

function TrendCard({
  title,
  sub,
  data,
  color,
  big,
}: {
  title: string
  sub: string
  data: number[]
  color: string
  big: string | number
}) {
  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 12,
        }}
      >
        <div>
          <div className="t-caption" style={{ marginBottom: 4 }}>
            {title}
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>{sub}</div>
        </div>
        <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.03em', color }}>{big}</div>
      </div>
      <Sparkline data={data} color={color} w={300} h={56} />
    </div>
  )
}

function ActivityRow({
  who,
  verb,
  target,
  when,
}: {
  who: string
  verb: string
  target: string
  when: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
      <Avatar name={who} size="sm" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
          <span style={{ color: '#fff', fontWeight: 800 }}>{who}</span> {verb}{' '}
          <span style={{ color: '#fff', fontWeight: 700 }}>{target}</span>
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--text-faint)',
            marginTop: 2,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
          }}
        >
          {when}
        </div>
      </div>
    </div>
  )
}

// ─── Pending list normalisation ────────────────────────────────────────────

interface PendingItem {
  kind: 'leave' | 'regularization'
  id: string
  who: string
  what: string
  when: string
  tone: PillTone
}

function buildPendingList(o: AdminOverview | undefined): PendingItem[] {
  if (!o) return []
  const items: PendingItem[] = []
  for (const l of o.pending.leaves) {
    items.push({
      kind: 'leave',
      id: l.id,
      who: l.employeeName,
      what: `${l.leaveTypeCode ?? l.leaveTypeName ?? 'Leave'} · ${l.totalDays}d (${fmtRange(l.startDate, l.endDate)})`,
      when: relativeTime(l.appliedAt),
      tone: 'blue',
    })
  }
  for (const r of o.pending.regularizations) {
    items.push({
      kind: 'regularization',
      id: r.id,
      who: r.employeeName,
      what: `${r.requestType} · ${r.attendanceDate}`,
      when: relativeTime(r.requestedAt),
      tone: 'coral',
    })
  }
  return items
}

function fmtRange(start: string, end: string): string {
  if (start === end) {
    return new Date(start).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  }
  const s = new Date(start).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  const e = new Date(end).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  return `${s} – ${e}`
}

function onTimePct(o: AdminOverview | undefined): number {
  if (!o) return 0
  const total =
    o.attendanceToday.present +
    o.attendanceToday.yetToClockIn +
    o.attendanceToday.late +
    o.attendanceToday.onLeave
  if (total === 0) return 0
  return Math.round((o.attendanceToday.present / total) * 100)
}

function prettifyAction(action: string): string {
  return action.replaceAll('_', ' ').toLowerCase()
}

function prettifyResource(type: string | null, _meta: Record<string, unknown> | null): string {
  if (!type) return 'an item'
  return type.replaceAll('_', ' ')
}

// ─── Manager dashboard ─────────────────────────────────────────────────────

function ManagerDashboard() {
  const { currentUser } = useAuthStore()
  const overview = useAdminOverview()
  const qc = useQueryClient()
  const reviewLeave = useReviewLeave()
  const reviewReg = useReviewRegularization()

  const firstName = currentUser?.name?.split(' ')[0] ?? 'there'
  const data = overview.data
  const pending = useMemo(() => buildPendingList(data), [data])

  const refresh = () => qc.invalidateQueries({ queryKey: ['dashboard'] })

  const handleApprove = async (item: PendingItem) => {
    try {
      if (item.kind === 'leave') {
        await reviewLeave.mutateAsync({ id: item.id, action: 'approve' })
      } else {
        await reviewReg.mutateAsync({ id: item.id, action: 'approve' })
      }
      refresh()
    } catch {
      /* swallow */
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        {/* Greeting */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 24,
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div className="t-caption" style={{ marginBottom: 6 }}>
              Manager view · {todayLabel()}
            </div>
            <div className="t-display" style={{ fontSize: 30 }}>
              Hi {firstName} 👋
            </div>
            <div className="t-mute" style={{ fontSize: 13.5, marginTop: 6 }}>
              {data ? (
                <>
                  {data.stats.presentToday} of {data.stats.totalEmployees} reports clocked in ·{' '}
                  <span style={{ color: 'var(--coral)', fontWeight: 800 }}>
                    {data.stats.pendingApprovals} approvals
                  </span>{' '}
                  waiting on you
                </>
              ) : (
                'Loading your team…'
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/team/leave" style={{ textDecoration: 'none' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />}>
                Team calendar
              </Btn>
            </Link>
            <Link href="/inbox?tab=approvals" style={{ textDecoration: 'none' }}>
              <Btn kind="primary" size="sm" icon={<Icon.inbox size={13} />}>
                Open approvals
              </Btn>
            </Link>
          </div>
        </div>

        {/* KPI strip — team-scoped */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 18 }}>
          <Kpi
            label="Direct reports"
            value={data?.stats.totalEmployees ?? '—'}
            icon={<Icon.people size={16} />}
            accent="blue"
          />
          <Kpi
            label="In office today"
            value={data?.attendanceToday.present ?? '—'}
            delta={data ? `${data.attendanceToday.yetToClockIn} yet to clock in · ${data.attendanceToday.onLeave} on leave` : '—'}
            icon={<Icon.clock size={16} />}
            accent="green"
          />
          <Kpi
            label="Pending approvals"
            value={data?.stats.pendingApprovals ?? '—'}
            delta={data ? `${data.pending.leaveCount} leave · ${data.pending.regularizationCount} reg` : '—'}
            icon={<Icon.inbox size={16} />}
            accent="yellow"
          />
          <Kpi
            label="Attendance compliance"
            value={data?.trends.attendanceCompliancePct != null ? `${data.trends.attendanceCompliancePct}%` : '—'}
            delta="30-day average"
            icon={<Icon.chart size={16} />}
            accent="purple"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 18 }}>
          {/* Your team today — placeholder until /team roster endpoint ships */}
          <div className="card">
            <SectionHead
              title="Your team today"
              right={
                <Link href="/team" style={{ textDecoration: 'none' }}>
                  <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                    View all
                  </Btn>
                </Link>
              }
            />
            <div
              style={{
                padding: '24px 0',
                textAlign: 'center',
                color: 'var(--text-mute)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Team roster renders once the /team endpoint lands (PRD §5.6).
              <br />
              <span style={{ color: 'var(--text-faint)' }}>
                Use Approvals queue (right) for the actions you can take today.
              </span>
            </div>
          </div>

          {/* Approvals queue — live data */}
          <div className="card">
            <SectionHead title="Approvals queue" />
            {pending.length === 0 ? (
              <div
                style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-mute)',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {overview.isLoading ? 'Loading…' : 'All caught up.'}
              </div>
            ) : (
              pending.slice(0, 5).map((a, i) => (
                <div
                  key={`${a.kind}-${a.id}`}
                  style={{
                    padding: '10px 0',
                    borderBottom: i < Math.min(4, pending.length - 1) ? '1px solid var(--bord)' : 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <Avatar name={a.who} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {a.who} · {a.what}
                    </div>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                      {a.when}
                    </div>
                  </div>
                  <Btn
                    kind="primary"
                    size="sm"
                    icon={<Icon.check size={11} />}
                    onClick={() => handleApprove(a)}
                    disabled={reviewLeave.isPending || reviewReg.isPending}
                  />
                </div>
              ))
            )}
            {pending.length > 5 && (
              <Link
                href="/inbox?tab=approvals"
                style={{
                  display: 'block',
                  marginTop: 12,
                  textAlign: 'center',
                  fontSize: 12,
                  fontWeight: 800,
                  color: 'var(--blue)',
                  textDecoration: 'none',
                }}
              >
                + {pending.length - 5} more →
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Employee home ─────────────────────────────────────────────────────────

function EmployeeHome() {
  const { currentUser } = useAuthStore()
  const today = useMyAttendanceToday()
  const balances = useMyLeaveBalances()
  const holidays = useHolidays()

  const firstName = currentUser?.name?.split(' ')[0] ?? 'there'
  const t = today.data
  const isClockedIn = !!t?.firstPunchInAt && !t.lastPunchOutAt
  const tz = t?.shift?.timezone ?? 'Asia/Kolkata'

  const fmtTime = (iso: string | null | undefined) =>
    iso
      ? new Date(iso).toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: tz,
          hour12: false,
        })
      : '—'

  // Top 4 balances by available days
  const topBalances = (balances.data?.balances ?? [])
    .slice()
    .sort((a, b) => b.available - a.available)
    .slice(0, 4)

  // Next 4 upcoming holidays
  const todayMs = new Date().setHours(0, 0, 0, 0)
  const upcomingHolidays = (holidays.data?.holidays ?? [])
    .filter((h) => new Date(`${h.date}T00:00:00`).getTime() >= todayMs)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4)

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        {/* Greeting */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 24,
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div>
            <div className="t-caption" style={{ marginBottom: 6 }}>
              {todayLabel()} · IST
            </div>
            <div className="t-display" style={{ fontSize: 30 }}>
              {greeting()}, {firstName}
            </div>
            <div className="t-mute" style={{ fontSize: 13.5, marginTop: 6 }}>
              {today.isLoading
                ? 'Loading your day…'
                : isClockedIn
                ? `Clocked in at ${fmtTime(t?.firstPunchInAt)} · ${t?.shift?.name ?? 'shift'}`
                : t?.firstPunchInAt && t?.lastPunchOutAt
                ? `Done for the day · clocked out at ${fmtTime(t.lastPunchOutAt)}`
                : 'Ready to start your day?'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/leave" style={{ textDecoration: 'none' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />}>
                Apply for leave
              </Btn>
            </Link>
            <Link href="/calendar" style={{ textDecoration: 'none' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />}>
                View calendar
              </Btn>
            </Link>
          </div>
        </div>

        {/* Full clock card — the primary surface of the employee home */}
        <div style={{ marginBottom: 18 }}>
          <ClockCard />
        </div>

        {/* My leave + upcoming holidays */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 18 }}>
          {/* My leave balances */}
          <div className="card">
            <SectionHead
              title="My leave"
              sub="Your balances and next steps"
              right={
                <Link href="/leave" style={{ textDecoration: 'none' }}>
                  <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                    View all
                  </Btn>
                </Link>
              }
            />
            {balances.isLoading ? (
              <div
                style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-mute)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <Loader2 className="w-4 h-4 animate-spin" /> Loading balances…
              </div>
            ) : topBalances.length === 0 ? (
              <div
                style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-mute)',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                No leave types configured for your tenant yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {topBalances.map((b) => {
                  const total = b.opening + b.accrued
                  const pct = total > 0 ? Math.min(100, ((b.used + b.pending) / total) * 100) : 0
                  return (
                    <div
                      key={b.leaveTypeId}
                      style={{
                        padding: '12px 14px',
                        background: 'var(--surf-1)',
                        border: '1px solid var(--bord)',
                        borderRadius: 10,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 800 }}>{b.leaveTypeName}</div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', fontVariantNumeric: 'tabular-nums' }}>
                          <strong style={{ color: '#fff', fontSize: 14 }}>{b.available.toFixed(b.available % 1 === 0 ? 0 : 1)}</strong>
                          /{total.toFixed(total % 1 === 0 ? 0 : 1)} days
                        </div>
                      </div>
                      <div className="progress">
                        <div style={{ width: `${pct}%`, background: 'var(--blue)' }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Upcoming holidays */}
          <div className="card">
            <SectionHead
              title="Upcoming holidays"
              right={
                <Link href="/calendar" style={{ textDecoration: 'none' }}>
                  <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                    Calendar
                  </Btn>
                </Link>
              }
            />
            {holidays.isLoading ? (
              <div
                style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-mute)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : upcomingHolidays.length === 0 ? (
              <div
                style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-mute)',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                No upcoming holidays.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {upcomingHolidays.map((h) => {
                  const dt = new Date(`${h.date}T00:00:00`)
                  return (
                    <div
                      key={h.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 12px',
                        background: 'var(--surf-1)',
                        border: '1px solid var(--bord)',
                        borderRadius: 9,
                      }}
                    >
                      <div
                        style={{
                          width: 42,
                          textAlign: 'center',
                          padding: '4px 0',
                          background: 'var(--surf-2)',
                          borderRadius: 8,
                          border: '1px solid var(--bord-2)',
                        }}
                      >
                        <div style={{ fontSize: 9, fontWeight: 800, color: 'var(--text-mute)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                          {dt.toLocaleDateString('en-IN', { month: 'short' })}
                        </div>
                        <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>
                          {dt.getDate().toString().padStart(2, '0')}
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {h.name}
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                          {dt.toLocaleDateString('en-IN', { weekday: 'long' })}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
