'use client'

import { useMemo } from 'react'
import { computed } from 'mobx'
import { observer } from 'mobx-react-lite'
import {
  buildProgressSeries,
  predictCompletion,
  weekMondayISO,
  type PmCompletionPrediction,
  type PmProgressPoint,
} from '@flicks/shared/pm'
import { Icon, Skeleton } from '@/components/proto'
import { useProjectInsights } from '@/lib/api/queries/use-pm-insights'
import type { PmSyncEngine } from '@/lib/pm/engine'
import { niceCeil, storeInsightInputs } from './ProjectInsightsCard'

// ─────────────────────────────────────────────────────────
// Round M — Project page rail: the Progress graph (Linear's right rail).
// Weekly scope / started / done from issue timestamps, a dotted continuation
// from the last `done` point to the predicted completion, and a marker at
// the project's target date. Hand-rolled SVG: the plot stretches to the
// card's width (preserveAspectRatio="none" + non-scaling strokes); every
// piece of text is HTML, so nothing distorts. Sync mode computes from the
// FSE store synchronously; REST mode shares the Insights card's one query.
// ─────────────────────────────────────────────────────────

export interface ProjectProgressGraphProps {
  projectId: string
  engine: PmSyncEngine | null
  /** The project's target date (YYYY-MM-DD) — live from the page's merged project row. */
  targetDate: string | null | undefined
}

const W = 320
const H = 140
const PAD = { top: 6, right: 6, bottom: 4, left: 2 }
const WEEK_MS = 7 * 86_400_000
const HORIZON_WEEKS = 26

const dayMs = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).getTime()
const fmtDay = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

interface Plot {
  points: Array<{ x: number; scope: number; started: number; done: number }>
  xStart: number
  xEnd: number
  yMax: number
  nowX: number
  predX: number | null
  predClipped: boolean
  /** y-value where the dotted prediction line ends: full scope, or the interpolated value at the right edge when clipped. */
  predEndValue: number | null
  targetX: number | null
  targetClipped: boolean
  behindTarget: boolean
}

function layout(series: PmProgressPoint[], prediction: PmCompletionPrediction, targetDate: string | null, nowMs: number): Plot {
  const weekStart = (p: PmProgressPoint) => dayMs(p.week)
  // Each point sits at the END of its week (the value is the state then); the
  // current week's point sits at "now".
  const rawPoints = series.map((p) => ({ x: Math.min(weekStart(p) + WEEK_MS, nowMs), ...p }))
  const xStart = weekStart(series[0]!)
  const predMs = prediction.predicted_completion ? dayMs(prediction.predicted_completion) : null
  const targetMs = targetDate ? dayMs(targetDate) : null
  const horizonCap = nowMs + HORIZON_WEEKS * WEEK_MS
  const wanted = Math.max(nowMs, predMs ?? 0, targetMs ?? 0)
  let xEnd = Math.min(wanted, horizonCap)
  if (xEnd - xStart < WEEK_MS) xEnd = xStart + WEEK_MS
  const yMax = niceCeil(Math.max(1, ...series.map((p) => p.scope)))
  // Markers stay inside the plot: a target before the first week sits on the
  // left edge (never off-canvas over the y-axis), anything past the horizon on
  // the right edge with a "→" in the footer.
  const clip = (t: number | null) => (t == null ? null : Math.min(Math.max(t, xStart), xEnd))
  const nowX = Math.min(nowMs, xEnd)
  const last = series[series.length - 1]!
  const predClipped = predMs != null && predMs > xEnd
  // When the prediction is clipped, the dotted line keeps its true slope and
  // ends at the interpolated value at the right edge instead of jumping to scope.
  const predEndValue =
    predMs == null
      ? null
      : predClipped && predMs > nowX
        ? last.done + (last.scope - last.done) * ((xEnd - nowX) / (predMs - nowX))
        : last.scope
  return {
    points: rawPoints,
    xStart,
    xEnd,
    yMax,
    nowX,
    predX: clip(predMs),
    predClipped,
    predEndValue,
    targetX: clip(targetMs),
    targetClipped: targetMs != null && targetMs > xEnd,
    behindTarget: predMs != null && targetMs != null && predMs > targetMs,
  }
}

