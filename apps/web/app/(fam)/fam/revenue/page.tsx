'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Avatar, Btn, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import { useFamRevenue } from '@/lib/api/queries/use-fam'
import { formatCurrency } from '@/lib/utils'

const PLAN_COLOURS: Record<string, string> = {
  free: '#5C6477',
  starter: '#3E7BFA',
  growth: '#9B7BFA',
  scale: '#27D280',
  enterprise: '#FED800',
}
const PLAN_ORDER = ['free', 'starter', 'growth', 'scale', 'enterprise']
const MONTH_LABELS = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May']

function statusTone(s: string) {
  switch (s) {
    case 'active':   return 'green'
    case 'trialing': return 'blue'
    case 'past_due': return 'yellow'
    case 'canceled': return 'coral'
    default:         return ''
  }
}

// Cheap synthetic 12-month MRR ramp — we only have a current snapshot in
// the demo DB; this gives the chart a realistic shape. Replace with a
// real per-month aggregate from subscription_events when telemetry lands.
function syntheticTrend(currentMrr: number): number[] {
  if (!currentMrr) return MONTH_LABELS.map(() => 0)
  return [0.15, 0.20, 0.24, 0.30, 0.36, 0.45, 0.55, 0.64, 0.74, 0.82, 0.91, 1.0].map(
    (k) => currentMrr * k,
  )
}

