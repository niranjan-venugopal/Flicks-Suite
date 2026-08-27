'use client'

import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import {
  Avatar,
  Btn,
  Icon,
  Kpi,
  Pill,
  SectionHead,
} from '@/components/proto'
import {
  useFamOverview,
  useFamRevenue,
  useFamFunnel,
  useFamVerificationQueue,
} from '@/lib/api/queries/use-fam'
import { formatCurrency } from '@/lib/utils'

const PLAN_COLOURS: Record<string, string> = {
  free: 'var(--text-mute)',
  starter: 'var(--blue)',
  growth: 'var(--purple)',
  scale: 'var(--green)',
  enterprise: 'var(--yellow)',
}

const FUNNEL_COLOURS = ['#3E7BFA', '#9B7BFA', '#27D280', '#FED800', '#F8786B']

export default function FamOverviewPage() {
  const overview = useFamOverview()
  const revenue = useFamRevenue()
  const funnel = useFamFunnel()
  const verify = useFamVerificationQueue()

  const d = overview.data
  const rev = revenue.data

  // Top tenants come from the revenue payload's topPaying list — no need for a
  // second full /fam/tenants fetch just to derive them on the overview.
  const topTenants = [...(rev?.topPaying ?? [])]
    .sort((a, b) => (b.mrr ?? 0) - (a.mrr ?? 0))
    .slice(0, 4)
  const signups7d = d?.signupsTrend7d?.reduce((s, p) => s + p.count, 0) ?? 0

  const healthTotal = d
    ? d.health.healthy + d.health.at_risk + d.health.churning + d.health.expanding + d.health.new
    : 0
  const healthyPct = healthTotal > 0 ? Math.round((d!.health.healthy / healthTotal) * 100) : 0

  const vqRows = verify.data?.data ?? []

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24, gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div className="t-caption" style={{ marginBottom: 6 }}>
              FAM Console · Specflicks Internal · Restricted
            </div>
            <div className="t-display" style={{ fontSize: 32 }}>Platform overview</div>
            <div className="t-mute" style={{ fontSize: 13.5, marginTop: 6 }}>
              Live · {d?.activeTenants ?? 0} active tenants · refreshes every minute
            </div>
          </div>
          <Link href="/fam/health" style={{ textDecoration: 'none' }}>
            <Btn kind="primary" size="sm" icon={<Icon.zap size={13} />}>System health</Btn>
          </Link>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
          <Kpi
            label="Active tenants"
            value={overview.isLoading ? '…' : String(d?.activeTenants ?? 0)}
            delta={d ? `${d.tenantsByStatus.trialing ?? 0} trialing` : '—'}
            icon={<Icon.building size={14} />}
            accent="blue"
          />
          <Kpi
            label="MRR"
            value={overview.isLoading ? '…' : formatCurrency(d?.mrr.amount ?? 0, d?.mrr.currency ?? 'INR')}
            delta={rev ? `${formatCurrency(rev.arr.amount, rev.arr.currency)} ARR` : 'Active + trialing'}
            trend={d && d.mrr.amount > 0 ? 'up' : undefined}
            icon={<Icon.trend size={14} />}
            accent="green"
          />
          <Kpi
            label="Signups · 7d"
            value={overview.isLoading ? '…' : String(d?.signupsThisWeek ?? signups7d)}
            delta={`${d?.totalTenants ?? 0} workspaces total`}
            icon={<Icon.people size={14} />}
            accent="purple"
          />
          <Kpi
            label="Tenant health"
            value={overview.isLoading ? '…' : `${healthyPct}%`}
            delta={d ? `${d.health.at_risk} at risk · ${d.health.churning} churning` : '—'}
            icon={<Icon.shield size={14} />}
            accent="yellow"
          />
        </div>

        {overview.isError && (
          <div className="card" style={{ padding: 16, marginBottom: 18, borderColor: 'rgba(248,120,107,.4)', background: 'rgba(248,120,107,.06)', fontSize: 12.5, fontWeight: 700, color: 'var(--coral)' }}>
            Could not load the platform overview. Check the API logs.
          </div>
        )}

        {/* Row 2: revenue by plan + activation funnel */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18, marginBottom: 18 }}>
          <div className="card">
            <SectionHead
              title="Revenue by plan"
              sub={rev ? `${formatCurrency(rev.mrr.amount, rev.mrr.currency)} / mo across ${rev.byPlan.reduce((s, p) => s + p.tenants, 0)} tenants` : 'Loading…'}
              right={rev ? <Pill tone="green" dot>{formatCurrency(rev.arr.amount, rev.arr.currency)} ARR</Pill> : undefined}
            />
            {revenue.isLoading || !rev ? (
              <div style={{ padding: 30, display: 'flex', justifyContent: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 4 }}>
                {rev.byPlan.map((p) => (
                  <div key={p.plan} style={{ padding: '12px 12px', background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9 }}>
                    <div className="t-caption" style={{ marginBottom: 4 }}>{p.plan}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: PLAN_COLOURS[p.plan] ?? 'var(--text)' }}>
                      {p.tenants} · {formatCurrency(p.mrr, rev.mrr.currency)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <SectionHead title="Activation funnel" sub="Signup → first activity" />
            {funnel.isLoading || !funnel.data ? (
              <div style={{ padding: 30, display: 'flex', justifyContent: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : (
              funnel.data.stages.map((s, i) => (
                <div key={s.id} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 12, fontWeight: 700 }}>
                    <span>{s.label}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      <strong>{s.count}</strong>{' '}
                      <span style={{ color: 'var(--text-mute)' }}>· {Math.round(s.rate * 100)}%</span>
                    </span>
                  </div>
                  <div style={{ height: 8, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round(s.rate * 100)}%`, height: '100%', background: FUNNEL_COLOURS[i % FUNNEL_COLOURS.length], borderRadius: 99 }} />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Row 3: top tenants + verification queue + tenant health */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          <div className="card">
            <SectionHead title="Top tenants" sub="By MRR" />
            {topTenants.length === 0 ? (
              <div className="t-mute" style={{ fontSize: 12, padding: '12px 0' }}>No paying tenants yet.</div>
            ) : (
              topTenants.map((t, i) => (
                <Link
                  key={t.tenantId}
                  href={`/fam/tenants/${t.tenantId}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0',
                    borderBottom: i < topTenants.length - 1 ? '1px solid var(--bord)' : 'none',
                    textDecoration: 'none', color: 'inherit',
                  }}
                >
                  <Avatar name={t.tenantName} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.tenantName}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                      {t.userCount} seats · {t.planCode ?? 'free'}
                    </div>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                    {formatCurrency(t.mrr ?? 0, rev?.mrr.currency ?? 'INR')}
                  </div>
                </Link>
              ))
            )}
          </div>

          <div className="card">
            <SectionHead
              title="Verification queue"
              sub={`${vqRows.length} need${vqRows.length === 1 ? 's' : ''} review`}
              right={vqRows.length > 0 ? <Pill tone="yellow">{vqRows.length}</Pill> : undefined}
            />
            {vqRows.length === 0 ? (
              <div className="t-mute" style={{ fontSize: 12, padding: '12px 0' }}>Nothing pending verification.</div>
            ) : (
              vqRows.slice(0, 4).map((v) => {
                const reason = !v.gstin ? 'GSTIN missing' : !v.pan ? 'PAN unverified' : 'Awaiting review'
                const sev = !v.gstin ? 'var(--coral)' : !v.pan ? 'var(--yellow)' : 'var(--text-mute)'
                return (
                  <div key={v.id} style={{ padding: '10px 12px', background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 6, height: 32, borderRadius: 3, background: sev }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>{reason}</div>
                    </div>
                    <Link href={`/fam/verify?tenant=${v.id}`}><Btn kind="ghost" size="sm">Review</Btn></Link>
                  </div>
                )
              })
            )}
          </div>

          <div className="card">
            <SectionHead title="Tenant health" sub="Signal distribution" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { key: 'healthy', label: 'Healthy', tone: 'green' as const },
                { key: 'expanding', label: 'Expanding', tone: 'blue' as const },
                { key: 'at_risk', label: 'At risk', tone: 'yellow' as const },
                { key: 'churning', label: 'Churning', tone: 'coral' as const },
                { key: 'new', label: 'New', tone: '' as const },
              ].map((r) => (
                <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--surf-1)', borderRadius: 9, border: '1px solid var(--bord)' }}>
                  <Pill tone={r.tone} dot>{r.label}</Pill>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                    {d?.health?.[r.key as keyof typeof d.health] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