export const ProjectProgressGraph = observer(function ProjectProgressGraph({ projectId, engine, targetDate }: ProjectProgressGraphProps) {
  const rest = useProjectInsights(projectId, { enabled: !engine })
  // "now" per render, but the series/prediction only change with the date
  // (weekly buckets), so the memo keys on the day, not the instant.
  const now = new Date()
  const nowISO = now.toISOString()
  const today = nowISO.slice(0, 10)

  // Sync mode: one MobX computed over the store (cached until an issue row
  // it read changes), same shared math the server runs for REST mode.
  const storeSeries = useMemo(
    () =>
      engine
        ? computed(() => {
            const { issues, lookups } = storeInsightInputs(engine.store, projectId)
            const series = buildProgressSeries(issues, { to: `${today}T23:59:59.999Z`, states: lookups.states })
            return { series, prediction: predictCompletion(series, today) }
          })
        : null,
    [engine, projectId, today],
  )
  const data = storeSeries ? storeSeries.get() : rest.data ? { series: rest.data.data.series, prediction: rest.data.data.prediction } : null
  const target = targetDate ?? (rest.data?.data.target_date ?? null)

  const plot = useMemo(() => (data && data.series.length ? layout(data.series, data.prediction, target, now.getTime()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, target, today])

  const predicted = data?.prediction.predicted_completion ?? null
  const velocity = data?.prediction.velocity_per_week ?? null
  const last = data?.series[data.series.length - 1]
  const remaining = last ? last.scope - last.done : 0

  // Copy for the owner, not the analyst: "pace", "done a week", "past target".
  const pace = velocity != null && velocity > 0 ? (velocity >= 10 ? String(Math.round(velocity)) : velocity.toFixed(1).replace(/\.0$/, '')) : null
  const daysPastTarget =
    predicted && target && dayMs(predicted) > dayMs(target) ? Math.round((dayMs(predicted) - dayMs(target)) / 86_400_000) : 0
  const weeksPastTarget = Math.round(daysPastTarget / 7)
  const pastTarget =
    daysPastTarget >= 7
      ? `${weeksPastTarget} ${weeksPastTarget === 1 ? 'week' : 'weeks'} past target`
      : daysPastTarget > 0
        ? `${daysPastTarget} ${daysPastTarget === 1 ? 'day' : 'days'} past target`
        : ''

  const caption = !data
    ? ''
    : predicted
      ? `Predicted: ${fmtDay(predicted)}`
      : velocity == null
        ? 'Not enough history to predict yet'
        : remaining <= 0
          ? 'All issues done'
          : 'Nothing finished in recent weeks, so no prediction yet'

  const sx = (t: number) => (plot ? PAD.left + ((t - plot.xStart) / Math.max(1, plot.xEnd - plot.xStart)) * (W - PAD.left - PAD.right) : 0)
  const sy = (v: number) => (plot ? H - PAD.bottom - (v / plot.yMax) * (H - PAD.top - PAD.bottom) : 0)
  const line = (key: 'scope' | 'started' | 'done') => (plot ? plot.points.map((p) => `${sx(p.x)},${sy(p[key])}`).join(' ') : '')
  const ticks = [1, 0.75, 0.5, 0.25]

  // x-axis labels at their TRUE positions (percent of the plot width): 3–4
  // dates across the span plus the target; a date within reach of the target
  // label steps aside for it.
  const xPct = (t: number) => (sx(t) / W) * 100
  const xLabels: Array<{ key: string; pct: number; text: string; tone?: 'target' }> = []
  if (plot) {
    const span = plot.xEnd - plot.xStart
    const fracs = span >= 3 * WEEK_MS ? [0, 1 / 3, 2 / 3, 1] : [0, 1]
    for (const f of fracs) {
      const t = plot.xStart + f * span
      const isEnd = f === 1
      const text = isEnd && plot.xEnd <= plot.nowX + 1 ? 'Today' : fmtDay(new Date(t).toISOString())
      xLabels.push({ key: `t${f}`, pct: xPct(t), text: isEnd && plot.predClipped ? `${text} →` : text })
    }
    if (plot.targetX != null && target) {
      const pct = xPct(plot.targetX)
      for (let i = xLabels.length - 1; i >= 0; i--) if (Math.abs(xLabels[i]!.pct - pct) < 20) xLabels.splice(i, 1)
      xLabels.push({ key: 'target', pct, text: `Target ${fmtDay(target)}${plot.targetClipped ? ' →' : ''}`, tone: 'target' })
    }
  }

  return (
    <div
      className="card"
      data-testid="project-progress-graph"
      data-points={data?.series.length ?? 0}
      data-predicted={predicted ?? 'none'}
      style={{ padding: '12px 14px' }}
    >
      {/* Title + legend (this week's values). Wraps onto a second line rather
          than squeezing when the numbers get wide. */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px', marginBottom: 8 }}>
        <Icon.trend size={13} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, fontWeight: 800, flex: '1 0 auto' }}>Progress</span>
        {last && (
          [['var(--text-faint)', 'Scope', last.scope], ['var(--yellow)', 'Started', last.started], ['var(--green)', 'Done', last.done]] as Array<[string, string, number]>
        ).map(([col, l, v]) => (
          <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--text-faint)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: col, flexShrink: 0 }} />{l} <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{v}</span>
          </span>
        ))}
      </div>

      {!data ? (
        rest.isError ? (
          <div className="t-mute" style={{ fontSize: 11.5, padding: '8px 0' }}>
            Couldn’t load the graph.{' '}
            <button type="button" onClick={() => void rest.refetch()} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--blue)', fontWeight: 800, fontSize: 11.5, cursor: 'pointer' }}>Retry</button>
          </div>
        ) : (
          /* Same footprint as the loaded card: plot + axis row + caption lines. */
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Skeleton h={H} r={8} style={{ marginLeft: 32, width: 'auto' }} />
            <Skeleton h={12} w="55%" />
            <Skeleton h={12} w="85%" />
          </div>
        )
      ) : !plot ? (
        <div className="t-mute" style={{ padding: '18px 0 8px', textAlign: 'center', fontSize: 11.5 }}>
          No issues yet — add issues to see the graph
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ position: 'relative', width: 26, height: H, flexShrink: 0 }}>
              {ticks.map((t) => (
                <span key={t} style={{ position: 'absolute', right: 2, top: `${((sy(plot.yMax * t)) / H) * 100}%`, transform: 'translateY(-50%)', fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                  {plot.yMax * t}
                </span>
              ))}
              <span style={{ position: 'absolute', right: 2, top: `${(sy(0) / H) * 100}%`, transform: 'translateY(-50%)', fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>0</span>
            </div>
            <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                width="100%"
                height={H}
                preserveAspectRatio="none"
                style={{ display: 'block', overflow: 'visible' }}
                role="img"
                aria-label={`Scope ${last!.scope}, started ${last!.started}, done ${last!.done} this week. ${caption}${pastTarget ? ` · ${pastTarget}` : ''}`}
              >
                {ticks.map((t) => (
                  <line key={t} x1={PAD.left} x2={W - PAD.right} y1={sy(plot.yMax * t)} y2={sy(plot.yMax * t)} stroke="var(--bord)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
                ))}
                <line x1={PAD.left} x2={W - PAD.right} y1={sy(0)} y2={sy(0)} stroke="var(--bord-2)" vectorEffect="non-scaling-stroke" />

                {/* target-date marker */}
                {plot.targetX != null && (
                  <line
                    x1={sx(plot.targetX)} x2={sx(plot.targetX)} y1={PAD.top} y2={sy(0)}
                    stroke={plot.behindTarget ? 'var(--coral)' : 'var(--text-faint)'} strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
                    data-testid="progress-target-marker"
                  />
                )}

                {/* history */}
                <polyline points={line('scope')} fill="none" stroke="var(--text-faint)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <polyline points={line('started')} fill="none" stroke="var(--yellow)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <polyline points={line('done')} fill="none" stroke="var(--green)" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

                {/* dotted continuation → predicted completion */}
                {plot.predX != null && (
                  <line
                    x1={sx(plot.nowX)} y1={sy(last!.done)} x2={sx(plot.predX)} y2={sy(plot.predEndValue ?? last!.scope)}
                    stroke="var(--green)" strokeWidth={1.4} strokeDasharray="3 3" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity={0.6}
                    data-testid="progress-prediction-line"
                  />
                )}
                {plot.predX != null && !plot.predClipped && (
                  <rect x={sx(plot.predX) - 2.5} y={sy(last!.scope) - 2.5} width={5} height={5} fill="var(--green)" />
                )}
                {/* one week of history → nothing to join yet; show the three values as dots */}
                {plot.points.length === 1 && (
                  <>
                    <rect x={sx(plot.nowX) - 2} y={sy(last!.scope) - 2} width={4} height={4} fill="var(--text-faint)" />
                    <rect x={sx(plot.nowX) - 2} y={sy(last!.started) - 2} width={4} height={4} fill="var(--yellow)" />
                  </>
                )}
                <rect x={sx(plot.nowX) - 2} y={sy(last!.done) - 2} width={4} height={4} fill="var(--green)" />
              </svg>
            </div>
          </div>
          {/* x-axis: each label under its own x; first/last hug the edges */}
          <div style={{ position: 'relative', height: 14, marginLeft: 32, marginTop: 4 }} data-testid="progress-x-axis">
            {xLabels.map((l) => (
              <span
                key={l.key}
                style={{
                  position: 'absolute', top: 0, whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 700,
                  color: l.tone === 'target' ? (plot.behindTarget ? 'var(--coral)' : 'var(--text-mute)') : 'var(--text-faint)',
                  ...(l.pct <= 8 ? { left: 0 } : l.pct >= 92 ? { right: 0 } : { left: `${l.pct}%`, transform: 'translateX(-50%)' }),
                }}
              >
                {l.text}
              </span>
            ))}
          </div>
          <div
            data-testid="progress-caption"
            style={{ marginTop: 8, fontSize: 11.5, fontWeight: 800, lineHeight: 1.4, color: predicted ? (plot.behindTarget ? 'var(--coral)' : 'var(--green)') : 'var(--text-mute)' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '0 6px' }}>
              {predicted && <span style={{ width: 10, borderTop: '2px dotted currentColor' }} />}
              <span>{caption}</span>
              {pastTarget && <span style={{ fontWeight: 700 }}>· {pastTarget}</span>}
            </span>
            {pace && remaining > 0 && (
              <div style={{ fontWeight: 700, color: 'var(--text-faint)' }}>{remaining} left · about {pace} done a week</div>
            )}
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.45 }}>
            Counted weekly · this week (from {fmtDay(weekMondayISO(nowISO))}) is still in progress · canceled issues not counted
            {!engine && rest.data?.data.truncated ? ` · ${rest.data.data.issue_cap.toLocaleString()} most recent issues only` : ''}
          </div>
        </>
      )}
    </div>
  )
})