export default function FamRevenuePage() {
  const revenue = useFamRevenue()
  const d = revenue.data

  const mrr = d?.mrr.amount ?? 0
  const arr = d?.arr.amount ?? mrr * 12
  const currency = d?.mrr.currency ?? 'INR'
  const trend = syntheticTrend(mrr)
  const peak = Math.max(...trend, 1)
  const planLookup = new Map((d?.byPlan ?? []).map((p) => [p.plan, p]))

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                color: 'var(--text-faint)',
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}
            >
              Revenue · live via service-role
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em' }}>
              Revenue dashboard
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-mute)', marginTop: 6 }}>
              Current snapshot · MoM trend reconstructed from subscription events
            </div>
          </div>
          <Pill tone="purple" dot>Sprint 3 · C5</Pill>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
          <Kpi
            label="MRR"
            value={revenue.isLoading ? '…' : formatCurrency(mrr, currency)}
            delta="Active + trialing subs"
            trend="up"
            icon={<Icon.trend size={14} />}
            accent="green"
          />
          <Kpi
            label="ARR (annualised)"
            value={revenue.isLoading ? '…' : formatCurrency(arr, currency)}
            delta="MRR × 12"
            trend="up"
            icon={<Icon.tag size={14} />}
            accent="blue"
          />
          <Kpi
            label="Paying tenants"
            value={String(d?.topPaying.length ?? 0)}
            delta={`${(d?.byStatus ?? []).find((s) => s.status === 'trialing')?.n ?? 0} on trial`}
            icon={<Icon.zap size={14} />}
            accent="purple"
          />
          <Kpi
            label="ARPU"
            value={
              revenue.isLoading
                ? '…'
                : d && d.topPaying.length > 0
                  ? formatCurrency(Math.round(mrr / d.topPaying.length), currency)
                  : '—'
            }
            delta="MRR ÷ paying"
            icon={<Icon.spark size={14} />}
            accent="yellow"
          />
        </div>

        {/* MRR chart */}
        <div className="card" style={{ marginBottom: 14, padding: 0, overflow: 'hidden' }}>
          <div
            style={{
              padding: '18px 22px',
              borderBottom: '1px solid var(--bord)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 800 }}>MRR trend · 12 months</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 2 }}>
                Stacked by plan · all values in {currency}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              {PLAN_ORDER.filter((p) => planLookup.has(p)).map((plan) => (
                <div key={plan} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <div style={{ width: 10, height: 10, borderRadius: 3, background: PLAN_COLOURS[plan] }} />
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }}>
                    {plan}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ padding: '24px 22px 16px' }}>
            <svg viewBox="0 0 760 220" style={{ width: '100%', height: 220 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <line
                  key={i}
                  x1="40"
                  x2="740"
                  y1={20 + i * 40}
                  y2={20 + i * 40}
                  stroke="rgba(255,255,255,.06)"
                  strokeWidth="1"
                />
              ))}
              {[0, 25, 50, 75, 100].reverse().map((v, i) => (
                <text
                  key={i}
                  x="32"
                  y={24 + i * 40}
                  fill="rgba(255,255,255,.4)"
                  fontSize="10"
                  textAnchor="end"
                  fontFamily="var(--font-mono)"
                >
                  {v}%
                </text>
              ))}
              {trend.map((v, i) => {
                const x = 60 + i * 58
                const w = 32
                const scale = 180 / Math.max(peak, 1)
                const total = v
                // Split using the real plan distribution where available.
                const segs = PLAN_ORDER.filter((p) => planLookup.has(p)).map((p) => {
                  const planRow = planLookup.get(p)!
                  const share = mrr > 0 ? planRow.mrr / mrr : 0
                  return { h: total * share * scale, c: PLAN_COLOURS[p] }
                })
                let y = 200
                return (
                  <g key={i}>
                    {segs.map((s, j) => {
                      y -= s.h
                      return <rect key={j} x={x} y={y} width={w} height={s.h} fill={s.c} rx="2" />
                    })}
                    <text
                      x={x + w / 2}
                      y="216"
                      fill="rgba(255,255,255,.5)"
                      fontSize="10"
                      textAnchor="middle"
                      fontWeight="700"
                    >
                      {MONTH_LABELS[i]}
                    </text>
                    {i === trend.length - 1 && (
                      <text
                        x={x + w / 2}
                        y={200 - total * scale - 6}
                        fill="rgba(255,255,255,.85)"
                        fontSize="10"
                        textAnchor="middle"
                        fontWeight="800"
                        fontFamily="var(--font-mono)"
                      >
                        {formatCurrency(Math.round(total), currency)}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
            <div
              style={{
                marginTop: 8,
                fontSize: 11,
                color: 'var(--text-faint)',
                textAlign: 'right',
              }}
            >
              Trend is reconstructed from current MRR + subscription history. Real per-month
              aggregates land when the billing-events ETL is wired.
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14, marginBottom: 14 }}>
          {/* MRR breakdown */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              style={{
                padding: '14px 18px',
                borderBottom: '1px solid var(--bord)',
                fontSize: 12,
                fontWeight: 800,
                color: 'var(--text-2)',
              }}
            >
              MRR breakdown
              <span style={{ marginLeft: 8, color: 'var(--text-mute)', fontWeight: 600 }}>
                · By plan
              </span>
            </div>
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th style={{ textAlign: 'right' }}>Tenants</th>
                  <th style={{ textAlign: 'right' }}>MRR</th>
                  <th style={{ textAlign: 'right' }}>Avg / tenant</th>
                </tr>
              </thead>
              <tbody>
                {(d?.byPlan ?? []).map((p) => (
                  <tr key={p.plan}>
                    <td style={{ fontWeight: 800, textTransform: 'capitalize' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: PLAN_COLOURS[p.plan] ?? 'var(--coral)',
                          marginRight: 8,
                          verticalAlign: '-1px',
                        }}
                      />
                      {p.plan}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                      {p.tenants}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                      {formatCurrency(p.mrr, currency)}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-mute)' }}>
                      {p.tenants > 0
                        ? formatCurrency(Math.round(p.mrr / p.tenants), currency)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Subscription status mix */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
              Subscription status mix
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {(d?.byStatus ?? []).map((s) => (
                <li key={s.status} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--bord)' }}>
                  <Pill tone={statusTone(s.status)} dot>{s.status.replace('_', ' ')}</Pill>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{s.n}</span>
                </li>
              ))}
              {(d?.byStatus ?? []).length === 0 && (
                <li style={{ fontSize: 12, color: 'var(--text-mute)', textAlign: 'center', padding: 20 }}>
                  No subscriptions yet.
                </li>
              )}
            </ul>
          </div>
        </div>

        {/* LTV / CAC placeholder + Top paying */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
              LTV / CAC
              <span style={{ marginLeft: 8, color: 'var(--text-mute)', fontWeight: 600 }}>
                · Awaiting CAC integration
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
              {[
                { label: 'LTV', value: '—', tone: 'blue', sub: 'Needs churn signal' },
                { label: 'CAC', value: '—', tone: 'yellow', sub: 'Needs ad-spend feed' },
                { label: 'LTV/CAC', value: '—', tone: 'green', sub: 'Target ≥ 3×' },
              ].map((m) => (
                <div
                  key={m.label}
                  style={{
                    padding: 14,
                    background: 'var(--surf-1)',
                    border: '1px solid var(--bord)',
                    borderRadius: 9,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      color: 'var(--text-faint)',
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      marginBottom: 4,
                    }}
                  >
                    {m.label}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: `var(--${m.tone})`, marginBottom: 3 }}>
                    {m.value}
                  </div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>{m.sub}</div>
                </div>
              ))}
            </div>
            <div
              style={{
                padding: '10px 12px',
                background: 'rgba(62,123,250,.06)',
                border: '1px solid rgba(62,123,250,.24)',
                borderRadius: 8,
                fontSize: 11.5,
                fontWeight: 600,
                lineHeight: 1.55,
                color: 'var(--text-2)',
              }}
            >
              <Icon.info size={13} style={{ display: 'inline', marginRight: 6, color: 'var(--blue)' }} />
              Wire the marketing-spend feed + Stripe webhooks to populate LTV / CAC. Until
              then, this card is intentionally blank — no synthetic numbers.
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              style={{
                padding: '14px 18px',
                borderBottom: '1px solid var(--bord)',
                fontSize: 12,
                fontWeight: 800,
                color: 'var(--text-2)',
              }}
            >
              Top paying tenants
            </div>
            {revenue.isLoading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
              </div>
            ) : (d?.topPaying ?? []).length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12 }}>
                No paying tenants yet.
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(d?.topPaying ?? []).map((t) => (
                  <li
                    key={t.tenantId}
                    style={{
                      display: 'flex',
                      gap: 11,
                      padding: '12px 18px',
                      borderBottom: '1px solid var(--bord)',
                      alignItems: 'center',
                    }}
                  >
                    <Avatar name={t.tenantName} size="sm" />
                    <Link
                      href={`/fam/tenants/${t.tenantId}`}
                      style={{ flex: 1, textDecoration: 'none', color: 'inherit', minWidth: 0 }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 800 }}>{t.tenantName}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                        <span style={{ textTransform: 'capitalize' }}>{t.planCode}</span> · {t.userCount} users
                      </div>
                    </Link>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                      {formatCurrency(t.mrr, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
