'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Btn, Icon, SectionHead } from '@/components/proto'
import { useHeadcountReport } from '@/lib/api/queries/use-reports'

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const DEPT_PALETTE = ['#3E7BFA', '#27D280', '#9B7BFA', '#FED800', '#F8786B']

function fmtMonth(m: string): string {
  const [, mm] = m.split('-')
  return MONTH_LABELS[Number(mm) - 1] ?? m
}

function employmentTypeLabel(t: string): string {
  switch (t) {
    case 'full_time':  return 'Full-time'
    case 'part_time':  return 'Part-time'
    case 'contract':   return 'Contract'
    case 'intern':     return 'Intern'
    case 'consultant': return 'Consultant'
    case 'probation':  return 'Probation'
    default:           return t
  }
}

export default function HeadcountReportPage() {
  const { data, isLoading } = useHeadcountReport()

  // Headcount line bounds for chart Y-axis scaling
  const yMax = useMemo(() => {
    if (!data) return 1
    return Math.max(1, ...data.monthlyTrend.map((m) => m.headcount))
  }, [data])

  return (
    <div className="relative min-h-full">
      <div className="relative z-10 p-8 max-w-6xl mx-auto">
        <div style={{ marginBottom: 16 }}>
          <Link
            href="/reports"
            className="inline-flex items-center gap-2 text-sm text-brand-muted hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to reports
          </Link>
        </div>

        <SectionHead
          title="Headcount summary"
          sub={
            data
              ? `As of ${data.asOf} · ${data.totals.active} active · ${data.totals.joinedYtd} joined / ${data.totals.exitedYtd} exited YTD`
              : 'Loading…'
          }
          right={<Btn kind="ghost" size="sm" icon={<Icon.download size={13} />} />}
        />

        {isLoading || !data ? (
          <div className="card p-12 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : (
          <>
            {/* KPI strip ────────────────────────────────────────────────── */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 12,
                marginBottom: 18,
              }}
            >
              <Kpi label="Active" value={data.totals.active.toLocaleString()} color="var(--green)" />
              <Kpi label="On leave" value={data.totals.onLeave.toLocaleString()} color="var(--yellow)" />
              <Kpi label="Notice period" value={data.totals.noticePeriod.toLocaleString()} color="var(--coral)" />
              <Kpi
                label="Net change YTD"
                value={
                  (data.totals.netChangeYtd > 0 ? '+' : '') +
                  data.totals.netChangeYtd.toLocaleString()
                }
                color={data.totals.netChangeYtd >= 0 ? 'var(--green)' : 'var(--coral)'}
              />
            </div>

            {/* Headcount trend (last 12 months) ────────────────────────── */}
            <div className="card" style={{ marginBottom: 18 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: 14,
                }}
              >
                <div>
                  <div className="t-h3">Headcount over time</div>
                  <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
                    Last 12 months · joins (green) vs exits (coral) below
                  </div>
                </div>
              </div>

              {/* Line chart for running headcount */}
              <HeadcountLineChart trend={data.monthlyTrend} yMax={yMax} />

              {/* Joins / exits table strip */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(12, 1fr)',
                  gap: 4,
                  marginTop: 16,
                }}
              >
                {data.monthlyTrend.map((m) => (
                  <div
                    key={m.month}
                    style={{
                      padding: '8px 4px',
                      background: 'var(--surf-1)',
                      border: '1px solid var(--bord)',
                      borderRadius: 8,
                      textAlign: 'center',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        color: 'var(--text-mute)',
                      }}
                    >
                      {fmtMonth(m.month)}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 800,
                        marginTop: 2,
                      }}
                    >
                      {m.headcount}
                    </div>
                    <div
                      style={{
                        fontSize: 9.5,
                        marginTop: 2,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {m.joined > 0 && (
                        <span style={{ color: 'var(--green)' }}>+{m.joined} </span>
                      )}
                      {m.exited > 0 && (
                        <span style={{ color: 'var(--coral)' }}>−{m.exited}</span>
                      )}
                      {m.joined === 0 && m.exited === 0 && (
                        <span style={{ color: 'var(--text-faint)' }}>—</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* By department + by location ─────────────────────────────── */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 14,
                marginBottom: 18,
              }}
            >
              <div className="card">
                <div className="t-h3" style={{ marginBottom: 14 }}>By department</div>
                {data.byDepartment.length === 0 ? (
                  <div className="t-mute" style={{ fontSize: 12 }}>
                    No departments configured.
                  </div>
                ) : (
                  <DistributionList
                    rows={data.byDepartment.map((d, i) => ({
                      label: d.name,
                      value: d.headcount,
                      color: DEPT_PALETTE[i % DEPT_PALETTE.length],
                    }))}
                    total={data.totals.active}
                  />
                )}
              </div>

              <div className="card">
                <div className="t-h3" style={{ marginBottom: 14 }}>By location</div>
                {data.byLocation.length === 0 ? (
                  <div className="t-mute" style={{ fontSize: 12 }}>
                    No locations configured.
                  </div>
                ) : (
                  <DistributionList
                    rows={data.byLocation.map((l, i) => ({
                      label: l.name,
                      value: l.headcount,
                      color: DEPT_PALETTE[i % DEPT_PALETTE.length],
                    }))}
                    total={data.totals.active}
                  />
                )}
              </div>
            </div>

            {/* By employment type ──────────────────────────────────────── */}
            <div className="card">
              <div className="t-h3" style={{ marginBottom: 14 }}>By employment type</div>
              {data.byEmploymentType.length === 0 ? (
                <div className="t-mute" style={{ fontSize: 12 }}>
                  No employment types in use.
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${Math.min(6, data.byEmploymentType.length)}, 1fr)`,
                    gap: 10,
                  }}
                >
                  {data.byEmploymentType.map((t) => (
                    <div
                      key={t.type}
                      style={{
                        padding: 12,
                        background: 'var(--surf-1)',
                        border: '1px solid var(--bord)',
                        borderRadius: 9,
                      }}
                    >
                      <div className="t-caption" style={{ fontSize: 11 }}>
                        {employmentTypeLabel(t.type)}
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>
                        {t.headcount}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        padding: 14,
        background: 'var(--surf-1)',
        border: '1px solid var(--bord)',
        borderRadius: 12,
      }}
    >
      <div className="t-caption" style={{ fontSize: 11 }}>{label}</div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          marginTop: 4,
          letterSpacing: '-0.02em',
          color: color ?? 'var(--text)',
        }}
      >
        {value}
      </div>
    </div>
  )
}

function HeadcountLineChart({
  trend,
  yMax,
}: {
  trend: Array<{ month: string; joined: number; exited: number; headcount: number }>
  yMax: number
}) {
  const W = 760
  const H = 140
  const padX = 30
  const padY = 14
  const innerW = W - padX * 2
  const innerH = H - padY * 2
  const step = trend.length > 1 ? innerW / (trend.length - 1) : 0

  const points = trend
    .map((m, i) => {
      const x = padX + i * step
      const y = padY + (1 - m.headcount / yMax) * innerH
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible' }}>
      {/* baseline grid */}
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          x1={padX}
          y1={padY + (1 - f) * innerH}
          x2={W - padX}
          y2={padY + (1 - f) * innerH}
          stroke="rgba(255,255,255,.05)"
          strokeWidth={1}
        />
      ))}
      {/* line */}
      <polyline
        points={points}
        fill="none"
        stroke="#3E7BFA"
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* points */}
      {trend.map((m, i) => {
        const x = padX + i * step
        const y = padY + (1 - m.headcount / yMax) * innerH
        return (
          <circle
            key={m.month}
            cx={x}
            cy={y}
            r={3}
            fill="#3E7BFA"
            stroke="var(--surf-0, #0b0e16)"
            strokeWidth={2}
          >
            <title>{`${fmtMonth(m.month)}: ${m.headcount}`}</title>
          </circle>
        )
      })}
    </svg>
  )
}

function DistributionList({
  rows,
  total,
}: {
  rows: Array<{ label: string; value: number; color: string }>
  total: number
}) {
  const denom = total || rows.reduce((s, r) => s + r.value, 0) || 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((r) => {
        const pct = (r.value / denom) * 100
        return (
          <div key={r.label}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 99,
                    background: r.color,
                  }}
                />
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{r.label}</span>
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 800,
                }}
              >
                {r.value} <span style={{ color: 'var(--text-mute)', fontWeight: 600 }}>· {pct.toFixed(0)}%</span>
              </span>
            </div>
            <div
              style={{
                width: '100%',
                height: 5,
                borderRadius: 99,
                background: 'var(--surf-2)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: r.color,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
