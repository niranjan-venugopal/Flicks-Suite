'use client'

import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { computed } from 'mobx'
import { observer } from 'mobx-react-lite'
import {
  PM_INSIGHTS_DEFAULT,
  PM_INSIGHT_MEASURES,
  PM_INSIGHT_NONE_KEY,
  PM_INSIGHT_SEGMENTS,
  PM_INSIGHT_SLICES,
  PM_INSIGHT_UNASSIGNED_KEY,
  isInsightCanceled,
  pivotInsights,
  type PmInsightIssue,
  type PmInsightLookups,
  type PmInsightMeasure,
  type PmInsightSegment,
  type PmInsightSlice,
  type PmInsightsConfig,
} from '@flicks/shared/pm'
import { Icon, Skeleton } from '@/components/proto'
import { PM_CAT_COLOR } from '@/components/pm/glyphs'
import { useProjectInsights, useSetInsightsDefault, type PmProjectInsights } from '@/lib/api/queries/use-pm-insights'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmStore } from '@/lib/pm/store'

// ─────────────────────────────────────────────────────────
// Round M — Project page rail: the Insights card (Linear's right rail).
// Measure × Slice × Segment → stacked bar chart + table, computed with the
// shared `@flicks/shared/pm` math over EITHER the FSE store (sync mode —
// synchronous, no request, no spinner) OR the REST insights payload
// (kill-switch mode — one query, shared with the Progress graph below it).
// Config resolution: this browser's saved choice → the project's saved
// default → PM_INSIGHTS_DEFAULT.
// ─────────────────────────────────────────────────────────

export interface ProjectInsightsCardProps {
  projectId: string
  engine: PmSyncEngine | null
  /** The project row's saved default (may be undefined on rows cached before 0064 — treated as null). */
  insightsDefault: PmInsightsConfig | null | undefined
  /** Lead, or manager and above (the page's `mayDelete` bar) — shows "Set default for everyone". */
  canSetDefault: boolean
}

export interface InsightInputs {
  issues: PmInsightIssue[]
  lookups: PmInsightLookups
}

/**
 * Sync mode: the project's live issues the way `store.projectProgress` finds
 * them (project_id match, not deleted; canceled rows are dropped by the math
 * itself), plus the lookups from the store. Label links ARE in the store
 * (`pm_issue_labels` is a sync table), so the Label slice needs no REST
 * fallback. Colours: status → category colour, like every other PM surface.
 */
export function storeInsightInputs(store: PmStore, projectId: string): InsightInputs {
  const issues: PmInsightIssue[] = []
  for (const i of store.issues.values()) {
    if (i.project_id !== projectId || i.deleted_at) continue
    issues.push({
      id: i.id,
      state_id: i.state_id,
      priority: i.priority,
      estimate: i.estimate != null ? Number(i.estimate) : null,
      assignee_user_id: i.assignee_user_id,
      milestone_id: i.milestone_id,
      label_ids: store.issueLabels.get(i.id) ?? [],
      created_at: i.created_at,
      started_at: i.started_at,
      completed_at: i.completed_at,
      canceled_at: i.canceled_at,
    })
  }
  const states = [...store.states.values()].map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    color: PM_CAT_COLOR[s.category] ?? s.color,
  }))
  const users: Record<string, string> = {}
  for (const u of store.users.values()) users[u.id] = u.name ?? ''
  const milestones: Record<string, string> = {}
  for (const m of store.milestonesForProject(projectId)) milestones[m.id] = m.name
  const labels: Record<string, { name: string; color?: string | null }> = {}
  for (const l of store.labels.values()) labels[l.id] = { name: l.name, color: l.color }
  return { issues, lookups: { states, users, milestones, labels } }
}

/** REST mode: the payload already carries the lookups; only the status colours are normalised. */
export function restInsightInputs(d: PmProjectInsights): InsightInputs {
  return {
    issues: d.issues,
    lookups: {
      states: d.states.map((s) => ({ ...s, color: PM_CAT_COLOR[s.category] ?? s.color })),
      users: d.users,
      milestones: d.milestones,
      labels: d.labels,
    },
  }
}

// ─── Config persistence (per browser, per project) ───────────────────────────

const storageKey = (projectId: string) => `pm.insights.${projectId}`

