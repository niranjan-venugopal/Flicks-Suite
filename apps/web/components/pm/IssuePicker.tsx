'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/proto'
import { PriorityGlyph } from '@/components/pm/glyphs'
import { api } from '@/lib/api/client'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// Round L — the one "pick an issue" panel (relations, parent). Local fuzzy
// over the engine graph first (instant, same rule as the palette), the
// server's key/FTS/trigram search merged in as it arrives (debounced) — so
// issues outside the bootstrap window are reachable too. REST mode (no
// engine) is server-only. Keyboard: ↑↓ move, ⏎ pick, Esc close.
// ─────────────────────────────────────────────────────────

export interface PickedIssue {
  id: string
  number: number
  title: string
  team_key: string
  team_id?: string
  state_id?: string
  priority?: number
}

interface SearchHit {
  id: string
  number: number
  title: string
  team_key?: string
  team_id?: string
  state_id?: string
  priority?: number
  match?: string
}

const LIMIT = 8

export function IssuePicker({
  engine,
  excludeIds,
  onPick,
  onClose,
  placeholder = 'Search issues — a word or KEY-N',
  autoFocus = true,
}: {
  engine: PmSyncEngine | null
  /** Never offered (the issue itself, already-linked issues, …). */
  excludeIds: string[]
  onPick: (issue: PickedIssue) => void
  onClose: () => void
  placeholder?: string
  autoFocus?: boolean
}) {
  const [q, setQ] = useState('')
  const [serverHits, setServerHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [idx, setIdx] = useState(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exclude = useMemo(() => new Set(excludeIds), [excludeIds])

  // Local graph: instant. Empty query → the most recently touched issues,
  // which is what "link the thing I was just looking at" needs.
  const localHits = useMemo<PickedIssue[]>(() => {
    if (!engine) return []
    const store = engine.store
    const needle = q.trim().toLowerCase()
    const compact = needle.replace(/\s/g, '')
    const toPicked = (i: { id: string; number: number; title: string; team_id: string; state_id: string; priority: number }): PickedIssue => ({
      id: i.id,
      number: i.number,
      title: i.title,
      team_key: store.teams.get(i.team_id)?.key ?? '',
      team_id: i.team_id,
      state_id: i.state_id,
      priority: i.priority,
    })
    if (!needle) {
      return [...store.issues.values()]
        .filter((i) => !i.deleted_at && !exclude.has(i.id))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, LIMIT)
        .map(toPicked)
    }
    const out: PickedIssue[] = []
    for (const i of store.issues.values()) {
      if (i.deleted_at || exclude.has(i.id)) continue
      const key = `${store.teams.get(i.team_id)?.key ?? ''}-${i.number}`.toLowerCase()
      if (i.title.toLowerCase().includes(needle) || key.includes(compact)) {
        out.push(toPicked(i))
        if (out.length >= LIMIT) break
      }
    }
    return out
  }, [q, engine, exclude])

  // Server search merged as it arrives (also the only source in REST mode).
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    const needle = q.trim()
    if (!needle) {
      setServerHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    debounce.current = setTimeout(() => {
      api
        .get<{ data: { issues: SearchHit[] } }>(`/api/v1/pm/search?q=${encodeURIComponent(needle)}`)
        .then((r) => setServerHits(r.data.issues))
        .catch(() => setServerHits([]))
        .finally(() => setSearching(false))
    }, 180)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [q])

  const results = useMemo<PickedIssue[]>(() => {
    const seen = new Set(localHits.map((h) => h.id))
    const fromServer: PickedIssue[] = serverHits
      .filter((h) => !seen.has(h.id) && !exclude.has(h.id))
      .map((h) => ({
        id: h.id,
        number: h.number,
        title: h.title,
        team_key: h.team_key ?? '',
        team_id: h.team_id,
        state_id: h.state_id,
        priority: h.priority,
      }))
    return [...localHits, ...fromServer].slice(0, 10)
  }, [localHits, serverHits, exclude])

  useEffect(() => {
    setIdx(0)
  }, [q, results.length])

  const pick = (i: number) => {
    const hit = results[i]
    if (hit) onPick(hit)
  }

  return (
    <div data-testid="issue-picker" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px', borderBottom: '1px solid var(--bord)' }}>
        <Icon.search size={13} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // Keep the page hotkeys (0–4 priority, Esc → back) out of it.
            e.stopPropagation()
            if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); return }
            if (e.key === 'Enter') { e.preventDefault(); pick(idx) }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: 12, fontWeight: 600, height: 26 }}
        />
        {searching && <Icon.refresh size={12} className="animate-spin" style={{ color: 'var(--text-faint)', flexShrink: 0 }} />}
      </div>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {results.map((r, i) => (
          <button
            key={r.id}
            type="button"
            data-testid="issue-picker-row"
            data-issue-id={r.id}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setIdx(i)}
            onClick={() => pick(i)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7,
              background: i === idx ? 'var(--surf-2)' : 'transparent', border: 'none', cursor: 'pointer',
              color: i === idx ? '#fff' : 'var(--text-2)', fontSize: 11.5, fontWeight: 700, textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', flexShrink: 0, minWidth: 48 }}>
              {r.team_key}-{r.number}
            </span>
            <PriorityGlyph p={r.priority ?? 0} size={11} />
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
          </button>
        ))}
        {results.length === 0 && (
          <div className="t-mute" style={{ padding: '10px 8px', fontSize: 11 }}>
            {q.trim()
              ? searching ? 'Searching…' : 'No matches — try a team key like ENG-3 or a partial word.'
              : engine ? 'No other issues yet.' : 'Type to search issues.'}
          </div>
        )}
      </div>
    </div>
  )
}
