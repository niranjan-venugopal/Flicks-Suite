'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { Icon } from '@/components/proto'
import { usePm } from '@/lib/pm/PmProvider'
import { useAuthStore } from '@/lib/stores/auth.store'

// ─────────────────────────────────────────────────────────
// P20 first-run checklist chip — Welcome → Inbox coach → checklist. Items
// tick themselves from real workspace state and the strip dismisses forever
// with the ×. Round 12 (founder): hosted on the Projects page, and the tour
// runs Linear-style — create a PROJECT first, then an issue.
// ─────────────────────────────────────────────────────────

// .v2: the card moved from My Issues to Projects — resurface it once for
// anyone who dismissed the old placement (it self-hides at 4/4 anyway).
const DISMISS_KEY = 'pm-first-run-checklist.v2'

export const FirstRunChecklist = observer(function FirstRunChecklist({
  onCreateProject,
}: {
  /** Opens the New-project modal in the hosting page (instead of routing). */
  onCreateProject?: () => void
}) {
  const { engine } = usePm()
  const router = useRouter()
  const { currentUser } = useAuthStore()
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(DISMISS_KEY) === '0',
  )

  // Guests are project-scoped viewers — every checklist action is a server
  // 403 for them, so never coach a guest.
  if (dismissed || !engine || currentUser?.role === 'GUEST') return null
  const store = engine.store

  const items: Array<{ label: string; done: boolean; action: () => void }> = [
    {
      label: 'Create a project',
      done: store.projects.size > 0,
      action: () => (onCreateProject ? onCreateProject() : router.push('/pm/projects')),
    },
    { label: 'Create an issue', done: store.issues.size > 0, action: () => router.push('/pm/issues') },
    { label: 'Invite your team', done: store.users.size > 1, action: () => router.push('/settings/members') },
    { label: 'Start a cycle', done: store.cycles.size > 0, action: () => router.push('/pm/cycle') },
  ]
  const doneCount = items.filter((i) => i.done).length
  if (doneCount === items.length) return null // finished — nothing to coach

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, '0')
    setDismissed(true)
  }

  return (
    <div
      className="card pm-fade"
      style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, borderColor: 'rgba(62,123,250,.3)', padding: '12px 16px' }}
    >
      <Icon.zap size={15} style={{ color: 'var(--blue)', flexShrink: 0 }} />
      <div style={{ flex: 1, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            onClick={() => { if (!it.done) it.action() }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 11px',
              borderRadius: 99, cursor: it.done ? 'default' : 'pointer',
              background: it.done ? 'rgba(39,210,128,.08)' : 'var(--surf-1)',
              border: `1px solid ${it.done ? 'rgba(39,210,128,.35)' : 'var(--bord)'}`,
              fontSize: 10.5, fontWeight: 800,
              color: it.done ? 'var(--text-mute)' : '#fff',
              textDecoration: it.done ? 'line-through' : 'none',
            }}
          >
            {it.done && <Icon.check size={10} style={{ color: 'var(--green)' }} />}
            {it.label}
          </button>
        ))}
      </div>
      <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>
        {doneCount}/{items.length}
      </span>
      <button type="button" onClick={dismiss} title="Dismiss" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', display: 'flex' }}>
        <Icon.x size={12} />
      </button>
    </div>
  )
})