function isConfig(v: unknown): v is PmInsightsConfig {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    PM_INSIGHT_MEASURES.includes(c.measure as PmInsightMeasure) &&
    PM_INSIGHT_SLICES.includes(c.slice as PmInsightSlice) &&
    PM_INSIGHT_SEGMENTS.includes(c.segment as PmInsightSegment)
  )
}

function readLocal(projectId: string): PmInsightsConfig | null {
  try {
    const raw = window.localStorage.getItem(storageKey(projectId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeLocal(projectId: string, cfg: PmInsightsConfig) {
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(cfg))
  } catch {
    // private mode / quota — the choice just doesn't persist
  }
}

function clearLocal(projectId: string) {
  try {
    window.localStorage.removeItem(storageKey(projectId))
  } catch {
    // nothing to clear
  }
}

// ─── Colours ─────────────────────────────────────────────────────────────────

/** The "nothing here" bucket (No priority / Unassigned / No label …): PM's
 *  backlog grey — solid enough to read as a bar; --surf-3 (10 % white) all
 *  but vanished on the card. */
const NEUTRAL = '#5C6477'
const PRIORITY_COLOR: Record<string, string> = {
  '1': 'var(--coral)',
  '2': 'var(--yellow)',
  '3': 'var(--blue)',
  '4': 'var(--text-faint)',
  '0': NEUTRAL,
}
const PALETTE = ['#9B7BFA', '#3E7BFA', '#27D280', '#FED800', '#F8786B', '#FF9933', '#4FD1E0', '#E879F9']

function hashColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]!
}

export function insightColor(dim: PmInsightSlice | PmInsightSegment, key: string, given?: string | null): string {
  if (dim === 'priority') return PRIORITY_COLOR[key] ?? NEUTRAL
  if (dim === 'none') return 'var(--blue)'
  if (key === PM_INSIGHT_UNASSIGNED_KEY || key === PM_INSIGHT_NONE_KEY) return NEUTRAL
  if (given) return given
  if (dim === 'status') return PM_CAT_COLOR.unstarted!
  return hashColor(key)
}

const SLICE_LABEL: Record<PmInsightSlice, string> = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  milestone: 'Milestone',
  label: 'Label',
}
const SEGMENT_LABEL: Record<PmInsightSegment, string> = {
  none: 'None',
  priority: 'Priority',
  status: 'Status',
  assignee: 'Assignee',
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))

/**
 * Axis maximum ≥ n that splits into four INTEGER ticks: the quarter step is
 * the smallest "nice" integer ≥ n/4 (1 · 1.5 · 2 · 2.5 · 3 · 4 · 5 · 6 · 8 ×
 * 10^k, fractional candidates skipped below 10), the max is 4 × that. Never
 * below 4. (A plain 1·2·5 ladder gave 5 → ticks 1.25 / 2.5 / 3.75 on an
 * issue-count axis.)
 */
