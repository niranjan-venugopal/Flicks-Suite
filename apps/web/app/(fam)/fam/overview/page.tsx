'use client'

import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import {
  Avatar,
  Btn,
  Donut,
  Icon,
  Kpi,
  Pill,
  SectionHead,
  Sparkline,
} from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useFamOverview } from '@/lib/api/queries/use-fam'
import { formatCurrency, timeAgo } from '@/lib/utils'

// Status pill tones aligned with the rest of the app.
function statusTone(s: string) {
  switch (s) {
    case 'active':
      return 'green'
    case 'trialing':
      return 'blue'
    case 'past_due':
      return 'yellow'
    case 'suspended':
    case 'canceled':
      return 'coral'
    default:
      return ''
  }
}

const PLAN_COLOURS: Record<string, string> = {
  starter: 'var(--blue)',
  growth: 'var(--green)',
  scale: 'var(--purple)',
  enterprise: 'var(--yellow)',
}

export default function FamOverviewPage() {
  const { currentUser } = useAuthStore()
  const firstName = (currentUser?.name ?? 'Operator').split(' ')[0]
  const overview = useFamOverview()
  const d = overview.data

  const sparkSeries = d?.signupsTrend7d.map((p) => p.count) ?? []
  const sparkTotal = sparkSeries.reduce((a, b) => a + b, 0)

  const planSegments =
    d?.tenantsByPlan
      ? Object.entries(d.tenantsByPlan).map(([plan, n]) => ({
          plan,
          value: Number(n),
          color: PLAN_COLOURS[plan] ?? 'var(--coral)',
        }))
      : []
  const planTotal = planSegments.reduce((s, p) => s + p.value, 0)

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title={`FAM Console — Hi, ${firstName}.`}
          sub="Platform-wide stats refresh every minute."
          right={
            <Pill tone="purple" dot>
              Sprint 3 · C2
            </Pill>
          }
        />

        {/* KPI strip */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 14,
            marginBottom: 18,
          }}
        >
          <Kpi
            label="Active tenants"
            value={overview.isLoading ? '…' : String(d?.activeTenants ?? 0)}
            delta={
              d
                ? `${d.tenantsByStatus.trialing ?? 0} trialing · ${d.tenantsByStatus.active ?? 0} active`
                : '—'
            }
            icon={<Icon.people size={14} />}
            accent="blue"
          />
          <Kpi
            label="MRR"
            value={
              overview.isLoading
                ? '…'
                : formatCurrency(d?.mrr.amount ?? 0, d?.mrr.currency ?? 'INR')
            }
            delta="Active + trialing subs"
            trend={d && d.mrr.amount > 0 ? 'up' : undefined}
            icon={<Icon.chart size={14} />}
            accent="green"
          />
          <Kpi
            label="Signups · 7d"
            value={overview.isLoading ? '…' : String(d?.signupsThisWeek ?? 0)}
            delta={`${sparkTotal} this week`}
            icon={<Icon.spark size={14} />}
            accent="yellow"
          />
          <Kpi
            label="Health · healthy"
            value={overview.isLoading ? '…' : String(d?.health.healthy ?? 0)}
            delta={
              d
                ? `${d.health.at_risk} at risk · ${d.health.churning} churning`
                : '—'
            }
            icon={<Icon.shield size={14} />}
            accent="purple"
          />
        </div>

        {overview.isError && (
          <div
            className="card"
            style={{
              padding: 16,
              marginBottom: 18,
              borderColor: 'rgba(248,120,107,.4)',
              background: 'rgba(248,120,107,.06)',
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--coral)',
            }}
          >
            Could not load the platform overview. Check the API logs.
          </div>
        )}

        {/* Two-column: signups trend + plan donut */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1fr',
            gap: 14,
            marginBottom: 18,
          }}
        >
          <div className="card" style={{ padding: 18 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)' }}>
                  Signups · last 7 days
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 800,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {overview.isLoading ? '…' : sparkTotal}
                </div>
              </div>
              <Pill tone="blue" dot>
                Daily
              </Pill>
            </div>
            {overview.isLoading ? (
              <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
                <Sparkline
                  data={sparkSeries.length > 0 ? sparkSeries : [0, 0, 0, 0, 0, 0, 0]}
                  color="#3E7BFA"
                  w={360}
                  h={70}
                />
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--text-mute)',
                    lineHeight: 1.5,
                  }}
                >
                  {(d?.signupsTrend7d ?? []).map((p) => (
                    <li key={p.date}>
                      <span style={{ color: 'var(--text-2)' }}>{p.date.slice(5)}</span>{' '}
                      · {p.count}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 12 }}>
              Tenants by plan
            </div>
            {overview.isLoading ? (
              <div style={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : planTotal === 0 ? (
              <div
                style={{
                  height: 140,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-mute)',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                No subscriptions yet
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <Donut
                  segments={planSegments.map(({ value, color }) => ({ value, color }))}
                  size={120}
                  thickness={14}
                  label={
                    <span style={{ fontSize: 20, fontWeight: 800 }}>{planTotal}</span>
                  }
                  sub={
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)' }}>
                      paying
                    </span>
                  }
                />
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, flex: 1, fontSize: 12 }}>
                  {planSegments.map((p) => (
                    <li
                      key={p.plan}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 0',
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: p.color,
                        }}
                      />
                      <span style={{ flex: 1, fontWeight: 700, color: 'var(--text-2)', textTransform: 'capitalize' }}>
                        {p.plan}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                        {p.value}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* Recent signups + roadmap */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1fr',
            gap: 14,
            marginBottom: 18,
          }}
        >
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 18px',
                borderBottom: '1px solid var(--bord)',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)' }}>
                Recent signups
              </div>
              <Link href="/fam/tenants" style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}>
                See all →
              </Link>
            </div>
            {overview.isLoading ? (
              <div style={{ padding: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : (d?.recentSignups ?? []).length === 0 ? (
              <div
                style={{
                  padding: 40,
                  textAlign: 'center',
                  color: 'var(--text-mute)',
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                No tenants yet.
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(d?.recentSignups ?? []).map((t) => (
                  <li
                    key={t.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 18px',
                      borderBottom: '1px solid var(--bord)',
                    }}
                  >
                    <Avatar name={t.name} size="sm" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800 }}>{t.name}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                        {t.slug} · joined {timeAgo(t.createdAt)}
                      </div>
                    </div>
                    <Pill tone={statusTone(t.status)} dot>
                      {t.status.replace('_', ' ')}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 12 }}>
              Sprint 3 roadmap
            </div>
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 8,
              }}
            >
              {[
                { id: 'C1', label: 'Shell + role + (fam) route group', status: 'done' },
                { id: 'C2', label: 'Overview — platform-wide stats wired', status: 'done' },
                { id: 'C3', label: 'Tenants list + detail (Overview / Members)', status: 'done' },
                { id: 'C4', label: 'Tenant detail (Usage / Billing / Audit / Settings)', status: 'done' },
                { id: 'C5', label: 'Revenue / Funnel / Feature usage / Flags / Audit / Verify', status: 'done' },
                { id: 'C6', label: 'Impersonation flow + dual-audit banner', status: 'next' },
              ].map((r) => {
                const tone =
                  r.status === 'done' ? 'green' : r.status === 'next' ? 'blue' : 'yellow'
                const label =
                  r.status === 'done' ? 'Done' : r.status === 'next' ? 'Next' : 'Pending'
                return (
                  <li
                    key={r.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 10px',
                      background: 'var(--surf-1)',
                      border: '1px solid var(--bord)',
                      borderRadius: 8,
                    }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 7,
                        background: 'var(--surf-2)',
                        color: 'var(--text-mute)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10.5,
                        fontWeight: 800,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {r.id}
                    </span>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>
                      {r.label}
                    </span>
                    <Pill tone={tone} dot>
                      {label}
                    </Pill>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <Link href="/fam/tenants" style={{ textDecoration: 'none' }}>
            <Btn kind="primary" size="sm" icon={<Icon.people size={13} />}>
              Browse tenants
            </Btn>
          </Link>
          <Link href="/fam/audit" style={{ textDecoration: 'none' }}>
            <Btn kind="secondary" size="sm" icon={<Icon.info size={13} />}>
              Platform audit log
            </Btn>
          </Link>
        </div>
      </div>
    </div>
  )
}
