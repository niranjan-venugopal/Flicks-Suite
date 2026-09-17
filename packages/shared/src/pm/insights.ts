// ─── Round M — project Insights + Progress graph: the pure math ──────────────
// Consumed by BOTH the API (insights.service.ts computes the REST payload)
// and the web (sync mode runs the same functions over the FSE store rows so
// the two modes can never disagree). No api/web imports, no Date.now(): every
// "now" is a parameter, so the functions are unit-testable and replayable.

import type { PmInsightMeasure, PmInsightSegment, PmInsightSlice, PmInsightsConfig, PmStateCategory } from './index'

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** One live issue row, timestamps as ISO strings (the wire shape of pm_issues). */
export interface PmInsightIssue {
  id: string
  state_id: string
  priority: number
  estimate: number | null
  assignee_user_id: string | null
  milestone_id: string | null
  label_ids: string[]
  created_at: string
  started_at: string | null
  completed_at: string | null
  canceled_at: string | null
}

export interface PmInsightState {
  id: string
  name: string
  category: string
  color?: string | null
}

export interface PmInsightLookups {
  states: PmInsightState[]
  /** user id → display name */
  users: Record<string, string>
  /** milestone id → name */
  milestones: Record<string, string>
  labels: Record<string, { name: string; color?: string | null }>
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

export interface PmInsightCell {
  key: string
  label: string
  color?: string | null
  value: number
}

export interface PmInsightRow {
  key: string
  label: string
  color?: string | null
  total: number
  cells: PmInsightCell[]
}

export interface PmInsightSegmentDef {
  key: string
  label: string
  color?: string | null
}

export interface PmInsightPivot {
  rows: PmInsightRow[]
  segments: PmInsightSegmentDef[]
  /** Sum of the measure over live issues — once per issue, even under the label slice. */
  total: number
}

export interface PmProgressPoint {
  /** ISO date (YYYY-MM-DD) of the week's Monday, UTC. */
  week: string
  scope: number
  started: number
  done: number
}

export interface PmCompletionPrediction {
  velocity_per_week: number | null
  /** ISO date (YYYY-MM-DD) or null when there is not enough history / no velocity / nothing left. */
  predicted_completion: string | null
}

// ─── Shared rules ────────────────────────────────────────────────────────────

const PRIORITY_LABELS = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const
// The board's column order = PM_STATE_CATEGORIES (index.ts). Spelled out here
// rather than derived at module load because index.ts re-exports this file
// (a runtime import back into it would be a TDZ cycle under ESM bundling);
// `satisfies` keeps the two in lock-step at compile time.
const CATEGORY_ORDER = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
} satisfies Record<PmStateCategory, number> as Record<string, number>

/**
 * Ordering for rows/segments: primary bucket, then label, then key — the key
 * is the tiebreak so two same-named members (or two "Unknown member" rows)
 * never swap places between renders.
 */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byOrder = (a: { key: string; order: [number, string] }, b: { key: string; order: [number, string] }) =>
  a.order[0] - b.order[0] || cmp(a.order[1], b.order[1]) || cmp(a.key, b.key)

export const PM_INSIGHT_UNASSIGNED_KEY = 'unassigned'
export const PM_INSIGHT_NONE_KEY = 'none'
export const PM_INSIGHT_TOTAL_KEY = 'total'

const stateIndex = (states: PmInsightState[]) => new Map(states.map((s) => [s.id, s]))

/**
 * Canceled = excluded everywhere. Mirrors projects.service.ts computeProgress
 * (state category) AND honours the lifecycle stamp, so an issue whose state
 * row is not in the lookups (a team the reader cannot see) is still dropped
 * when it carries canceled_at.
 */
export function isInsightCanceled(issue: Pick<PmInsightIssue, 'state_id' | 'canceled_at'>, states: Map<string, PmInsightState>): boolean {
  if (issue.canceled_at != null) return true
  return states.get(issue.state_id)?.category === 'canceled'
}

/** count → 1 per issue · points → estimate ?? 1 (the §6.1 progress fallback). */
export function insightWeight(issue: Pick<PmInsightIssue, 'estimate'>, measure: PmInsightMeasure): number {
  if (measure !== 'points') return 1
  if (issue.estimate == null) return 1
  const n = Number(issue.estimate)
  return Number.isFinite(n) ? n : 1
}

interface DimMeta {
  label: string
  color?: string | null
  /** Sort tuple: primary numeric bucket, then label. */
  order: [number, string]
}

