'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Btn } from '@/components/proto'
import { HealthChip, PM_HEALTH } from '@/components/pm/glyphs'
import { PmAv } from '@/components/pm/projects'
import { api } from '@/lib/api/client'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmStore } from '@/lib/pm/store'
import type { PmUpdateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// Project page — "Health updates" rail card: health picker + composer +
// feed + the staleness chip. Split out of the page in Round M (verbatim
// move); `postUpdate` is the same handler the page used to own.
// ─────────────────────────────────────────────────────────

export interface ProjectUpdatesProps {
  projectId: string
  engine: PmSyncEngine | null
  /** Seeds the health picker once on mount (the page's old useState(project.health)). */
  initialHealth: PmUpdateRow['health']
  /** REST detail merged with the live engine rows, newest first (the page computes this). */
  updates: PmUpdateRow[]
  users: PmStore['users'] | null
  /** Whole days since the newest update; null when there is none (the page computes this). */
  staleDays: number | null
  /** Refetches the lazy REST detail (REST mode; sync mode refetches on ack). */
  invalidate: () => void
}

export const ProjectUpdates = observer(function ProjectUpdates({
  projectId,
  engine,
  initialHealth,
  updates,
  users,
  staleDays,
  invalidate,
}: ProjectUpdatesProps) {
  const [health, setHealth] = useState<'on_track' | 'at_risk' | 'off_track'>(initialHealth)
  const [upTxt, setUpTxt] = useState('')

  const postUpdate = () => {
    if (!upTxt.trim()) return
    // Both branches refresh the REST detail: in sync mode the merge above
    // shows the new row instantly from the store, but a stale REST payload
    // would otherwise keep resurrecting rows the server has since replaced.
    if (engine) engine.postProjectUpdate(projectId, health, upTxt.trim()) // onFlushed refetches on ack
    else void api.post(`/api/v1/pm/projects/${projectId}/updates`, { health, body_md: upTxt.trim() }).then(invalidate)
    setUpTxt('')
  }

  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Health updates</span>
        {staleDays !== null && staleDays >= 2 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 99, background: 'rgba(254,216,0,.09)', border: '1px solid rgba(254,216,0,.35)', fontSize: 9, fontWeight: 800, color: 'var(--yellow)' }}>
            no update in {staleDays} days
          </span>
        )}
      </div>
      <div style={{ padding: '9px 11px', borderRadius: 10, background: 'var(--surf-1)', border: '1px solid var(--bord)', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 7 }}>
          {(Object.keys(PM_HEALTH) as Array<'on_track' | 'at_risk' | 'off_track'>).map((k) => {
            const s = PM_HEALTH[k]!
            const active = health === k
            return (
              <button key={k} onClick={() => setHealth(k)}
                style={{ flex: 1, padding: '5px 0', borderRadius: 7, fontSize: 10, fontWeight: 800, cursor: 'pointer', background: active ? s.bg : 'transparent', border: `1px solid ${active ? s.border : 'var(--bord)'}`, color: active ? s.color : 'var(--text-2)' }}>
                {s.label}
              </button>
            )
          })}
        </div>
        <input placeholder="What changed this week?" value={upTxt} onChange={(e) => setUpTxt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') postUpdate() }}
          className="input" style={{ height: 30, fontSize: 11.5, marginBottom: 6, width: '100%' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Btn kind="primary" size="sm" onClick={postUpdate} disabled={!upTxt.trim()}>Post update</Btn>
        </div>
      </div>
      {updates.map((u, ui) => {
        const author = u.author_user_id ? users?.get(u.author_user_id)?.name ?? 'Member' : 'Member'
        return (
          <div key={u.id} style={{ paddingBottom: 11, marginBottom: 11, borderBottom: ui < updates.length - 1 ? '1px solid var(--bord)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
              <PmAv name={author} src={u.author_user_id ? users?.get(u.author_user_id)?.avatar_url : null} size={16} />
              <span style={{ fontSize: 10.5, fontWeight: 800 }}>{author}</span>
              <HealthChip h={u.health} small />
              <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: 'var(--text-faint)' }}>
                {new Date(u.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{u.body_md}</div>
          </div>
        )
      })}
      <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)' }}>
        Leads are nudged in the Inbox when stale &gt; 7 days — never auto-generated.
      </div>
    </div>
  )
})
