'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, SectionHead } from '@/components/proto'
import { useUtilizationReport } from '@/lib/api/queries/use-reports'

const RANGES = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
] as const

function rangeFor(days: number): { from: string; to: string } {
  const today = new Date()
  const to = today.toISOString().slice(0, 10)
  const fromDate = new Date(today)
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1))
  return { from: fromDate.toISOString().slice(0, 10), to }
}

function fmtDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  })
}

const h1 = (n: number) => `${n.toFixed(1)}h`
const pct = (n: number) => `${(n * 100).toFixed(0)}%`

export default function UtilizationReportPage() {
  const [rangeId, setRangeId] = useState<(typeof RANGES)[number]['id']>('30')
  const range = useMemo(
    () => rangeFor(RANGES.find((r) => r.id === rangeId)!.days),
    [rangeId],
  )
  const { data, isLoading } = useUtilizationReport(range)

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
          title="Timesheet utilization"
          sub={
            data
              ? `${fmtDate(data.range.from)} – ${fmtDate(data.range.to)} · billable vs non-billable hours`
              : 'Loading…'
          }
          right={
            <div style={{ display: 'flex', gap: 6 }}>
              {RANGES.map((r) => (
                <Btn
                  key={r.id}
                  kind={rangeId === r.id ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setRangeId(r.id)}
                >
                  {r.label}
                </Btn>
              ))}
              <Btn kind="ghost" size="sm" icon={<Icon.download size={13} />} />
            </div>
          }
        />

        {isLoading || !data ? (
          <div className="card p-12 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 12,
                marginBottom: 18,
              }}
            >
              <Kpi label="Total hours" value={h1(data.totals.totalHours)} />
              <Kpi label="Billable" value={h1(data.totals.billableHours)} color="var(--green)" />
              <Kpi label="Non-billable" value={h1(data.totals.nonBillableHours)} color="var(--yellow)" />
              <Kpi label="Utilization" value={pct(data.totals.utilization)} color="var(--blue)" />
            </div>

            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--bord)' }}>
                <div className="t-h3">By employee</div>
                <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
                  Sorted by total hours logged in this window
                </div>
              </div>

              {data.byEmployee.length === 0 ? (
                <div className="t-mute" style={{ padding: 28, textAlign: 'center', fontSize: 12 }}>
                  No timesheet hours logged in this window.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                      <th style={th}>Employee</th>
                      <th style={th}>Billable</th>
                      <th style={th}>Non-billable</th>
                      <th style={th}>Total</th>
                      <th style={th}>Utilization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byEmployee.map((e, i, arr) => (
                      <tr
                        key={e.employeeId}
                        style={{
                          borderBottom: i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                        }}
                      >
                        <td style={{ padding: '12px 14px' }}>
                          <div className="flex items-center gap-3">
                            <Avatar name={e.name ?? '—'} size="sm" />
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 800 }}>{e.name ?? '—'}</div>
                              {e.employeeCode && (
                                <div style={{ fontSize: 11, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>
                                  {e.employeeCode}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{h1(e.billableHours)}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{h1(e.nonBillableHours)}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{h1(e.totalHours)}</td>
                        <td style={td}>
                          <UtilBar value={e.utilization} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

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

function UtilBar({ value }: { value: number }) {
  const p = Math.max(0, Math.min(1, value))
  const color = p >= 0.7 ? '#27D280' : p >= 0.4 ? '#FED800' : '#F8786B'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 110 }}>
      <div
        style={{
          flex: 1,
          height: 5,
          borderRadius: 99,
          background: 'var(--surf-2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${p * 100}%`, height: '100%', background: color }} />
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700, minWidth: 40 }}>
        {(p * 100).toFixed(0)}%
      </span>
    </div>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 11.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-mute)',
}

const td: React.CSSProperties = {
  padding: '12px 14px',
  fontSize: 12.5,
  color: 'var(--text-2)',
}