function dimMeta(dim: PmInsightSlice | PmInsightSegment, key: string, lookups: PmInsightLookups, states: Map<string, PmInsightState>): DimMeta {
  switch (dim) {
    case 'status': {
      const s = states.get(key)
      if (!s) return { label: 'Unknown state', color: null, order: [9, ''] }
      return { label: s.name, color: s.color ?? null, order: [CATEGORY_ORDER[s.category] ?? 8, s.name.toLowerCase()] }
    }
    case 'priority': {
      const p = Number(key)
      const label = PRIORITY_LABELS[p] ?? 'No priority'
      return { label, order: [Number.isFinite(p) ? p : 0, label] }
    }
    // People / milestones / labels sort by the label the user SEES (so an
    // "Unknown member" lands among the U's, not silently first), then by key.
    case 'assignee': {
      if (key === PM_INSIGHT_UNASSIGNED_KEY) return { label: 'Unassigned', order: [1, ''] }
      const name = lookups.users[key]
      const label = name && name.trim() ? name : 'Unknown member'
      return { label, order: [0, label.toLowerCase()] }
    }
    case 'milestone': {
      if (key === PM_INSIGHT_NONE_KEY) return { label: 'No milestone', order: [1, ''] }
      const label = lookups.milestones[key] ?? 'Unknown milestone'
      return { label, order: [0, label.toLowerCase()] }
    }
    case 'label': {
      if (key === PM_INSIGHT_NONE_KEY) return { label: 'No label', order: [1, ''] }
      const l = lookups.labels[key]
      const label = l?.name ?? 'Unknown label'
      return { label, color: l?.color ?? null, order: [0, label.toLowerCase()] }
    }
    case 'none':
    default:
      return { label: 'Total', order: [0, ''] }
  }
}

/** Slice keys for one issue — the label slice yields one key per label (or `none`). */
function sliceKeys(issue: PmInsightIssue, slice: PmInsightSlice): string[] {
  switch (slice) {
    case 'status':
      return [issue.state_id]
    case 'priority':
      return [String(Math.min(4, Math.max(0, Number(issue.priority) || 0)))]
    case 'assignee':
      return [issue.assignee_user_id ?? PM_INSIGHT_UNASSIGNED_KEY]
    case 'milestone':
      return [issue.milestone_id ?? PM_INSIGHT_NONE_KEY]
    case 'label': {
      const ids = [...new Set(issue.label_ids ?? [])]
      return ids.length ? ids : [PM_INSIGHT_NONE_KEY]
    }
    default:
      return [PM_INSIGHT_TOTAL_KEY]
  }
}

function segmentKey(issue: PmInsightIssue, segment: PmInsightSegment): string {
  switch (segment) {
    case 'priority':
      return String(Math.min(4, Math.max(0, Number(issue.priority) || 0)))
    case 'status':
      return issue.state_id
    case 'assignee':
      return issue.assignee_user_id ?? PM_INSIGHT_UNASSIGNED_KEY
    case 'none':
    default:
      return PM_INSIGHT_TOTAL_KEY
  }
}

/**
 * Measure × Slice × Segment → rows (slice) with one cell per segment. Canceled
 * issues are excluded; empty rows and empty segments are dropped; rows and
 * segments are ordered by their dimension's natural order (status: category
 * then name · priority: 0..4 · people/milestones/labels: name, with the
 * "none" bucket last).
 */
export function pivotInsights(issues: PmInsightIssue[], lookups: PmInsightLookups, cfg: PmInsightsConfig): PmInsightPivot {
  const states = stateIndex(lookups.states)
  const rowAgg = new Map<string, Map<string, number>>()
  const segTotals = new Map<string, number>()
  let total = 0
  for (const issue of issues) {
    if (isInsightCanceled(issue, states)) continue
    const w = insightWeight(issue, cfg.measure)
    total += w
    const seg = segmentKey(issue, cfg.segment)
    for (const rk of sliceKeys(issue, cfg.slice)) {
      let cells = rowAgg.get(rk)
      if (!cells) rowAgg.set(rk, (cells = new Map()))
      cells.set(seg, (cells.get(seg) ?? 0) + w)
      segTotals.set(seg, (segTotals.get(seg) ?? 0) + w)
    }
  }
  const segments = [...segTotals.entries()]
    .filter(([, v]) => v > 0)
    .map(([key]) => ({ key, ...dimMeta(cfg.segment, key, lookups, states) }))
    .sort(byOrder)
    .map(({ key, label, color }) => (color === undefined ? { key, label } : { key, label, color }))
  const rows = [...rowAgg.entries()]
    .map(([key, cells]) => {
      const meta = dimMeta(cfg.slice, key, lookups, states)
      const rowTotal = [...cells.values()].reduce((a, b) => a + b, 0)
      return {
        key,
        label: meta.label,
        color: meta.color,
        order: meta.order,
        total: rowTotal,
        cells: segments.map((s) => ({ key: s.key, label: s.label, color: s.color, value: cells.get(s.key) ?? 0 })),
      }
    })
    .filter((r) => r.total > 0)
    .sort(byOrder)
    .map(({ key, label, color, total: t, cells }) => (color === undefined ? { key, label, total: t, cells } : { key, label, color, total: t, cells }))
  return { rows, segments, total }
}

// ─── Progress series (weekly, Monday-based, UTC) ─────────────────────────────

