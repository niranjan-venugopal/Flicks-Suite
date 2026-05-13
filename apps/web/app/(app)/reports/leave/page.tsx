'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useLeaveReport } from '@/lib/api/queries/use-reports'

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function LeaveReportPage() {
  const { data, isLoading } = useLeaveReport({})

  const trendMax = useMemo(() => {
    if (!data) return 1
    return Math.max(1, ...data.monthlyTrend.map((m) => m.days))
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
          title="Leave consumption"
          sub={
            data
              ? `${data.range.from} → ${data.range.to} · ${data.totals.requests} requests · ${data.totals.approvedDays} approved days`
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
              <Kpi label="Total requests" value={data.totals.requests.toLocaleString()} />
              <Kpi label="Approved days" value={data.totals.approvedDays.toFixed(1)} color="var(--green)" />
              <Kpi label="Pending" value={data.totals.pending.toLocaleString()} color="var(--yellow)" />
              <Kpi label="Rejected" value={data.totals.rejected.toLocaleString()} color="var(--coral)" />
            </div>

            {/* Monthly trend + By type ─────────────────────────────────── */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 1fr',
                gap: 14,
                marginBottom: 18,
              }}
            >
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                  <div>
                    <div className="t-h3">Approved leave days</div>
                    <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
                      By month, current year
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 6,
                    height: 180,
                  }}
                >
                  {data.monthlyTrend.map((m, i) => {
                    const h = (m.days / trendMax) * 140
                    return (
                      <div
                        key={m.month}
                        style={{
                          flex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 6,
                        }}
                        title={`${MONTH_LABELS[i]}: ${m.days} days`}
                      >
                        <div
                          style={{
                            fontSize: 10.5,
                            fontFamily: 'var(--font-mono)',
                            color: m.days > 0 ? 'var(--text)' : 'var(--text-faint)',
                            fontWeight: 700,
                          }}
                        >
                          {m.days > 0 ? m.days.toFixed(0) : ''}
                        </div>
                        <div
                          style={{
                            width: '100%',
                            height: Math.max(2, h),
                            background:
                              m.days > 0
                                ? 'linear-gradient(180deg, #9B7BFA 0%, #3E7BFA 100%)'
                                : 'var(--surf-2)',
                            borderRadius: '4px 4px 0 0',
                          }}
                        />
                        <div
                          style={{
                            fontSize: 10.5,
                            color: 'var(--text-mute)',
                            fontWeight: 700,
                          }}
                        >
                          {MONTH_LABELS[i]}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="card">
                <div className="t-h3" style={{ marginBottom: 14 }}>
                  By type
                </div>
                {data.byType.length === 0 ? (
                  <div className="t-mute" style={{ fontSize: 12 }}>
                    No leave types configured.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {data.byType.map((t) => (
                      <div key={t.leaveTypeId}>
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
                                background: t.color ?? '#3E7BFA',
                              }}
                            />
                            <span style={{ fontSize: 12.5, fontWeight: 700 }}>{t.name}</span>
                            <Pill>{t.code}</Pill>
                          </span>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              fontWeight: 800,
                            }}
                          >
                            {t.approvedDays.toFixed(1)}d
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 10.5,
                            color: 'var(--text-mute)',
                          }}
                        >
                          <span>{t.approvedRequests} approved</span>
                          {t.pendingRequests > 0 && (
                            <span style={{ color: 'var(--yellow)' }}>{t.pendingRequests} pending</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Top consumers ────────────────────────────────────────────── */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--bord)' }}>
                <div className="t-h3">Top consumers</div>
                <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
                  Top 10 by approved days in this window
                </div>
              </div>

              {data.topConsumers.length === 0 ? (
                <div className="t-mute" style={{ padding: 28, textAlign: 'center', fontSize: 12 }}>
                  No approved leave in this window.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                      <th style={th}>Employee</th>
                      <th style={th}>Department</th>
                      <th style={th}>Requests</th>
                      <th style={th}>Approved days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topConsumers.map((c, i, arr) => (
                      <tr
                        key={c.employeeId}
                        style={{
                          borderBottom: i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                        }}
                      >
                        <td style={{ padding: '12px 14px' }}>
                          <div className="flex items-center gap-3">
                            <Avatar name={c.name ?? '—'} size="sm" src={c.avatarUrl ?? undefined} />
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 800 }}>{c.name ?? '—'}</div>
                              {c.employeeCode && (
                                <div style={{ fontSize: 11, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>
                                  {c.employeeCode}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={td}>{c.departmentName ?? '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{c.requestCount}</td>
                        <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                          {c.approvedDays.toFixed(1)}
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
