'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Avatar, Btn, Donut, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import { useFamSystemHealth } from '@/lib/api/queries/use-fam'

const SIGNAL_COLOURS: Record<string, string> = {
  healthy: 'var(--green)',
  expanding: 'var(--blue)',
  new: 'var(--yellow)',
  at_risk: '#F59E0B',
  churning: 'var(--coral)',
}
function signalTone(s: string | null | undefined) {
  switch (s) {
    case 'healthy':   return 'green'
    case 'expanding': return 'blue'
    case 'new':
    case 'at_risk':   return 'yellow'
    case 'churning':  return 'coral'
    default:          return ''
  }
}

export default function FamSystemHealthPage() {
  const health = useFamSystemHealth()
  const d = health.data

  const buckets = d?.buckets ?? { healthy: 0, expanding: 0, new: 0, at_risk: 0, churning: 0 }
  const total = Object.values(buckets).reduce((a, b) => a + Number(b), 0)
  const segments = (['healthy', 'expanding', 'new', 'at_risk', 'churning'] as const).map((k) => ({
    value: Number(buckets[k] ?? 0),
    color: SIGNAL_COLOURS[k],
    label: k.replace('_', ' '),
  }))

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="System health"
          sub="Per-tenant health snapshots + platform infrastructure status"
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Pill tone={buckets.churning > 0 ? 'coral' : 'green'} dot>
                {buckets.churning > 0 ? `${buckets.churning} churning` : 'All tenants healthy'}
              </Pill>
              <Btn kind="secondary" size="sm" icon={<Icon.zap size={13} />}>
                Run synthetic check
              </Btn>
            </div>
          }
        />

        {/* KPIs from real snapshots */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
          <Kpi
            label="Healthy"
            value={String(buckets.healthy)}
            icon={<Icon.success size={14} />}
            accent="green"
          />
          <Kpi
            label="Expanding"
            value={String(buckets.expanding)}
            icon={<Icon.spark size={14} />}
            accent="blue"
          />
          <Kpi
            label="At risk"
            value={String(buckets.at_risk)}
            delta="Needs attention"
            icon={<Icon.warn size={14} />}
            accent="yellow"
          />
          <Kpi
            label="Churning"
            value={String(buckets.churning)}
            delta="Save plays"
            icon={<Icon.shield size={14} />}
            accent="purple"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 14, marginBottom: 14 }}>
          {/* Signal distribution */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
              Tenant health distribution
            </div>
            {health.isLoading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
              </div>
            ) : total === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12 }}>
                No health snapshots yet.
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <Donut
                  segments={segments.filter((s) => s.value > 0).map(({ value, color }) => ({ value, color }))}
                  size={140}
                  thickness={16}
                  label={<span style={{ fontSize: 22, fontWeight: 800 }}>{total}</span>}
                  sub={<span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)' }}>tenants</span>}
                />
                <ul style={{ flex: 1, listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
                  {segments.map((s) => (
                    <li key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                      <span style={{ flex: 1, textTransform: 'capitalize', fontWeight: 700, color: 'var(--text-2)' }}>
                        {s.label}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{s.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* At-risk / churning tenants */}
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
              At-risk + churning tenants
              <span style={{ marginLeft: 8, color: 'var(--text-mute)', fontWeight: 600 }}>
                · Lowest health score first
              </span>
            </div>
            {health.isLoading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
              </div>
            ) : (d?.atRiskTenants ?? []).length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12 }}>
                No tenants flagged. Nice.
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(d?.atRiskTenants ?? []).map((t) => (
                  <li
                    key={t.tenantId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '14px 18px',
                      borderBottom: '1px solid var(--bord)',
                    }}
                  >
                    <Avatar name={t.tenantName} size="sm" />
                    <Link
                      href={`/fam/tenants/${t.tenantId}`}
                      style={{ flex: 1, textDecoration: 'none', color: 'inherit', minWidth: 0 }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 800 }}>{t.tenantName}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                        Score {t.healthScore != null ? Math.round(t.healthScore) : '—'} ·{' '}
                        {t.supportTicketsOpen} open tickets
                      </div>
                    </Link>
                    <Pill tone={signalTone(t.signal)} dot>{t.signal.replace('_', ' ')}</Pill>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Platform infrastructure */}
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
            Platform infrastructure
            <span style={{ marginLeft: 8, color: 'var(--text-mute)', fontWeight: 600 }}>
              · Wires when Sentry + uptime-monitor are connected
            </span>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {[
              { name: 'API gateway',           note: 'NestJS · /api/v1/*' },
              { name: 'Database (Supabase)',   note: 'Postgres 17 · ap-south-1' },
              { name: 'File storage (R2)',     note: 'Cloudflare R2' },
              { name: 'Email delivery (Resend)', note: 'Outbound OTPs + magic links' },
              { name: 'Background jobs',       note: 'BullMQ' },
              { name: 'WebSocket gateway',     note: '/notifications' },
            ].map((s) => (
              <li
                key={s.name}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: '12px 18px',
                  borderBottom: '1px solid var(--bord)',
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--text-faint)',
                    boxShadow: '0 0 0 3px rgba(255,255,255,.04)',
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>{s.name}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 1 }}>
                    {s.note}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 800,
                    fontSize: 11,
                    color: 'var(--text-mute)',
                  }}
                >
                  —
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