export function niceCeil(n: number): number {
  const q = Math.max(1, Math.ceil(n / 4))
  const p = Math.pow(10, Math.floor(Math.log10(q)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const step = m * p
    if (Number.isInteger(step) && step >= q) return 4 * step
  }
  return 40 * p
}

// ─── Card ────────────────────────────────────────────────────────────────────

// Three pickers across a 360 px rail (≈ 330 px of content): 28 px tall,
// 11.5 px, our own chevron pulled in to 6 px so the closed value has room.
// Measure gets a little more width — "Estimate points" is the longest value.
const selectStyle = {
  height: 28,
  fontSize: 11.5,
  fontWeight: 700,
  padding: '0 20px 0 8px',
  backgroundPosition: 'right 5px center',
  backgroundSize: '12px 12px',
  minWidth: 0,
  width: '100%',
} as const
const pickerStyle = { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } as const
const captionStyle = { fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', letterSpacing: '.02em', lineHeight: 1 } as const
const chartLabel = { fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' } as const
const tickLabel = { ...chartLabel, fontFamily: 'var(--font-mono)' } as const

export const ProjectInsightsCard = observer(function ProjectInsightsCard({
  projectId,
  engine,
  insightsDefault,
  canSetDefault,
}: ProjectInsightsCardProps) {
  const projectDefault = insightsDefault ?? null
  const rest = useProjectInsights(projectId, { enabled: !engine })

  // Sync mode: a MobX computed over the store — cached until an observed row
  // changes, so re-renders for unrelated reasons (a select flip) reuse the
  // same inputs object and the pivot memo below holds.
  const storeInputs = useMemo(
    () => (engine ? computed(() => storeInsightInputs(engine.store, projectId)) : null),
    [engine, projectId],
  )
  const inputs: InsightInputs | null = storeInputs ? storeInputs.get() : rest.data ? restInsightInputs(rest.data.data) : null

  // ── config: browser choice → project default → shared default ────────────
  // localStorage is read in an effect (never during render) so SSR and the
  // first client paint agree; the same effect re-runs when the project's
  // saved default changes (someone else saved, or the sync row landed), and
  // a viewer with their own browser choice keeps it. useLayoutEffect so the
  // switch from the project default to the browser choice happens before
  // the first paint — no flash of the wrong chart.
  const [cfg, setCfg] = useState<PmInsightsConfig>(projectDefault ?? PM_INSIGHTS_DEFAULT)
  const pd = projectDefault ? `${projectDefault.measure}|${projectDefault.slice}|${projectDefault.segment}` : ''
  useLayoutEffect(() => {
    setCfg(readLocal(projectId) ?? projectDefault ?? PM_INSIGHTS_DEFAULT)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pd])
  const change = (patch: Partial<PmInsightsConfig>) => {
    const next = { ...cfg, ...patch }
    setCfg(next)
    writeLocal(projectId, next)
  }

  const setDefault = useSetInsightsDefault(projectId)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const saveDefault = () => {
    setDefault.mutate(cfg, {
      onSuccess: () => {
        setSavedAt(Date.now())
        // The saver's view IS the project default now — drop their browser
        // override so they follow the shared default from here on (otherwise a
        // later "Set default" by a colleague would never reach the person who
        // set the previous one). Everyone else's browser choice still wins.
        clearLocal(projectId)
        if (engine) void engine.pullDelta() // the server published a pm_projects ref
      },
    })
  }
  useEffect(() => {
    if (savedAt == null) return
    const t = setTimeout(() => setSavedAt(null), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  // ── derived ───────────────────────────────────────────────────────────────
  const pivot = useMemo(() => (inputs ? pivotInsights(inputs.issues, inputs.lookups, cfg) : null), [inputs, cfg])
  const liveCount = useMemo(() => {
    if (!inputs) return 0
    const states = new Map(inputs.lookups.states.map((s) => [s.id, s]))
    let n = 0
    for (const i of inputs.issues) if (!isInsightCanceled(i, states)) n++
    return n
  }, [inputs])
  const isProjectDefault =
    !!projectDefault && projectDefault.measure === cfg.measure && projectDefault.slice === cfg.slice && projectDefault.segment === cfg.segment

  const segmented = cfg.segment !== 'none'
  const rows = pivot?.rows ?? []
  const segments = pivot?.segments ?? []
  const axisMax = niceCeil(Math.max(1, ...rows.map((r) => r.total)))
  const ticks = [1, 0.75, 0.5, 0.25]
  const segTotals = segments.map((s) => rows.reduce((acc, r) => acc + (r.cells.find((c) => c.key === s.key)?.value ?? 0), 0))
  // REST mode ships at most `issue_cap` rows (most recent) — say so rather
  // than present a partial count as the whole. Sync mode has the full graph.
  const truncatedTo = !engine && rest.data?.data.truncated ? rest.data.data.issue_cap : null

  return (
    <div className="card" data-testid="project-insights" style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon.chart size={13} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1, minWidth: 0 }}>
          Insights{inputs ? <span style={{ color: 'var(--text-mute)', fontWeight: 700 }}> · {liveCount} {liveCount === 1 ? 'issue' : 'issues'}</span> : null}
        </span>
      </div>

      {/* Pickers — each select sits inside its <label>, so the visible caption
          is also its accessible name. Measure gets ~25 % more width: "Estimate
          points" is the longest closed value. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <label style={{ ...pickerStyle, flex: '1.25 1 0' }}>
          <span style={captionStyle}>Measure</span>
          <select className="input" data-testid="insights-measure" aria-label="Measure" value={cfg.measure} style={selectStyle}
            onChange={(e) => change({ measure: e.target.value as PmInsightMeasure })}>
            <option value="count">Issue count</option>
            <option value="points">Estimate points</option>
          </select>
        </label>
        <label style={{ ...pickerStyle, flex: '1 1 0' }}>
          <span style={captionStyle}>Slice</span>
          <select className="input" data-testid="insights-slice" aria-label="Slice" value={cfg.slice} style={selectStyle}
            onChange={(e) => change({ slice: e.target.value as PmInsightSlice })}>
            {PM_INSIGHT_SLICES.map((s) => <option key={s} value={s}>{SLICE_LABEL[s]}</option>)}
          </select>
        </label>
        <label style={{ ...pickerStyle, flex: '1 1 0' }}>
          <span style={captionStyle}>Segment</span>
          <select className="input" data-testid="insights-segment" aria-label="Segment" value={cfg.segment} style={selectStyle}
            onChange={(e) => change({ segment: e.target.value as PmInsightSegment })}>
            {PM_INSIGHT_SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABEL[s]}</option>)}
          </select>
        </label>
      </div>

      {!inputs ? (
        rest.isError ? (
          <div className="t-mute" style={{ fontSize: 11.5, padding: '8px 0' }}>
            Couldn’t load insights.{' '}
            <button type="button" onClick={() => void rest.refetch()} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--blue)', fontWeight: 800, fontSize: 11.5, cursor: 'pointer' }}>Retry</button>
          </div>
        ) : (
          // Same footprint as the loaded card (120 px chart + labels + a few
          // table rows) so the rail doesn't jump when the data lands.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120, marginLeft: 32 }}>
              {[55, 80, 40, 95, 60].map((h, i) => <Skeleton key={i} h={`${h}%`} r={4} style={{ flex: 1 }} />)}
            </div>
            <Skeleton h={12} w="70%" />
            {[92, 84, 88, 80].map((w, i) => <Skeleton key={i} h={12} w={`${w}%`} />)}
          </div>
        )
      ) : liveCount === 0 || rows.length === 0 ? (
        <div className="t-mute" style={{ padding: '18px 0 8px', textAlign: 'center', fontSize: 11.5 }}>
          No issues yet — add issues to see the breakdown
        </div>
      ) : (
        <>
          {/* Chart — stacked vertical bars, 4 y-ticks */}
          <div data-testid="project-insights-chart" style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <div style={{ position: 'relative', width: 26, height: 120, flexShrink: 0 }}>
              {ticks.map((t) => (
                <span key={t} style={{ position: 'absolute', right: 2, top: `${(1 - t) * 100}%`, transform: 'translateY(-50%)', ...tickLabel }}>
                  {fmt(axisMax * t)}
                </span>
              ))}
              <span style={{ position: 'absolute', right: 2, bottom: 0, transform: 'translateY(50%)', ...tickLabel }}>0</span>
            </div>
            <div style={{ flex: 1, minWidth: 0, position: 'relative', height: 120 }}>
              {ticks.map((t) => (
                <div key={t} style={{ position: 'absolute', left: 0, right: 0, top: `${(1 - t) * 100}%`, borderTop: '1px dashed var(--bord)', pointerEvents: 'none' }} />
              ))}
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderTop: '1px solid var(--bord-2)' }} />
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: rows.length > 12 ? 2 : 5, height: '100%', position: 'relative' }}>
                {rows.map((r) => (
                  <div
                    key={r.key}
                    data-testid="project-insights-bar"
                    data-row={r.key}
                    title={`${r.label} — ${fmt(r.total)}${segmented ? '\n' + r.cells.filter((c) => c.value > 0).map((c) => `${c.label}: ${fmt(c.value)}`).join(' · ') : ''}`}
                    style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}
                  >
                    {segmented
                      ? [...r.cells].reverse().filter((c) => c.value > 0).map((c, ci, arr) => (
                          <div
                            key={c.key}
                            title={`${c.label} · ${fmt(c.value)}`}
                            style={{
                              height: `${(c.value / axisMax) * 100}%`,
                              background: insightColor(cfg.segment, c.key, c.color),
                              borderRadius: ci === 0 ? '3px 3px 0 0' : 0,
                              borderBottom: ci < arr.length - 1 ? '1px solid rgba(1,1,13,.6)' : 'none',
                              minHeight: 1,
                            }}
                          />
                        ))
                      : (
                          <div style={{ height: `${(r.total / axisMax) * 100}%`, background: insightColor(cfg.slice, r.key, r.color), borderRadius: '3px 3px 0 0', minHeight: 1 }} />
                        )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: rows.length > 12 ? 2 : 5, marginLeft: 32, marginTop: 4 }}>
            {rows.map((r) => (
              <span key={r.key} title={r.label} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center', ...chartLabel }}>
                {rows.length > 8 ? r.label.slice(0, 3) : r.label}
              </span>
            ))}
          </div>
          {segmented && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 8 }}>
              {segments.map((s) => (
                <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: 'var(--text-faint)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: insightColor(cfg.segment, s.key, s.color), flexShrink: 0 }} />
                  {s.label}
                </span>
              ))}
            </div>
          )}

          {/* Table — slice rows × segment columns + Total */}
          <div className="tbl-scroll" style={{ marginTop: 12, marginLeft: -14, marginRight: -14, borderTop: '1px solid var(--bord)' }}>
            {/* Header inherits .tbl's 11 px caps; cells 12 px (the rail's
                table density). Wider than 360 px → .tbl-scroll scrolls the
                table inside the card, never the page. */}
            <table className="tbl" data-testid="project-insights-table">
              <thead>
                <tr>
                  <th style={{ padding: '8px 14px' }}>{SLICE_LABEL[cfg.slice]}</th>
                  {segmented && segments.map((s) => (
                    <th key={s.key} style={{ padding: '8px 8px', textAlign: 'right', whiteSpace: 'nowrap' }} title={s.label}>
                      {s.label.length > 12 ? s.label.slice(0, 11) + '…' : s.label}
                    </th>
                  ))}
                  <th style={{ padding: '8px 14px 8px 8px', textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-row={r.key}>
                    <td style={{ padding: '7px 14px', fontSize: 12, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: insightColor(cfg.slice, r.key, r.color), flexShrink: 0 }} />
                        <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.label}>{r.label}</span>
                      </span>
                    </td>
                    {segmented && r.cells.map((c) => (
                      <td key={c.key} style={{ padding: '7px 8px', fontSize: 12, textAlign: 'right', fontFamily: 'var(--font-mono)', color: c.value ? '#fff' : 'var(--text-faint)' }}>
                        {c.value ? fmt(c.value) : '–'}
                      </td>
                    ))}
                    <td style={{ padding: '7px 14px 7px 8px', fontSize: 12, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{fmt(r.total)}</td>
                  </tr>
                ))}
                <tr data-row="__total">
                  <td style={{ padding: '7px 14px', fontSize: 11, color: 'var(--text-mute)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em' }}>Total</td>
                  {segmented && segTotals.map((v, i) => (
                    <td key={segments[i]!.key} style={{ padding: '7px 8px', fontSize: 12, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{fmt(v)}</td>
                  ))}
                  <td style={{ padding: '7px 14px 7px 8px', fontSize: 12, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                    {fmt(cfg.slice === 'label' ? rows.reduce((a, r) => a + r.total, 0) : pivot!.total)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* Footer — notes on the left, the shared-default control on the
              right (lead / manager+ only; the card is non-empty here). */}
          {(cfg.slice === 'label' || truncatedTo != null || canSetDefault) && (
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginTop: 8, fontSize: 11.5, fontWeight: 700, color: 'var(--text-mute)', lineHeight: 1.4 }}>
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {cfg.slice === 'label' && <span style={{ color: 'var(--text-faint)' }}>An issue with several labels counts once per label.</span>}
                {truncatedTo != null && (
                  <span data-testid="project-insights-truncated" style={{ color: 'var(--yellow)' }}>
                    Large project — showing the {truncatedTo.toLocaleString()} most recent issues.
                  </span>
                )}
              </div>
              {canSetDefault && (
                savedAt != null ? (
                  <span style={{ color: 'var(--green)', whiteSpace: 'nowrap' }}>Saved as project default</span>
                ) : isProjectDefault ? (
                  <span style={{ color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>Project default</span>
                ) : (
                  <button
                    type="button"
                    data-testid="insights-set-default"
                    onClick={saveDefault}
                    disabled={setDefault.isPending}
                    title="Everyone opening this project starts from this view"
                    style={{ background: 'none', border: 'none', padding: 0, color: setDefault.isError ? 'var(--coral)' : 'var(--text-mute)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', textDecoration: 'underline', textUnderlineOffset: 2, flexShrink: 0 }}
                  >
                    {setDefault.isPending ? 'Saving…' : setDefault.isError ? 'Couldn’t save — try again' : 'Set default for everyone'}
                  </button>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
})
