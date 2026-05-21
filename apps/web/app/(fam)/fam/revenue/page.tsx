'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Avatar, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import { useFamRevenue } from '@/lib/api/queries/use-fam'
import { formatCurrency } from '@/lib/utils'

const PLAN_COLOURS: Record<string, string> = {
  starter: 'var(--blue)',
  growth: 'var(--green)',
  scale: 'var(--purple)',
  enterprise: 'var(--yellow)',
}
function statusTone(s: string) {
  switch (s) {
    case 'active':   return 'green'
    case 'trialing': return 'blue'
    case 'past_due': return 'yellow'
    case 'canceled': return 'coral'
    default:         return ''
  }
}

export default function FamRevenuePage() {
  const revenue = useFamRevenue()
  const d = revenue.data

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Revenue"
          sub="MRR, plan distribution and the top paying tenants."
          right={<Pill tone="purple" dot>Sprint 3 · C5</Pill>}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
          <Kpi
            label="MRR"
            value={revenue.isLoading ? '…' : formatCurrency(d?.mrr.amount ?? 0, d?.mrr.currency ?? 'INR')}
            delta="Active + trialing"
            icon={<Icon.chart size={14} />}
            accent="green"
          />
          <Kpi
            label="ARR (annualised)"
            value={revenue.isLoading ? '…' : formatCurrency(d?.arr.amount ?? 0, d?.arr.currency ?? 'INR')}
            delta="MRR × 12"
            icon={<Icon.spark size={14} />}
            accent="blue"
          />
          <Kpi
            label="Paying tenants"
            value={revenue.isLoading ? '…' : String(d?.topPaying.length ?? 0)}
            delta="With active subscriptions"
            icon={<Icon.people size={14} />}
            accent="purple"
          />
          <Kpi
            label="ARPU (avg per tenant)"
            value={
              revenue.isLoading
                ? '…'
                : d && d.topPaying.length > 0
                  ? formatCurrency(Math.round(d.mrr.amount / d.topPaying.length), d.mrr.currency)
                  : '—'
            }
            delta="MRR ÷ paying"
            icon={<Icon.tag size={14} />}
            accent="yellow"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
              MRR by plan
            </div>
            {revenue.isLoading ? <CenteredSpinner /> : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(d?.byPlan ?? []).map((p) => (
                  <li key={p.plan} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--bord)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: PLAN_COLOURS[p.plan] ?? 'var(--coral)' }} />
                    <span style={{ flex: 1, fontWeight: 700, color: 'var(--text-2)', textTransform: 'capitalize' }}>{p.plan}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>{p.tenants} tenants</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, minWidth: 100, textAlign: 'right' }}>
                      {formatCurrency(p.mrr, d?.mrr.currency ?? 'INR')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
              By subscription status
            </div>
            {revenue.isLoading ? <CenteredSpinner /> : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(d?.byStatus ?? []).map((s) => (
                  <li key={s.status} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--bord)' }}>
                    <Pill tone={statusTone(s.status)} dot>{s.status.replace('_', ' ')}</Pill>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{s.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', fontSize: 12, fontWeight: 800, color: 'var(--text-2)' }}>
            Top paying tenants
          </div>
          {revenue.isLoading ? <CenteredSpinner /> : (d?.topPaying ?? []).length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12 }}>No paying tenants yet.</div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Plan</th>
                  <th>Users</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>MRR</th>
                </tr>
              </thead>
              <tbody>
                {(d?.topPaying ?? []).map((t) => (
                  <tr key={t.tenantId}>
                    <td>
                      <Link href={`/fam/tenants/${t.tenantId}`} style={{ display: 'flex', gap: 11, textDecoration: 'none', color: 'inherit', alignItems: 'center' }}>
                        <Avatar name={t.tenantName} size="sm" />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>{t.tenantName}</div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>{t.slug}</div>
                        </div>
                      </Link>
                    </td>
                    <td style={{ fontSize: 12, fontWeight: 700, textTransform: 'capitalize' }}>{t.planCode}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{t.userCount}</td>
                    <td><Pill tone={statusTone(t.status)} dot>{t.status.replace('_', ' ')}</Pill></td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                      {formatCurrency(t.mrr, d?.mrr.currency ?? 'INR')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function CenteredSpinner() {
  return (
    <div style={{ padding: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
      <Loader2 className="w-4 h-4 animate-spin" />
    </div>
  )
}
