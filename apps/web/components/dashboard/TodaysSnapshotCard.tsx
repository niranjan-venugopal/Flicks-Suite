'use client'

import { useMemo } from 'react'
import { Users, Clock, Sparkles } from 'lucide-react'
import { useCalendarEvents } from '@/lib/api/queries/use-calendar'
import type { AdminOverview } from '@/lib/api/queries/use-dashboard'

export function TodaysSnapshotCard({
  overview,
  isLoading,
}: {
  overview?: AdminOverview
  isLoading: boolean
}) {
  // PRD §10.2 Row 2 "Upcoming this week" — pull from the calendar feed for
  // the next 7 days. Reuses the Step 4 hook + endpoint.
  const range = useMemo(() => {
    const today = new Date()
    const weekOut = new Date(today)
    weekOut.setDate(today.getDate() + 7)
    return {
      from: today.toISOString().slice(0, 10),
      to: weekOut.toISOString().slice(0, 10),
    }
  }, [])
  const events = useCalendarEvents(range.from, range.to)
  const upcoming = events.data?.slice(0, 4) ?? []

  return (
    <div className="glass rounded-xl p-6">
      <h2 className="text-lg font-bold text-white font-gilroy mb-4">
        Today's snapshot
      </h2>

      <div className="space-y-5">
        <Section icon={Users} title="Headcount" iconClass="text-brand-blue">
          {isLoading || !overview ? (
            <SkeletonLine />
          ) : (
            <span className="text-sm font-gilroy text-white/70 tabular-nums">
              <span className="text-white">{overview.headcount.active}</span>{' '}
              active
              {overview.headcount.notice > 0 && (
                <>
                  {' · '}
                  <span className="text-white">
                    {overview.headcount.notice}
                  </span>{' '}
                  on notice
                </>
              )}
              {overview.headcount.onLeave > 0 && (
                <>
                  {' · '}
                  <span className="text-white">
                    {overview.headcount.onLeave}
                  </span>{' '}
                  on leave
                </>
              )}
            </span>
          )}
        </Section>

        <Section
          icon={Clock}
          title="Attendance today"
          iconClass="text-brand-green"
        >
          {isLoading || !overview ? (
            <SkeletonLine />
          ) : overview.attendanceToday.holiday > 0 ? (
            <span className="text-sm text-brand-yellow font-gilroy">
              Holiday today — no attendance expected
            </span>
          ) : (
            <span className="text-sm font-gilroy text-white/70 tabular-nums">
              <span className="text-white">
                {overview.attendanceToday.present}
              </span>{' '}
              clocked in
              {overview.attendanceToday.late > 0 && (
                <>
                  {' · '}
                  <span className="text-brand-yellow">
                    {overview.attendanceToday.late}
                  </span>{' '}
                  late
                </>
              )}
              {overview.attendanceToday.yetToClockIn > 0 && (
                <>
                  {' · '}
                  <span className="text-white">
                    {overview.attendanceToday.yetToClockIn}
                  </span>{' '}
                  yet to clock in
                </>
              )}
              {overview.attendanceToday.onLeave > 0 && (
                <>
                  {' · '}
                  <span className="text-white">
                    {overview.attendanceToday.onLeave}
                  </span>{' '}
                  on leave
                </>
              )}
            </span>
          )}
        </Section>

        <Section
          icon={Sparkles}
          title="Upcoming this week"
          iconClass="text-brand-yellow"
        >
          {events.isLoading ? (
            <SkeletonLine />
          ) : upcoming.length === 0 ? (
            <span className="text-sm text-white/40 font-gilroy">
              Nothing on the calendar this week.
            </span>
          ) : (
            <ul className="space-y-1.5">
              {upcoming.map((e) => (
                <li
                  key={e.id}
                  className="text-sm font-gilroy flex items-center gap-2"
                >
                  <span className="text-white/40 tabular-nums shrink-0">
                    {formatDayShort(e.startDate)}
                  </span>
                  <span className="text-white/80 truncate">{e.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

function Section({
  icon: Icon,
  iconClass,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  iconClass: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className={`w-3.5 h-3.5 ${iconClass}`} />
        <span className="text-xs uppercase tracking-wider text-white/40 font-gilroy font-medium">
          {title}
        </span>
      </div>
      <div className="pl-5">{children}</div>
    </div>
  )
}

function SkeletonLine() {
  return (
    <span className="inline-block w-44 h-4 bg-white/[0.06] rounded animate-pulse" />
  )
}

function formatDayShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}
