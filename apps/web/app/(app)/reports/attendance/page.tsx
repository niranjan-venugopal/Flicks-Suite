'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Avatar, Btn, Donut, Icon, SectionHead } from '@/components/proto'
import { useAttendanceReport } from '@/lib/api/queries/use-reports'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RANGES = [
  { id: '7',  label: 'Last 7 days',  days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
] as const

function rangeFor(days: number): { from: string; to: string } {
  const today = new Date()
  const to = today.toISOString().slice(0, 10)
  const fromDate = new Date(today)
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1))
  const from = fromDate.toISOString().slice(0, 10)
  return { from, to }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function fmtDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  })
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AttendanceReportPage() {
  const [rangeId, setRangeId] = useState<(typeof RANGES)[number]['id']>('30')
  const range = useMemo(
    () => rangeFor(RANGES.find((r) => r.id === rangeId)!.days),
    [rangeId],
  )
  const { data, isLoading } = useAttendanceReport(range)

  const donutData = useMemo(() => {
    if (!data) return []
    return [
      { label: 'Present',  value: data.totals.present,      color: '#27D280' },
      { label: 'Late',     value: data.totals.late,         color: '#FED800' },
      { label: 'WFH',      value: data.totals.workFromHome, color: '#3E7BFA' },
      { label: 'On leave', value: data.totals.onLeave,      color: '#9B7BFA' },
      { label: 'Absent',   value: data.totals.absent,       color: '#F8786B' },
    ].filter((s) => s.value > 0)
  }, [data])

  const trendMax = useMemo(() => {
    if (!data) return 1
    let m = 0
    for (const d of data.dailyTrend) {
      const total = d.present + d.late + d.onLeave + d.absent + d.wfh
      if (total > m) m = total
    }
    return m || 1
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
          title="Attendance compliance"
          sub={
            data
              ? `${fmtDate(data.range.from)} – ${fmtDate(data.range.to)} · ${data.range.daysInRange} days · ${data.totals.total.toLocaleString()} records`
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
              <Kpi label="Total records" value={data.totals.total.toLocaleString()} />
              <Kpi label="Present rate" value={pct(data.compliance.presentRate)} color="var(--green)" />
              <Kpi label="Late rate" value={pct(data.compliance.lateRate)} color="var(--yellow)" />
              <Kpi label="Avg lateness" value={`${data.compliance.avgLateMinutes}m`} color="var(--coral)" />
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '320px 1fr',
                gap: 14,
                marginBottom: 18,
              }}
            >
              <div className="card">
                <div className="t-h3" style={{ marginBottom: 14 }}>Status breakdown</div>
                {donutData.length === 0 ? (
                  <div className="t-mute" style={{ fontSize: 12 }}>
                    No attendance recorded in this window.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                    <Donut
                      segments={donutData.map((s) => ({ value: s.value, color: s.color }))}
                      size={160}
                      label={data.totals.total.toLocaleString()}
                      sub="records"
                    />
                    <div style={{ width: '100%' }}>
                      {donutData.map((s) => (
                        <div
                          key={s.label}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '6px 0',
                            borderTop: '1px solid var(--bord)',
                            fontSize: 12,
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 99, background: s.color }} />
                            <span style={{ fontWeight: 700 }}>{s.label}</span>
                          </span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{s.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="card">
                <div className="t-h3" style={{ marginBottom: 14 }}>Daily trend</div>
                {data.dailyTrend.length === 0 ? (
                  <div className="t-mute" style={{ fontSize: 12 }}>No data in this window.</div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-end',
                      gap: 4,
                      height: 200,
                    }}
                  >
                    {data.dailyTrend.map((d) => {
                      const total = d.present + d.late + d.onLeave + d.absent + d.wfh
                      const h = (total / trendMax) * 160
                      return (
                        <div
                          key={d.date}
                          style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 4,
                            minWidth: 12,
                          }}
                          title={`${fmtDate(d.date)}: ${total} records (${d.present}P / ${d.late}L / ${d.absent}A)`}
                        >
                          <div
                            style={{
                              width: '100%',
                              height: h,
                              display: 'flex',
                              flexDirection: 'column-reverse',
                              borderRadius: '4px 4px 0 0',
                              overflow: 'hidden',
                              background: 'var(--surf-2)',
                            }}
                          >
                            {d.present > 0 && (
                              <div style={{ height: `${(d.present / total) * 100}%`, background: '#27D280' }} />
                            )}
                            {d.late > 0 && (
                              <div style={{ height: `${(d.late / total) * 100}%`, background: '#FED800' }} />
                            )}
                            {d.wfh > 0 && (
                              <div style={{ height: `${(d.wfh / total) * 100}%`, background: '#3E7BFA' }} />
                            )}
                            {d.onLeave > 0 && (
                              <div style={{ height: `${(d.onLeave / total) * 100}%`, background: '#9B7BFA' }} />
                            )}
                            {d.absent > 0 && (
                              <div style={{ height: `${(d.absent / total) * 100}%`, background: '#F8786B' }} />
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 9,
                              color: 'var(--text-mute)',
                              fontFamily: 'var(--font-mono)',
                              whiteSpace: 'nowrap',
                              writingMode: 'vertical-rl',
                              transform: 'rotate(180deg)',
                            }}
                          >
                            {fmtDate(d.date)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--bord)' }}>
                <div className="t-h3">By employee</div>
                <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
                  Top 20 by record count in this window
                </div>
              </div>

              {data.byEmployee.length === 0 ? (
                <div className="t-mute" style={{ padding: 28, textAlign: 'center', fontSize: 12 }}>
                  No employee activity in this window.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                      <th style={th}>Employee</th>
                      <th style={th}>Department</th>
                      <th style={th}>Records</th>
                      <th style={th}>Present</th>
                      <th style={th}>Late</th>
                      <th style={th}>Avg lateness</th>
                      <th style={th}>Hours</th>
                      <th style={th}>Compliance</th>
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
                            <Avatar name={e.name ?? '—'} size="sm" src={e.avatarUrl ?? undefined} />
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
                        <td style={td}>{e.departmentName ?? '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{e.recordCount}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{e.presentCount}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{e.lateCount}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>
                          {e.avgLateMinutes > 0 ? `${e.avgLateMinutes}m` : '—'}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{e.hoursWorked}h</td>
                        <td style={td}>
                          <ComplianceBar value={e.complianceRate} />
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

// ─── Small components ────────────────────────────────────────────────────────

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

function ComplianceBar({ value }: { value: number }) {
  const p = Math.max(0, Math.min(1, value))
  const color = p >= 0.9 ? '#27D280' : p >= 0.7 ? '#FED800' : '#F8786B'
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
