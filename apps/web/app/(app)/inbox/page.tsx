'use client'

import { Suspense } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { SectionHead } from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useAdminOverview } from '@/lib/api/queries/use-dashboard'
import { useUnreadNotifications } from '@/lib/api/queries/use-notifications'
import { NotificationsTab } from '@/components/inbox/NotificationsTab'
import { ApprovalsTab } from '@/components/inbox/ApprovalsTab'

// ─────────────────────────────────────────────────────────
// The ONE common Inbox for every role: Notifications (default — the P9
// experience over ALL kinds: HRMS, CRM, invoicing, PM) + Approvals (the
// leave/regularization review queue, approver roles only). /pm/inbox and
// /notifications redirect here. Only the active tab mounts, so the
// Notifications hotkeys (j/k/E/Z) never bleed into the approvals form.
// ─────────────────────────────────────────────────────────

type Tab = 'notifications' | 'approvals'

function InboxContent() {
  const router = useRouter()
  const pathname = usePathname() ?? '/inbox'
  const sp = useSearchParams()
  const { currentUser } = useAuthStore()
  const role = currentUser?.role
  // Mirrors the sidebar approvals-badge gating: the tenant approver roles.
  const isApprover = role === 'OWNER' || role === 'HR_ADMIN' || role === 'MANAGER'

  const tab: Tab = sp.get('tab') === 'approvals' && isApprover ? 'approvals' : 'notifications'
  const setTab = (t: Tab) =>
    router.replace(t === 'notifications' ? pathname : `${pathname}?tab=${t}`, { scroll: false })

  const unread = useUnreadNotifications()
  const overview = useAdminOverview(isApprover)
  const unreadCount = unread.data?.total ?? 0
  const pendingCount = isApprover ? overview.data?.stats?.pendingApprovals ?? 0 : 0

  const TabBtn = ({ t, label, count }: { t: Tab; label: string; count: number }) => (
    <button
      type="button"
      onClick={() => setTab(t)}
      style={{
        padding: '8px 14px',
        borderRadius: 99,
        border: '1px solid ' + (tab === t ? 'var(--bord-3)' : 'var(--bord)'),
        background: tab === t ? 'var(--surf-3)' : 'var(--surf-1)',
        color: tab === t ? '#fff' : 'var(--text-2)',
        fontSize: 12,
        fontWeight: 800,
        cursor: 'pointer',
        display: 'inline-flex',
        gap: 7,
        alignItems: 'center',
      }}
    >
      {label}
      {count > 0 && (
        <span
          style={{
            minWidth: 17,
            height: 17,
            padding: '0 5px',
            borderRadius: 99,
            background: t === 'approvals' ? 'var(--coral)' : 'var(--blue)',
            color: '#fff',
            fontSize: 9.5,
            fontWeight: 800,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {count}
        </span>
      )}
    </button>
  )

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Inbox"
          sub={
            isApprover
              ? 'Notifications across the suite, plus the requests waiting on you'
              : 'Notifications across the suite — mentions, updates and decisions'
          }
        />

        <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
          <TabBtn t="notifications" label="Notifications" count={unreadCount} />
          {isApprover && <TabBtn t="approvals" label="Approvals" count={pendingCount} />}
        </div>

        {tab === 'approvals' ? <ApprovalsTab /> : <NotificationsTab />}
      </div>
    </div>
  )
}

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxContent />
    </Suspense>
  )
}
