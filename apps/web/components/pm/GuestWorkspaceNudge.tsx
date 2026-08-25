'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useMyCompanies } from '@/lib/api/queries/use-members'

const DISMISS_KEY = 'pm-guest-workspace-nudge'

/**
 * Guest → customer nudge (round 7, founder decision): a user whose EVERY
 * membership is a guest seat sees a dismissible strip on their project list
 * suggesting they create their own workspace. Linear/ClickUp-style — the
 * switcher carries the same CTA permanently; this strip is the one-time
 * discovery moment.
 */
export function GuestWorkspaceNudge() {
  const router = useRouter()
  const { currentUser } = useAuthStore()
  const companies = useMyCompanies(currentUser?.role === 'GUEST')
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(DISMISS_KEY) === '0',
  )

  if (dismissed || currentUser?.role !== 'GUEST') return null
  if (!companies.data) return null
  const allGuest = companies.data.data.every((c) => c.role === 'guest')
  if (!allGuest || !companies.data.canCreateWorkspace) return null

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '0')
    } catch {
      /* ignore */
    }
    setDismissed(true)
  }

  return (
    <div
      className="card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 14,
        borderColor: 'rgba(62,123,250,.3)',
        padding: '12px 16px',
      }}
    >
      <Icon.spark size={16} style={{ color: 'var(--blue)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800 }}>
          You&rsquo;re a guest here — like what you see?
        </div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
          Create your own free workspace for your team: projects, HRMS, CRM and
          invoicing in one place.
        </div>
      </div>
      <Btn kind="primary" size="sm" onClick={() => router.push('/onboarding')}>
        Create my workspace
      </Btn>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-faint)',
          cursor: 'pointer',
          padding: 4,
        }}
      >
        <Icon.x size={14} />
      </button>
    </div>
  )
}
