'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { Icon } from '@/components/proto'
import { usePm } from '@/lib/pm/PmProvider'

// ─────────────────────────────────────────────────────────
// P20 first-run checklist chip — Welcome → Inbox coach → checklist. Items
// tick themselves from real workspace state and the strip dismisses forever
// with the ×. ("Connect GitHub" from the prototype is swapped for "Create a
// project" while the integration is parked behind FEATURES.pm_github.)
// ─────────────────────────────────────────────────────────

const DISMISS_KEY = 'pm-first-run-checklist'

export const FirstRunChecklist = observer(function FirstRunChecklist() {
  const { engine } = usePm()
  const router = useRouter()
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(DISMISS_KEY) === '0',
  )

  if (dismissed || !engine) return null
  const store = engine.store

  const items: Array<{ label: string; done: boolean; href: string }> = [
    { label: 'Create an issue', done: store.issues.size > 0, href: '/pm/issues?create=1' },
    { label: 'Invite your team', done: store.users.size > 1, href: '/settings/members' },
    { label: 'Create a project', done: store.projects.size > 0, href: '/pm/projects' },
    { label: 'Start a cycle', done: store.cycles.size > 0, href: '/pm/cycle' },
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
            onClick={() => { if (!it.done) router.push(it.href) }}
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
