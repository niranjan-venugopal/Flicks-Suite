// ─── Round M — project update diff (Linear-style "what changed since") ───────
// A project update stores a PmUpdateSnapshot of the project at post time
// (projects.service.ts postUpdate). The grey block under an update is the
// DIFF between its snapshot and the previous update's, computed at READ time
// by both the API (detail) and the web client (sync mode, from the store) —
// one implementation, so the two transports never disagree.

import type {
  PmUpdateDiff,
  PmUpdateDiffMilestone,
  PmUpdateDiffProp,
  PmUpdateDiffPropKey,
  PmUpdateSnapshot,
} from './index'

/** The project props an update diff reports, in display order. */
export const PM_UPDATE_DIFF_PROP_KEYS: readonly PmUpdateDiffPropKey[] = [
  'status',
  'priority',
  'lead_user_id',
  'start_date',
  'target_date',
]

/**
 * The implicit "before the first update" state: a fresh project (planned, no
 * priority, no lead, no dates), every milestone the current snapshot knows at
 * 0 %, nothing completed. `at` is the project's creation so the block reads
 * "Progress since <created>".
 */
export function baselineSnapshot(curr: PmUpdateSnapshot, baseline: { created_at: string }): PmUpdateSnapshot {
  return {
    v: 1,
    at: baseline.created_at,
    progress: { scope: 0, started: 0, done: 0 },
    issues_done: 0,
    props: { status: 'planned', priority: 0, lead_user_id: null, start_date: null, target_date: null, health: null },
    milestones: curr.milestones.map((m) => ({ ...m, done: 0, pct: 0, completed_at: null })),
  }
}

/** True when the value is a v1 snapshot (legacy rows before 0064 carry null). */
export function isUpdateSnapshot(value: unknown): value is PmUpdateSnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<PmUpdateSnapshot>
  return v.v === 1 && typeof v.at === 'string' && !!v.props && Array.isArray(v.milestones)
}

const norm = (v: string | number | null | undefined): string | number | null => (v === undefined ? null : v)
const pctEq = (a: number, b: number) => Math.abs(a - b) < 1e-6

/**
 * Diff `curr` against `prev` (the next-older update WITH a snapshot), or
 * against the baseline when there is none.
 *  - props: only the keys whose value changed (status, priority, lead, dates)
 *  - milestones: those whose pct moved, or that are newly complete
 *    (`completed_at` from the current snapshot, null unless 100 %)
 *  - issues_done_delta: completed-issue count now minus then
 */
export function diffProjectUpdate(
  curr: PmUpdateSnapshot,
  prev: PmUpdateSnapshot | null,
  baseline: { created_at: string },
): PmUpdateDiff {
  const base = prev ?? baselineSnapshot(curr, baseline)
  const props: PmUpdateDiffProp[] = []
  for (const key of PM_UPDATE_DIFF_PROP_KEYS) {
    const from = norm(base.props[key])
    const to = norm(curr.props[key])
    if (from !== to) props.push({ key, from, to })
  }
  const before = new Map(base.milestones.map((m) => [m.id, m]))
  const milestones: PmUpdateDiffMilestone[] = []
  for (const m of curr.milestones) {
    const p = before.get(m.id)
    const fromPct = p ? p.pct : 0
    const newlyComplete = pctEq(m.pct, 1) && !(p && pctEq(p.pct, 1))
    if (!pctEq(m.pct, fromPct) || newlyComplete) {
      milestones.push({
        id: m.id,
        name: m.name,
        from_pct: fromPct,
        to_pct: m.pct,
        completed_at: pctEq(m.pct, 1) ? m.completed_at : null,
      })
    }
  }
  return {
    since: base.at,
    props,
    milestones,
    issues_done_delta: curr.issues_done - base.issues_done,
  }
}
