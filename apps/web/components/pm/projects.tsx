'use client'

import { useEffect, useRef, useState } from 'react'
import { Btn, Icon, Modal, avBg, initials } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { PM_PRIORITY_LABEL, PriorityGlyph } from '@/components/pm/glyphs'
import { ProjectIcon } from '@/components/pm/ProjectIcon'
import { ProjectVisualPicker } from '@/components/pm/ProjectVisualPicker'
import { DEFAULT_PROJECT_ICON, defaultColorFor } from '@/components/pm/icons/project-icons'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmTeamRow, PmUserLite } from '@/lib/pm/types'
import { useTheme } from '@/lib/theme/theme'

// ─────────────────────────────────────────────────────────
// Projects layer shared pieces (P11/P14): create modals + avatar.
// Both modals are dual-mode: `onCreate` is injected by the page so the same
// UI runs on the engine (sync) or plain REST (kill-switch).
// ─────────────────────────────────────────────────────────

// `src` is the signed avatar URL from /pm/users — when it is missing (or the
// image 404s) the initials chip is the fallback, so callers can always pass it.
export function PmAv({ name, src, size = 18 }: { name: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  // Issue rows are re-sorted, re-grouped and re-filtered constantly, so React
  // hands this same instance a different person's `src` all the time; signed
  // urls also age out and come back re-signed. Reset, or one 404 pins that
  // slot to initials for the rest of the session.
  useEffect(() => {
    setBroken(false)
  }, [src])
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
    <span style={{ ...box, background: avBg(name), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)', fontWeight: 800, fontSize: Math.max(7, size * 0.36), letterSpacing: '-0.02em' }}>
      {initials(name)}
    </span>
  )
}

// Round P R5 — a project's face is <ProjectIcon> everywhere (uploaded image
// → lucide tile → legacy emoji → default tile). The Round C emoji set and the
// Round E `ProjectLogo` wrapper are gone: nothing new is created with an
// emoji, and old projects' emoji still render through ProjectIcon.

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
      /** Round P R5 — `lucide:<name>` (the picker only offers the curated set). */
      icon: string
      /** Round P R5 — #RRGGBB tile colour: follows the name until picked explicitly. */
      color: string
      lead_user_id: string
      target_date: string | null
      team_ids: string[]
      /** Round M — 0 none · 1 urgent · 2 high · 3 medium · 4 low (issue scale). */
      priority?: number
    },
    /** Round E — optional logo picked at create; the caller uploads it once
     *  the new project's id exists (server center-crops + re-encodes). */
    logoFile?: File | null,
  ) => void
}) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState(DEFAULT_PROJECT_ICON)
  // Round P R5 — null = the colour tracks the name as it is typed (hash →
  // one of the 12 swatches); a swatch click in the picker pins it.
  const [colorPicked, setColorPicked] = useState<string | null>(null)
  const [lead, setLead] = useState(meId)
  const [target, setTarget] = useState('')
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [priority, setPriority] = useState(0) // Round M — issue scale, default "No priority"
  const [picker, setPicker] = useState(false)
  // The picker's Image tab hands off to this hidden input — the same plain
  // file pick as before (the server center-crops + re-encodes), so the
  // create flow needs no crop step and no project id yet.
  const fileInput = useRef<HTMLInputElement>(null)
  // Object URL so the tile shows the chosen image before anything is uploaded.
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  useEffect(() => {
    if (!logoFile) { setLogoPreview(null); return }
    const url = URL.createObjectURL(logoFile)
    setLogoPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [logoFile])
  if (!open) return null
  const color = colorPicked ?? defaultColorFor(name.trim())
  const tog = (id: string) => setTeamIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]))
  const submit = () => {
    if (!name.trim()) return
    onCreate({ name: name.trim(), icon, color, lead_user_id: lead, target_date: target || null, team_ids: teamIds, priority }, logoFile)
    setName(''); setTarget(''); setTeamIds([]); setLogoFile(null); setPriority(0); setIcon(DEFAULT_PROJECT_ICON); setColorPicked(null)
    onClose()
  }
  return (
    <Modal open={open} onClose={onClose} width={560} title="New project" sub="One lead · a target date · honest health updates"
      footer={<><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" icon={<Icon.check size={14} />} onClick={submit} disabled={!name.trim()}>Create project</Btn></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div>
          <div className="label">Icon</div>
          {/* Round P R5 — the tile IS the control: click it for the icon /
              colour / image picker. An image chosen on the Image tab shows
              here straight away; picking an icon afterwards drops it (a
              project has one or the other). */}
          <button
            type="button"
            data-testid="project-create-visual"
            title="Choose an icon and colour, or upload an image"
            aria-label="Choose an icon and colour, or upload an image"
            onClick={() => setPicker(true)}
            style={{ display: 'inline-flex', padding: 0, border: 'none', background: 'transparent', borderRadius: 11, cursor: 'pointer', boxShadow: '0 0 0 1px var(--bord)' }}
          >
            <ProjectIcon logoUrl={logoPreview} icon={icon} color={color} name={name} size={38} />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            data-testid="project-create-logo-file"
            onChange={(e) => { setLogoFile(e.target.files?.[0] ?? null); e.target.value = '' }}
            style={{ display: 'none' }}
          />
          <ProjectVisualPicker
            open={picker}
            onClose={() => setPicker(false)}
            icon={icon}
            color={color}
            name={name}
            hasImage={!!logoFile}
            onPick={(nextIcon, nextColor, colorWasPicked) => {
              setIcon(nextIcon)
              if (colorWasPicked) setColorPicked(nextColor)
              setLogoFile(null) // icon XOR image, at create time too
            }}
            onUploadImage={() => fileInput.current?.click()}
            onRemoveImage={() => setLogoFile(null)}
          />
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
        {/* Round M — project priority (issue scale). The glyph sits beside the
            native select, which can't render SVG in its options. */}
        <div style={{ gridColumn: '1/4' }}>
          <div className="label">Priority</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PriorityGlyph p={priority} size={14} />
            <select
              className="input"
              data-testid="project-create-priority"
              aria-label="Project priority"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              style={{ height: 38, flex: 1 }}
            >
              {PM_PRIORITY_LABEL.map((l, p) => <option key={p} value={p}>{l}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="label" style={{ marginBottom: 6 }}>Teams</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {teams.map((t) => (
          <button key={t.id} onClick={() => tog(t.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, cursor: 'pointer', background: teamIds.includes(t.id) ? `color-mix(in srgb, ${t.color ?? '#3E7BFA'} 9%, transparent)` : 'var(--surf-1)', border: `1px solid ${teamIds.includes(t.id) ? `color-mix(in srgb, ${t.color ?? '#3E7BFA'} 33%, transparent)` : 'var(--bord)'}`, color: teamIds.includes(t.id) ? 'var(--text)' : 'var(--text-2)', fontSize: 11, fontWeight: 800 }}>
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
  // Light theme: 8.5px text in the team's own colour is unreadable on white
  // for the yellow / green / grey swatches (1.4–2.2:1), so the colour moves to
  // a dot and the key is set in --text-2. Dark keeps today's coloured key.
  const light = useTheme().resolved === 'light'
  return (
    <span style={{ display: 'flex', gap: 4 }}>
      {teamIds.map((tid) => {
        const t = teams.get(tid)
        if (!t) return null
        const c = t.color ?? '#3E7BFA'
        return (
          <span key={tid} style={{ fontSize: 8.5, fontWeight: 900, fontFamily: 'var(--font-mono)', color: light ? 'var(--text-2)' : c, border: `1px solid color-mix(in srgb, ${c} 33%, transparent)`, borderRadius: 5, padding: '1px 5px' }}>
            {light && <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 2, background: c, marginRight: 4, verticalAlign: 'middle' }} />}
            {t.key}
          </span>
        )
      })}
    </span>
  )
}

/** How PmSyncEngine is consumed by the modals' pages (type helper). */
export type PmEngineLike = Pick<PmSyncEngine, 'createProject' | 'createInitiative'>
