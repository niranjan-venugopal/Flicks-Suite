'use client'

import { useState } from 'react'
import { Btn, Icon, Modal, avBg, initials } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmTeamRow, PmUserLite } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// Projects layer shared pieces (P11/P14): create modals + avatar.
// Both modals are dual-mode: `onCreate` is injected by the page so the same
// UI runs on the engine (sync) or plain REST (kill-switch).
// ─────────────────────────────────────────────────────────

// `src` is the signed avatar URL from /pm/users — when it is missing (or the
// image 404s) the initials chip is the fallback, so callers can always pass it.
export function PmAv({ name, src, size = 18 }: { name: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  const box = { width: size, height: size, borderRadius: '50%', flexShrink: 0 } as const
  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name}
        onError={() => setBroken(true)}
        style={{ ...box, objectFit: 'cover', display: 'inline-block' }}
      />
    )
  }
  return (
    <span style={{ ...box, background: avBg(name), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: Math.max(7, size * 0.36), letterSpacing: '-0.02em' }}>
      {initials(name)}
    </span>
  )
}

export const PROJECT_ICONS = ['🤝', '⚡', '📣', '🚀', '🛠️', '🎯']

/**
 * Round E — a project's face: the uploaded logo when there is one, the emoji
 * icon otherwise. Signed logo URLs age out (they persist in IndexedDB
 * between sessions), so a broken image falls back to the emoji — the next
 * bootstrap/delta re-signs it.
 */
export function ProjectLogo({ logoUrl, icon, size = 18 }: { logoUrl?: string | null; icon?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt=""
        onError={() => setBroken(true)}
        style={{ width: size, height: size, borderRadius: Math.max(4, size * 0.22), objectFit: 'cover', flexShrink: 0, display: 'inline-block' }}
      />
    )
  }
  return <span style={{ fontSize: size * 0.78, lineHeight: 1, flexShrink: 0 }}>{icon ?? '🎯'}</span>
}

export function ProjectCreateModal({
  open,
  onClose,
  teams,
  users,
  meId,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  teams: PmTeamRow[]
  users: PmUserLite[]
  meId: string
  onCreate: (
    input: {
      name: string
      icon: string
      lead_user_id: string
      target_date: string | null
      team_ids: string[]
    },
    /** Round E — optional logo picked at create; the caller uploads it once
     *  the new project's id exists (server center-crops + re-encodes). */
    logoFile?: File | null,
  ) => void
}) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('🤝')
  const [lead, setLead] = useState(meId)
  const [target, setTarget] = useState('')
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [logoFile, setLogoFile] = useState<File | null>(null)
  if (!open) return null
  const tog = (id: string) => setTeamIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]))
  const submit = () => {
    if (!name.trim()) return
    onCreate({ name: name.trim(), icon, lead_user_id: lead, target_date: target || null, team_ids: teamIds }, logoFile)
    setName(''); setTarget(''); setTeamIds([]); setLogoFile(null)
    onClose()
  }
  return (
    <Modal open={open} onClose={onClose} width={560} title="New project" sub="One lead · a target date · honest health updates"
      footer={<><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" icon={<Icon.check size={14} />} onClick={submit} disabled={!name.trim()}>Create project</Btn></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div>
          <div className="label">Icon</div>
          <select className="input" value={icon} onChange={(e) => setIcon(e.target.value)} style={{ height: 38, padding: '0 8px' }}>
            {PROJECT_ICONS.map((e) => <option key={e}>{e}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '2/4' }}>
          <div className="label">Name</div>
          <input autoFocus className="input" placeholder="TechCorp onboarding" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            style={{ height: 38 }} />
        </div>
        <div style={{ gridColumn: '1/3' }}>
          <div className="label">Lead</div>
          <select className="input" value={lead} onChange={(e) => setLead(e.target.value)} style={{ height: 38 }}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.id.slice(0, 6)}</option>)}
          </select>
        </div>
        <div>
          <div className="label">Target date</div>
          <DateField value={target} onChange={setTarget} style={{ height: 38 }} />
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 4 }}>Logo (optional)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 11, color: 'var(--text-2)' }}
          />
          {logoFile && (
            <button type="button" onClick={() => setLogoFile(null)}
              style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 10.5, fontWeight: 700 }}>
              Clear
            </button>
          )}
        </div>
        <div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-faint)', marginTop: 3 }}>
          JPG/PNG/WebP, squared automatically. The emoji icon stays the fallback.
        </div>
      </div>
      <div className="label" style={{ marginBottom: 6 }}>Teams</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {teams.map((t) => (
          <button key={t.id} onClick={() => tog(t.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, cursor: 'pointer', background: teamIds.includes(t.id) ? `${t.color ?? '#3E7BFA'}18` : 'var(--surf-1)', border: `1px solid ${teamIds.includes(t.id) ? (t.color ?? '#3E7BFA') + '55' : 'var(--bord)'}`, color: teamIds.includes(t.id) ? '#fff' : 'var(--text-2)', fontSize: 11, fontWeight: 800 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: t.color ?? '#3E7BFA' }} />{t.key}
          </button>
        ))}
      </div>
    </Modal>
  )
}

export function InitiativeCreateModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (input: { name: string; description: string | null; target_quarter: string | null }) => void
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [quarter, setQuarter] = useState('Q3 2026')
  if (!open) return null
  const submit = () => {
    if (!name.trim()) return
    onCreate({ name: name.trim(), description: desc.trim() || null, target_quarter: quarter })
    setName(''); setDesc('')
    onClose()
  }
  return (
    <Modal open={open} onClose={onClose} width={440} title="New initiative" sub="A quarter-level lane of projects · Manager+ only"
      footer={<><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" icon={<Icon.check size={14} />} onClick={submit} disabled={!name.trim()}>Create initiative</Btn></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ gridColumn: '1/3' }}>
          <div className="label">Name</div>
          <input autoFocus className="input" placeholder="Q4 · Enterprise readiness" value={name} onChange={(e) => setName(e.target.value)} style={{ height: 38 }} />
        </div>
        <div style={{ gridColumn: '1/3' }}>
          <div className="label">Quarter</div>
          <select className="input" value={quarter} onChange={(e) => setQuarter(e.target.value)} style={{ height: 38 }}>
            {['Q3 2026', 'Q4 2026', 'Q1 2027', 'Q2 2027'].map((q) => <option key={q}>{q}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '1/3' }}>
          <div className="label">Description <span style={{ color: 'var(--text-faint)' }}>· optional</span></div>
          <textarea className="input" placeholder="What outcome does this lane drive?" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ height: 60, padding: 10, resize: 'none' }} />
        </div>
      </div>
    </Modal>
  )
}

/** Team key chips rendered on project rows (P11). */
export function TeamKeyChips({ teamIds, teams }: { teamIds: string[]; teams: Map<string, PmTeamRow> }) {
  return (
    <span style={{ display: 'flex', gap: 4 }}>
      {teamIds.map((tid) => {
        const t = teams.get(tid)
        if (!t) return null
        return (
          <span key={tid} style={{ fontSize: 8.5, fontWeight: 900, fontFamily: 'var(--font-mono)', color: t.color ?? '#3E7BFA', border: `1px solid ${t.color ?? '#3E7BFA'}55`, borderRadius: 5, padding: '1px 5px' }}>
            {t.key}
          </span>
        )
      })}
    </span>
  )
}

/** How PmSyncEngine is consumed by the modals' pages (type helper). */
export type PmEngineLike = Pick<PmSyncEngine, 'createProject' | 'createInitiative'>
