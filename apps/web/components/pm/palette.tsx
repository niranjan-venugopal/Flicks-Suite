'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/proto'
import { Kbd, PriorityGlyph, StateGlyph } from '@/components/pm/glyphs'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { markG, recentG, useHotkeys } from '@/lib/pm/hotkeys'

// ─────────────────────────────────────────────────────────
// P1 — ⌘K command palette + `?` keymap overlay + G-then navigation.
// The registry is the single source: every palette action and every key in
// the overlay comes from COMMANDS/KEYMAP below (§10 — "how the keymap stays
// honest"). Record search: local graph fuzzy first (instant), server FTS/
// trigram merged as it arrives.
// ─────────────────────────────────────────────────────────

interface Command {
  id: string
  label: string
  hint?: string
  run: (router: ReturnType<typeof useRouter>) => void
}

const COMMANDS: Command[] = [
  { id: 'nav.issues', label: 'Go to Issues', hint: 'G then B', run: (r) => r.push('/pm/issues') },
  { id: 'nav.my', label: 'Go to My Issues', hint: 'G then I', run: (r) => r.push('/pm/my') },
  { id: 'nav.inbox', label: 'Go to Inbox', hint: 'G then N', run: (r) => r.push('/inbox') },
  { id: 'nav.projects', label: 'Go to Projects', hint: 'G then P', run: (r) => r.push('/pm/projects') },
  { id: 'nav.timeline', label: 'Go to Timeline', run: (r) => r.push('/pm/timeline') },
  { id: 'nav.roadmap', label: 'Go to Roadmap', hint: 'G then R', run: (r) => r.push('/pm/roadmap') },
  { id: 'nav.triage', label: 'Go to Triage', hint: 'G then T', run: (r) => r.push('/pm/triage') },
  { id: 'nav.cycle', label: 'Go to Cycle', hint: 'G then C', run: (r) => r.push('/pm/cycle') },
  // Plain /pm/issues — the page never read ?create=1; its New-issue button
  // and first-run empty state are right there.
  { id: 'create.issue', label: 'Create issue…', hint: 'C', run: (r) => r.push('/pm/issues') },
]

export const KEYMAP: Array<{ keys: string; label: string; section: string }> = [
  { keys: 'C', label: 'Create issue', section: 'Create' },
  { keys: '⌘K or /', label: 'Command palette / search', section: 'Navigate' },
  { keys: 'G then I', label: 'Go to My Issues', section: 'Navigate' },
  { keys: 'G then N', label: 'Go to Inbox', section: 'Navigate' },
  { keys: 'G then B', label: 'Go to Issues (backlog/list)', section: 'Navigate' },
  { keys: 'G then P', label: 'Go to Projects', section: 'Navigate' },
  { keys: 'G then R', label: 'Go to Roadmap', section: 'Navigate' },
  { keys: 'G then T', label: 'Go to Triage', section: 'Navigate' },
  { keys: 'G then C', label: 'Go to Cycle', section: 'Navigate' },
  { keys: '⇧T', label: 'Send to triage', section: 'Select & edit' },
  { keys: '⌘⇧B', label: 'Copy branch name', section: 'Select & edit' },
  { keys: '⇧↵ · ⇧⌫ · Z · M', label: 'Triage: accept · decline · snooze · merge', section: 'Select & edit' },
  { keys: 'J / K or ↑ ↓', label: 'Move selection', section: 'Navigate' },
  { keys: 'Enter', label: 'Open selected issue', section: 'Navigate' },
  { keys: 'Esc', label: 'Back / clear selection', section: 'Navigate' },
  { keys: 'X · ⇧X', label: 'Select / range select', section: 'Select & edit' },
  { keys: '0–4', label: 'Priority none/urgent/high/med/low', section: 'Select & edit' },
  { keys: 'S', label: 'Set status', section: 'Select & edit' },
  { keys: 'A', label: 'Set assignee', section: 'Select & edit' },
  { keys: 'I', label: 'Assign to me', section: 'Select & edit' },
  { keys: '⌘Z / ⇧⌘Z', label: 'Undo / redo', section: 'Select & edit' },
  { keys: '⌘⇧.', label: 'Copy issue ID', section: 'Issue' },
  { keys: '⌘↵', label: 'Submit (create / comment)', section: 'Issue' },
  { keys: '?', label: 'This overlay', section: 'Help' },
]

interface SearchIssue {
  id: string
  number: number
  title: string
  team_key?: string
  priority: number
  match?: string
}

/** Mount once in the PM layout: palette + keymap overlay + G-then keys. */
export function PmGlobalKeys() {
  const router = useRouter()
  const [palette, setPalette] = useState(false)
  const [keymap, setKeymap] = useState(false)

  useHotkeys({
    'mod+k': (e) => { e.preventDefault(); setPalette((v) => !v) },
    '/': (e) => { e.preventDefault(); setPalette(true) },
    '?': (e) => { e.preventDefault(); setKeymap((v) => !v) },
    'shift+?': (e) => { e.preventDefault(); setKeymap((v) => !v) },
    g: () => markG(),
    i: () => { if (recentG()) router.push('/pm/my') },
    n: () => { if (recentG()) router.push('/inbox') },
    b: () => { if (recentG()) router.push('/pm/issues') },
    p: () => { if (recentG()) router.push('/pm/projects') },
    r: () => { if (recentG()) router.push('/pm/roadmap') },
    t: () => { if (recentG()) router.push('/pm/triage') },
    c: () => { if (recentG()) router.push('/pm/cycle') },
  })

  return (
    <>
      {palette && <PmPalette onClose={() => setPalette(false)} />}
      {keymap && <PmKeymapOverlay onClose={() => setKeymap(false)} />}
    </>
  )
}

function PmPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const { engine } = usePm()
  const [q, setQ] = useState('')
  const [serverHits, setServerHits] = useState<SearchIssue[]>([])
  const [idx, setIdx] = useState(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Local fuzzy over the in-memory graph — instant (§13 local-first note).
  const localHits = useMemo<SearchIssue[]>(() => {
    if (!q.trim() || !engine) return []
    const needle = q.trim().toLowerCase()
    const out: SearchIssue[] = []
    for (const i of engine.store.issues.values()) {
      if (i.deleted_at) continue
      const team = engine.store.teams.get(i.team_id)
      const key = `${team?.key ?? ''}-${i.number}`.toLowerCase()
      if (i.title.toLowerCase().includes(needle) || key.includes(needle.replace(/\s/g, ''))) {
        out.push({ id: i.id, number: i.number, title: i.title, team_key: team?.key, priority: i.priority, match: 'local' })
        if (out.length >= 8) break
      }
    }
    return out
  }, [q, engine])

  // Server FTS/trigram merged as it arrives.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    if (!q.trim()) { setServerHits([]); return }
    debounce.current = setTimeout(() => {
      api
        .get<{ data: { issues: SearchIssue[] } }>(`/api/v1/pm/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setServerHits(r.data.issues))
        .catch(() => setServerHits([]))
    }, 180)
  }, [q])

  const issues = useMemo(() => {
    const seen = new Set(localHits.map((h) => h.id))
    return [...localHits, ...serverHits.filter((h) => !seen.has(h.id))].slice(0, 10)
  }, [localHits, serverHits])

  const commands = useMemo(
    () => COMMANDS.filter((c) => !q.trim() || c.label.toLowerCase().includes(q.trim().toLowerCase())),
    [q],
  )
  const total = commands.length + issues.length

  const pick = (i: number) => {
    if (i < commands.length) commands[i]!.run(router)
    else {
      const issue = issues[i - commands.length]
      if (issue) router.push(`/pm/issues/${issue.id}`)
    }
    onClose()
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(1,1,13,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,.6)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--bord)' }}>
          <Icon.search size={15} style={{ color: 'var(--text-mute)' }} />
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setIdx(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(total - 1, i + 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
              if (e.key === 'Enter' && total > 0) pick(idx)
            }}
            placeholder="Search issues, or type a command…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: 13.5, fontWeight: 600 }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 6 }}>
          {commands.length > 0 && (
            <>
              <div className="t-caption" style={{ padding: '6px 10px 3px' }}>Commands</div>
              {commands.map((c, i) => (
                <PaletteRow key={c.id} active={idx === i} onClick={() => pick(i)}>
                  <Icon.zap size={13} style={{ color: 'var(--text-mute)' }} />
                  <span style={{ flex: 1 }}>{c.label}</span>
                  {c.hint && <span style={{ fontSize: 10, color: 'var(--text-faint)', fontWeight: 700 }}>{c.hint}</span>}
                </PaletteRow>
              ))}
            </>
          )}
          {issues.length > 0 && (
            <>
              <div className="t-caption" style={{ padding: '8px 10px 3px' }}>Issues</div>
              {issues.map((s, i) => (
                <PaletteRow key={s.id} active={idx === commands.length + i} onClick={() => pick(commands.length + i)}>
                  <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 56 }}>
                    {s.team_key}-{s.number}
                  </span>
                  <PriorityGlyph p={s.priority} size={12} />
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</span>
                  {s.match && s.match !== 'local' && (
                    <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{s.match}</span>
                  )}
                </PaletteRow>
              ))}
            </>
          )}
          {q.trim() && total === 0 && (
            <div className="t-mute" style={{ padding: 20, textAlign: 'center', fontSize: 12 }}>
              No matches — try a team key like <b>DC-3</b> or a partial word.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PaletteRow({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, background: active ? 'var(--surf-2)' : 'transparent', border: 'none', cursor: 'pointer', color: active ? '#fff' : 'var(--text-2)', fontSize: 12.5, fontWeight: 700, textAlign: 'left' }}>
      {children}
    </button>
  )
}

export function PmKeymapOverlay({ onClose }: { onClose: () => void }) {
  const sections = [...new Set(KEYMAP.map((k) => k.section))]
  // Esc must dismiss the overlay WITHOUT reaching page hotkeys underneath
  // (detail binds Esc→back, the list binds Esc→clear selection) — capture
  // phase + stopPropagation keeps the dismissal self-contained.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(1,1,13,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '94vw', maxHeight: '80vh', overflowY: 'auto', background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 14, padding: 20, boxShadow: '0 24px 60px rgba(0,0,0,.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Keyboard shortcuts</span>
          <Kbd>?</Kbd>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {sections.map((sec) => (
            <div key={sec}>
              <div className="t-caption" style={{ marginBottom: 7 }}>{sec}</div>
              {KEYMAP.filter((k) => k.section === sec).map((k) => (
                <div key={k.keys} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)', flex: 1 }}>{k.label}</span>
                  <Kbd>{k.keys}</Kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="t-caption" style={{ marginTop: 14 }}>No primary flow requires a mouse — the full-app rule.</div>
      </div>
    </div>
  )
}
