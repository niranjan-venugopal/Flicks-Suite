'use client'

import { useAdminActivity, type ActivityItem } from '@/lib/api/queries/use-dashboard'
import { Activity, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function ActivityFeedCard() {
  const q = useAdminActivity(20)
  const items = q.data?.pages.flat() ?? []

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="w-4 h-4 text-brand-blue" />
        <h2 className="text-lg font-bold text-white font-gilroy">
          Recent activity
        </h2>
      </div>

      {q.isLoading ? (
        <ul className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <li
              key={i}
              className="h-10 rounded-md bg-white/[0.03] animate-pulse"
            />
          ))}
        </ul>
      ) : items.length === 0 ? (
        <p className="text-sm text-white/40 font-gilroy py-6 text-center">
          No activity yet — every action you take will show up here.
        </p>
      ) : (
        <>
          <ol className="relative pl-4 border-l border-white/[0.06] space-y-3">
            {items.map((it) => (
              <ActivityRow key={it.id} item={it} />
            ))}
          </ol>
          {q.hasNextPage && (
            <div className="mt-4 text-center">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
              >
                {q.isFetchingNextPage ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Loading
                  </>
                ) : (
                  'Load more'
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const sentence = humanizeAction(item)
  return (
    <li className="relative">
      <span className="absolute -left-[19px] top-1.5 w-1.5 h-1.5 rounded-full bg-brand-blue" />
      <div className="text-sm text-white/80 font-gilroy">{sentence}</div>
      <div className="text-xs text-white/40 mt-0.5 font-gilroy">
        {formatRelative(item.createdAt)}
      </div>
    </li>
  )
}

/**
 * Translates a raw audit action key (e.g. `attendance.punched_in`) into a
 * human-readable sentence. Falls back gracefully for unknown keys.
 */
function humanizeAction(it: ActivityItem): string {
  const actor = it.actorName ?? 'Someone'
  switch (it.action) {
    case 'attendance.punched_in':
      return `${actor} clocked in`
    case 'attendance.punched_out':
      return `${actor} clocked out`
    case 'attendance.regularization.requested':
      return `${actor} requested an attendance regularization`
    case 'leave.applied':
      return `${actor} applied for leave`
    case 'leave.approved':
      return `${actor} approved a leave request`
    case 'leave.rejected':
      return `${actor} rejected a leave request`
    case 'leave.cancelled':
      return `${actor} cancelled a leave request`
    case 'leave_type.created':
      return `${actor} added a leave type`
    case 'employee.invited':
      return `${actor} invited a new employee`
    case 'tenant.created':
      return `${actor} created the workspace`
    default: {
      // Fallback: strip the namespace prefix and hyphenate
      const verb = it.action
        .replace(/^[^.]+\./, '')
        .replace(/[._]/g, ' ')
        .toLowerCase()
      return `${actor} — ${verb}`
    }
  }
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime()
  const now = Date.now()
  const sec = Math.round((now - ts) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  })
}
