'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  useAllNotifications,
  useMarkAllRead,
  useMarkRead,
  useUnreadNotifications,
  type NotificationItem,
} from '@/lib/api/queries/use-notifications'
import { timeAgo } from '@/lib/utils'

function iconFor(type: string) {
  if (type.startsWith('timesheet.')) return <Icon.sheet size={16} />
  if (type.startsWith('leave.')) return <Icon.cal size={16} />
  if (type.startsWith('regularization.')) return <Icon.clock size={16} />
  if (type.startsWith('onboarding.')) return <Icon.people size={16} />
  return <Icon.bell size={16} />
}

export default function NotificationsPage() {
  const router = useRouter()
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [page, setPage] = useState(1)
  const pageSize = 20
  const list = useAllNotifications(filter, page, pageSize)
  const unread = useUnreadNotifications()
  const markRead = useMarkRead()
  const markAllRead = useMarkAllRead()

  const items: NotificationItem[] = list.data?.items ?? []
  const total = list.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const unreadTotal = unread.data?.total ?? 0

  const handleRowClick = async (n: NotificationItem) => {
    if (!n.readAt) {
      try {
        await markRead.mutateAsync(n.id)
      } catch {
        /* ignore */
      }
    }
    if (n.linkUrl) router.push(n.linkUrl)
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 880, margin: '0 auto' }}>
        <SectionHead
          title="Notifications"
          sub={
            unreadTotal > 0
              ? `${unreadTotal} unread`
              : "You're all caught up."
          }
          right={
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.check size={13} />}
              onClick={() => markAllRead.mutate()}
              disabled={unreadTotal === 0 || markAllRead.isPending}
            >
              {markAllRead.isPending ? 'Marking…' : 'Mark all read'}
            </Btn>
          }
        />

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['all', 'unread'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setFilter(k)
                setPage(1)
              }}
              style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
            >
              <Pill
                tone={filter === k ? 'blue' : ''}
                dot={filter === k}
              >
                {k === 'all' ? 'All' : `Unread${unreadTotal ? ` · ${unreadTotal}` : ''}`}
              </Pill>
            </button>
          ))}
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {list.isLoading ? (
            <div
              style={{
                padding: 48,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: 'var(--text-mute)',
              }}
            >
              <Loader2 className="w-4 h-4 animate-spin" /> Loading notifications…
            </div>
          ) : items.length === 0 ? (
            <div
              style={{
                padding: '60px 20px',
                textAlign: 'center',
                color: 'var(--text-mute)',
              }}
            >
              <Icon.success size={28} style={{ marginBottom: 10, opacity: 0.6 }} />
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {filter === 'unread'
                  ? 'No unread notifications.'
                  : 'No notifications yet.'}
              </div>
              <div style={{ fontSize: 11.5, marginTop: 4 }}>
                Approvals, timesheet decisions and other updates will show up here.
              </div>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {items.map((n) => (
                <li
                  key={n.id}
                  style={{
                    borderBottom: '1px solid var(--bord)',
                    background: n.readAt ? 'transparent' : 'rgba(62,123,250,.04)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => handleRowClick(n)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      gap: 14,
                      padding: '16px 18px',
                      background: 'transparent',
                      border: 0,
                      cursor: 'pointer',
                      textAlign: 'left',
                      alignItems: 'flex-start',
                      color: 'var(--text)',
                    }}
                  >
                    <div
                      style={{
                        flex: '0 0 32px',
                        width: 32,
                        height: 32,
                        borderRadius: 9,
                        background: 'var(--surf-2)',
                        border: '1px solid var(--bord)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-2)',
                      }}
                    >
                      {iconFor(n.type)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.45 }}>
                        {n.message}
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          display: 'flex',
                          gap: 10,
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--text-mute)',
                        }}
                      >
                        <span>{timeAgo(n.createdAt)}</span>
                        <span>·</span>
                        <span>{n.type}</span>
                      </div>
                    </div>
                    {!n.readAt && (
                      <div
                        style={{
                          flex: '0 0 8px',
                          width: 8,
                          height: 8,
                          marginTop: 10,
                          borderRadius: '50%',
                          background: 'var(--blue)',
                        }}
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Pagination */}
          {items.length > 0 && totalPages > 1 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 18px',
                borderTop: '1px solid var(--bord)',
                background: 'var(--surf-0)',
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                Page {page} of {totalPages} · {total} total
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn
                  kind="ghost"
                  size="sm"
                  icon={<Icon.chevL size={12} />}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || list.isFetching}
                >
                  Prev
                </Btn>
                <Btn
                  kind="ghost"
                  size="sm"
                  iconRight={<Icon.chevR size={12} />}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || list.isFetching}
                >
                  Next
                </Btn>
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--text-mute)' }}>
          Want to control which events trigger a notification?{' '}
          <Link href="/settings/notifications" style={{ color: 'var(--blue)', fontWeight: 700 }}>
            Open notification preferences →
          </Link>
        </div>
      </div>
    </div>
  )
}
