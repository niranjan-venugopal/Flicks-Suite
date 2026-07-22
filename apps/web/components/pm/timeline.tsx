'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { DiamondGlyph } from '@/components/pm/glyphs'
import type { PmMilestoneRow, PmProjectRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// P12 Timeline / P14 Roadmap (§9.3 — deliberately no task-Gantt).
// Projects render as health-colored bars start→target with milestone
// diamonds; drag either end to re-date (a plain mutation). Lanes group by
// team (timeline) or initiative (roadmap). Pure presentational component —
// pages feed lanes + an onRedate callback (engine or REST).
// ─────────────────────────────────────────────────────────

export interface TimelineLane {
  key: string
  label: string
  chip?: string | null
  projects: PmProjectRow[]
}

const HB: Record<string, string> = {
  on_track: 'var(--green)',
  at_risk: 'var(--yellow)',
  off_track: 'var(--coral)',
}
const HBG: Record<string, string> = {
  on_track: 'rgba(39,210,128,.13)',
  at_risk: 'rgba(254,216,0,.13)',
  off_track: 'rgba(248,120,107,.13)',
}

const DAY_MS = 86_400_000

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

export function TimelineBoard({
  lanes,
  milestonesFor,
  zoomMonths,
  onRedate,
  onOpenProject,
  emptyLaneCta,
}: {
  lanes: TimelineLane[]
  milestonesFor: (projectId: string) => PmMilestoneRow[]
  zoomMonths: number
  onRedate: (projectId: string, patch: { start_date?: string; target_date?: string }) => void
  onOpenProject: (projectId: string) => void
  emptyLaneCta?: (laneKey: string) => void
}) {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{
    projectId: string
    edge: 'start' | 'end' | 'move'
    startX: number
    origStart: number
    origTarget: number
    previewStart: number
    previewTarget: number
  } | null>(null)

  // Window: month of the earliest start (fallback: last month) → zoomMonths.
  const windowStart = useMemo(() => {
    const starts = lanes.flatMap((l) => l.projects).map((p) => p.start_date).filter(Boolean) as string[]
    const min = starts.length ? new Date(starts.reduce((a, b) => (a < b ? a : b))) : addMonths(monthStart(new Date()), -1)
    return monthStart(min)
  }, [lanes])
  const windowEnd = addMonths(windowStart, zoomMonths)
  const spanMs = windowEnd.getTime() - windowStart.getTime()
  const months = useMemo(() => {
    const out: Date[] = []
    for (let i = 0; i < zoomMonths; i++) out.push(addMonths(windowStart, i))
    return out
  }, [windowStart, zoomMonths])

  const pctOf = (iso: string) => ((new Date(iso).getTime() - windowStart.getTime()) / spanMs) * 100
  const clampPct = (v: number) => Math.max(0, Math.min(100, v))
  const todayPct = clampPct(((Date.now() - windowStart.getTime()) / spanMs) * 100)

  const pxToDays = (px: number) => {
    const w = gridRef.current?.getBoundingClientRect().width ?? 1
    return Math.round((px / w) * (spanMs / DAY_MS))
  }

  const beginDrag = (e: React.PointerEvent, p: PmProjectRow, edge: 'start' | 'end' | 'move') => {
    if (!p.start_date || !p.target_date) return
    e.preventDefault()
    e.stopPropagation()
    const orig = {
      projectId: p.id,
      edge,
      startX: e.clientX,
      origStart: new Date(p.start_date).getTime(),
      origTarget: new Date(p.target_date).getTime(),
      previewStart: new Date(p.start_date).getTime(),
      previewTarget: new Date(p.target_date).getTime(),
    }
    setDrag(orig)
    const onMove = (ev: PointerEvent) => {
      const days = pxToDays(ev.clientX - orig.startX)
      setDrag((d) => {
        if (!d) return d
        let ps = d.origStart
        let pt = d.origTarget
        if (edge === 'start' || edge === 'move') ps = d.origStart + days * DAY_MS
        if (edge === 'end' || edge === 'move') pt = d.origTarget + days * DAY_MS
        if (ps >= pt) return d // never invert
        return { ...d, previewStart: ps, previewTarget: pt }
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDrag((d) => {
        if (d && (d.previewStart !== d.origStart || d.previewTarget !== d.origTarget)) {
          const patch: { start_date?: string; target_date?: string } = {}
          if (d.previewStart !== d.origStart) patch.start_date = new Date(d.previewStart).toISOString().slice(0, 10)
          if (d.previewTarget !== d.origTarget) patch.target_date = new Date(d.previewTarget).toISOString().slice(0, 10)
          onRedate(d.projectId, patch)
        }
        return null
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Month header */}
      <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', borderBottom: '1px solid var(--bord)' }}>
        <div style={{ padding: '8px 14px', fontSize: 9.5, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Group</div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${months.length},1fr)` }}>
          {months.map((m, i) => (
            <div key={i} style={{ padding: '8px 10px', fontSize: 9.5, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)', borderLeft: '1px solid var(--bord)' }}>
              {m.toLocaleDateString(undefined, { month: 'short' })} {m.getMonth() === 0 || i === 0 ? m.getFullYear() : ''}
            </div>
          ))}
        </div>
      </div>

      {lanes.map((lane) => (
        <div key={lane.key} style={{ display: 'grid', gridTemplateColumns: '170px 1fr', borderBottom: '1px solid var(--bord)', minHeight: 64 }}>
          <div style={{ padding: '10px 14px', borderRight: '1px solid var(--bord)' }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, lineHeight: 1.3 }}>{lane.label}</div>
            {lane.chip && (
              <span style={{ display: 'inline-flex', marginTop: 4, padding: '0 7px', height: 15, alignItems: 'center', borderRadius: 99, background: 'rgba(39,210,128,.1)', border: '1px solid rgba(39,210,128,.35)', fontSize: 8.5, fontWeight: 800, color: 'var(--green)', textTransform: 'capitalize' }}>
                {lane.chip}
              </span>
            )}
          </div>
          <div ref={gridRef} style={{ position: 'relative', padding: '10px 0' }}>
            {months.map((_, mi) => (
              <div key={mi} style={{ position: 'absolute', left: `${(mi / months.length) * 100}%`, top: 0, bottom: 0, width: 1, background: 'var(--bord)' }} />
            ))}
            <div title="Today" style={{ position: 'absolute', left: `${todayPct}%`, top: 0, bottom: 0, width: 1.5, background: 'var(--blue)', opacity: 0.7 }} />
            {lane.projects.length ? lane.projects.map((p) => {
              const isDragging = drag?.projectId === p.id
              const startIso = isDragging ? new Date(drag!.previewStart).toISOString() : p.start_date
              const targetIso = isDragging ? new Date(drag!.previewTarget).toISOString() : p.target_date
              if (!startIso || !targetIso) {
                return (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', height: 24, paddingLeft: 14 }}>
                    <button onClick={() => onOpenProject(p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)' }}>
                      {p.icon ?? '🎯'} {p.name} — set start &amp; target dates to place it here
                    </button>
                  </div>
                )
              }
              const l = clampPct(pctOf(startIso))
              const r = clampPct(pctOf(targetIso))
              const w = Math.max(r - l, 2)
              const color = HB[p.health] ?? 'var(--green)'
              const ms = milestonesFor(p.id)
              return (
                <div key={p.id} style={{ position: 'relative', height: 22, margin: '3px 0' }}>
                  <div
                    title={`${p.name} · ${startIso.slice(0, 10)} → ${targetIso.slice(0, 10)} — drag ends to re-date`}
                    onPointerDown={(e) => beginDrag(e, p, 'move')}
                    onDoubleClick={() => onOpenProject(p.id)}
                    style={{ position: 'absolute', left: `${l}%`, width: `${w}%`, height: 22, borderRadius: 6, background: HBG[p.health] ?? HBG.on_track, border: `1px solid ${color}`, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', cursor: 'grab', opacity: isDragging ? 0.85 : 1 }}>
                    <span
                      onPointerDown={(e) => beginDrag(e, p, 'start')}
                      title="Drag to re-date start"
                      style={{ position: 'absolute', left: -1, top: 3, bottom: 3, width: 4, borderRadius: 2, background: color, cursor: 'ew-resize' }} />
                    <span style={{ fontSize: 9.5 }}>{p.icon ?? '🎯'}</span>
                    <span style={{ fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                    {ms.slice(0, 5).map((m) => {
                      if (!m.target_date) return null
                      const mp = clampPct(pctOf(m.target_date))
                      if (mp < l || mp > l + w) return null
                      const rel = ((mp - l) / w) * 100
                      return (
                        <span key={m.id} title={`${m.name} · ${m.target_date}`} style={{ position: 'absolute', left: `${rel}%`, top: -4 }}>
                          <DiamondGlyph size={8} color="var(--yellow)" />
                        </span>
                      )
                    })}
                    <span
                      onPointerDown={(e) => beginDrag(e, p, 'end')}
                      title="Drag to re-date target"
                      style={{ position: 'absolute', right: -1, top: 3, bottom: 3, width: 4, borderRadius: 2, background: color, cursor: 'ew-resize' }} />
                  </div>
                </div>
              )
            }) : (
              <div style={{ display: 'flex', alignItems: 'center', height: '100%', paddingLeft: 14 }}>
                {emptyLaneCta ? (
                  <button onClick={() => emptyLaneCta(lane.key)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10.5, fontWeight: 700, color: 'var(--blue)' }}>
                    + Add projects to this lane
                  </button>
                ) : (
                  <span className="t-mute" style={{ fontSize: 10.5 }}>No projects</span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      {lanes.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 24px', gap: 10 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
            <Icon.kanban size={20} />
          </div>
          <div className="t-mute" style={{ fontSize: 12 }}>Projects appear here as bars from start to target — drag ends to re-date.</div>
        </div>
      )}
    </div>
  )
}

/** Shared zoom pill row (month = 4 columns, quarter = 8). */
export function ZoomToggle({ zoom, setZoom }: { zoom: 'month' | 'quarter'; setZoom: (z: 'month' | 'quarter') => void }) {
  return (
    <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8 }}>
      {(['month', 'quarter'] as const).map((k) => (
        <button key={k} onClick={() => setZoom(k)}
          style={{ padding: '5px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', background: zoom === k ? 'var(--surf-3)' : 'transparent', color: zoom === k ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800, textTransform: 'capitalize' }}>
          {k}
        </button>
      ))}
    </div>
  )
}

export function useTimelineNav() {
  const router = useRouter()
  return { openProject: (id: string) => router.push(`/pm/projects/${id}`) }
}
