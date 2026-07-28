'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Btn, Icon, Pill } from '@/components/proto'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  useMarkAllRead,
  useMarkRead,
  useUnreadNotifications,
  type NotificationItem,
} from '@/lib/api/queries/use-notifications'
import { timeAgo } from '@/lib/utils'

// Maps the notification type prefix to a glyph from the proto Icon set.
function iconFor(type: string) {
  if (type.startsWith('timesheet.')) return <Icon.sheet size={14} />
  if (type.startsWith('leave.')) return <Icon.cal size={14} />
  if (type.startsWith('regularization.')) return <Icon.clock size={14} />
  if (type.startsWith('onboarding.')) return <Icon.people size={14} />
  return <Icon.bell size={14} />
}

export function NotificationsBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const unread = useUnreadNotifications()
  const markRead = useMarkRead()
  const markAllRead = useMarkAllRead()

  // Force a refetch the moment the popover opens so the list reflects the very
  // latest unread notifications even if the real-time socket missed a push.
  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void unread.refetch()
  }

  const items: NotificationItem[] = unread.data?.items ?? []
  const total = unread.data?.total ?? 0

  const handleRowClick = async (n: NotificationItem) => {
    setOpen(false)
    try {
      if (!n.readAt) await markRead.mutateAsync(n.id)
    } catch {
      /* swallow — UX should not be blocked on a 4xx */
    }
    if (n.linkUrl) router.push(n.linkUrl)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Notifications"
          title="Notifications"
          style={{
            position: 'relative',
            width: 36,
            height: 36,
            borderRadius: 9,
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-2)',
            cursor: 'pointer',
          }}
        >
          <Icon.bell size={16} />
          {total > 0 && (
            <span
              style={{
                position: 'absolute',
                top: 5,
                right: 5,
                minWidth: 14,
                height: 14,
                padding: '0 4px',
                borderRadius: 7,
                background: 'var(--coral)',
                color: '#fff',
                fontSize: 9,
                fontWeight: 800,
                lineHeight: '14px',
                textAlign: 'center',
                fontFamily: 'var(--font-mono)',
                boxShadow: '0 0 0 2px var(--bg)',
              }}
            >
              {total > 99 ? '99+' : total}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={10}
        style={{
          width: 380,
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: 0,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            borderBottom: '1px solid var(--bord)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Notifications</span>
            {total > 0 && (
              <Pill tone="blue" dot>
                {total} new
              </Pill>
            )}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {unread.isLoading ? (
            <div
              style={{
                padding: 28,
                textAlign: 'center',
                fontSize: 12,
                color: 'var(--text-mute)',
              }}
            >
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div
              style={{
                padding: '36px 20px',
                textAlign: 'center',
                color: 'var(--text-mute)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Icon.success size={28} style={{ opacity: 0.55 }} />
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)' }}>
                You're all caught up.
              </div>
              <div style={{ fontSize: 11.5, maxWidth: 240, lineHeight: 1.45 }}>
                We'll ping you here when something needs your attention.
              </div>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => handleRowClick(n)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      gap: 11,
                      padding: '12px 14px',
                      borderBottom: '1px solid var(--bord)',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      alignItems: 'flex-start',
                      color: 'var(--text)',
                    }}
                  >
                    <div
                      style={{
                        flex: '0 0 28px',
                        width: 28,
                        height: 28,
                        borderRadius: 8,
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
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 700,
                          color: 'var(--text)',
                          lineHeight: 1.4,
                        }}
                      >
                        {n.message}
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--text-mute)',
                        }}
                      >
                        {timeAgo(n.createdAt)}
                      </div>
                    </div>
                    {!n.readAt && (
                      <div
                        style={{
                          flex: '0 0 8px',
                          width: 8,
                          height: 8,
                          marginTop: 8,
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
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderTop: '1px solid var(--bord)',
            background: 'var(--surf-0)',
          }}
        >
          <Btn
            kind="ghost"
            size="sm"
            disabled={total === 0 || markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
          >
            {markAllRead.isPending ? 'Marking…' : 'Mark all read'}
          </Btn>
          <Link
            href="/inbox"
            onClick={() => setOpen(false)}
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--blue)',
              textDecoration: 'none',
            }}
          >
            See all →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}