const WEEK_MS = 7 * 86_400_000
const MAX_WEEKS = 104

/** UTC midnight of the Monday on or before the given instant. */
export function weekMondayUTC(at: Date | string): Date {
  const d = new Date(at)
  const day = d.getUTCDay() // 0 Sun … 6 Sat
  const back = (day + 6) % 7 // Mon → 0, Sun → 6
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back))
}

/** ISO date (YYYY-MM-DD) of the week's Monday, UTC. */
export function weekMondayISO(at: Date | string): string {
  return weekMondayUTC(at).toISOString().slice(0, 10)
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)
const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Weekly scope / started / done, one point per Monday from the earliest
 * created_at (or `from`) to the week of `to`, capped at the most recent 104
 * weeks. Each point is the state at the END of its week (Sunday 23:59:59.999
 * UTC): scope = created ≤ w and not canceled ≤ w; started = of those,
 * started ≤ w or completed ≤ w; done = completed ≤ w. Counts issues, not
 * points — the graph answers "how many are left", the header's progress bar
 * answers "how much". Always at least one point (the current week) when
 * there are issues; [] when there are none.
 *
 * `states` is optional: with it, an issue sitting in a canceled-category
 * state WITHOUT a canceled_at stamp (imports) is treated as canceled from
 * creation, matching pivotInsights.
 */
export function buildProgressSeries(
  issues: PmInsightIssue[],
  opts: { from?: string; to: string; states?: PmInsightState[] },
): PmProgressPoint[] {
  if (!issues.length) return []
  const states = stateIndex(opts.states ?? [])
  const rows = issues
    .map((i) => {
      const created = ms(i.created_at)
      if (created == null) return null
      const stampCanceled = ms(i.canceled_at)
      const catCanceled = states.get(i.state_id)?.category === 'canceled'
      return {
        created,
        started: ms(i.started_at),
        completed: ms(i.completed_at),
        canceled: stampCanceled ?? (catCanceled ? created : null),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
  if (!rows.length) return []

  const end = weekMondayUTC(opts.to).getTime()
  const earliest = Math.min(...rows.map((r) => r.created))
  const fromMs = opts.from ? ms(opts.from) : null
  let start = weekMondayUTC(new Date(fromMs ?? earliest)).getTime()
  if (start > end) start = end
  const weeks = Math.floor((end - start) / WEEK_MS) + 1
  if (weeks > MAX_WEEKS) start = end - (MAX_WEEKS - 1) * WEEK_MS

  const out: PmProgressPoint[] = []
  for (let t = start; t <= end; t += WEEK_MS) {
    const wEnd = t + WEEK_MS - 1
    let scope = 0
    let started = 0
    let done = 0
    for (const r of rows) {
      if (r.created > wEnd) continue
      if (r.canceled != null && r.canceled <= wEnd) continue
      scope++
      const isDone = r.completed != null && r.completed <= wEnd
      if (isDone) done++
      if (isDone || (r.started != null && r.started <= wEnd)) started++
    }
    out.push({ week: isoDate(new Date(t)), scope, started, done })
  }
  return out
}

// ─── Prediction ──────────────────────────────────────────────────────────────

const VELOCITY_WINDOW = 4
const MIN_HISTORY_WEEKS = 2
const MAX_HORIZON_WEEKS = 52

/**
 * Velocity = mean weekly `done` delta over the last 4 COMPLETE weeks (weeks
 * that ended before today's week; fewer when the history is shorter; the
 * first week's delta is its own `done`, since nothing existed before it).
 * Null with fewer than 2 complete weeks. predicted_completion = today +
 * ceil(remaining / velocity) weeks, capped 52 weeks out; null when velocity
 * ≤ 0 or nothing remains.
 */
export function predictCompletion(series: PmProgressPoint[], todayISO: string): PmCompletionPrediction {
  if (!series.length) return { velocity_per_week: null, predicted_completion: null }
  const thisWeek = weekMondayISO(todayISO)
  const complete = series.filter((p) => p.week < thisWeek)
  if (complete.length < MIN_HISTORY_WEEKS) return { velocity_per_week: null, predicted_completion: null }
  const deltas = complete.map((p, i) => p.done - (i === 0 ? 0 : complete[i - 1]!.done))
  const window = deltas.slice(-VELOCITY_WINDOW)
  const velocity = window.reduce((a, b) => a + b, 0) / window.length
  const velocityRounded = Math.round(velocity * 100) / 100
  const last = series[series.length - 1]!
  const remaining = last.scope - last.done
  if (velocity <= 0 || remaining <= 0) return { velocity_per_week: velocityRounded, predicted_completion: null }
  const weeks = Math.min(MAX_HORIZON_WEEKS, Math.ceil(remaining / velocity))
  const today = new Date(todayISO)
  const predicted = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + weeks * 7))
  return { velocity_per_week: velocityRounded, predicted_completion: isoDate(predicted) }
}
