'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Avatar, Btn, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import { useFamFeatureUsage } from '@/lib/api/queries/use-fam'

const MODULES = [
  { id: 'attendance', label: 'Clock-in / attendance' },
  { id: 'leave',      label: 'Leave management' },
  { id: 'timesheet',  label: 'Timesheets' },
] as const

function adoptionColour(pct: number): string {
  if (pct >= 80) return 'var(--green)'
  if (pct >= 40) return 'var(--blue)'
  if (pct >= 20) return 'var(--yellow)'
  return 'var(--coral)'
}

export default function FamFeatureUsagePage() {
  const usage = useFamFeatureUsage()
  const d = usage.data
  const tenants = d?.tenants ?? []

  // Aggregate adoption across all tenants for the "ranking" card.
  type ModuleKey = (typeof MODULES)[number]['id']
  const totalEmployees = tenants.reduce((s, t) => s + t.employeeCount, 0)
  const moduleStats = MODULES.map((m) => {
    const users = tenants.reduce((s, t) => s + t[m.id].users, 0)
    return {
      ...m,
      users,
      adoption: totalEmployees > 0 ? users / totalEmployees : 0,
    }
  }).sort((a, b) => b.adoption - a.adoption)

  // Power vs at-risk segmentation.
  const powerUsers = tenants.filter(
    (t) => MODULES.every((m) => t[m.id].adoption >= 0.5),
  ).length
  const atRisk = tenants.filter(
    (t) => MODULES.filter((m) => t[m.id].adoption < 0.2).length >= 2,
  ).length

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Feature usage"
          sub={`Adoption % across ${tenants.length} active tenant${tenants.length === 1 ? '' : 's'} · last ${d?.windowDays ?? 30} days`}
          right={
            <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
              Export CSV
            </Btn>
          }
        />

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
          <Kpi label="Tenants tracked" value={String(tenants.length)} icon={<Icon.building size={14} />} accent="blue" />
          <Kpi
            label="Avg modules used"
            value={
              tenants.length > 0
                ? (
                    tenants.reduce(
                      (s, t) => s + MODULES.filter((m) => t[m.id].adoption > 0).length,
                      0,
                    ) / tenants.length
                  ).toFixed(1)
                : '0'
            }
            delta={`of ${MODULES.length} core modules`}
            icon={<Icon.zap size={14} />}
            accent="green"
          />
          <Kpi
            label="Power users"
            value={String(powerUsers)}
            delta="≥ 50% adoption on every module"
            icon={<Icon.spark size={14} />}
            accent="purple"
          />
          <Kpi
            label="At-risk"
            value={String(atRisk)}
            delta="≥ 2 modules under 20%"
            icon={<Icon.shield size={14} />}
            accent="yellow"
          />
        </div>

        {usage.isLoading ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 14 }}>
            {/* Adoption ranking */}
            <div className="card" style={{ padding: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
                Adoption ranking
                <span style={{ marginLeft: 6, color: 'var(--text-mute)', fontWeight: 600 }}>
                  · Across all tenants
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {moduleStats.map((m) => {
                  const pct = Math.round(m.adoption * 100)
                  return (
                    <div key={m.id}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, gap: 10 }}>
                        <span style={{ fontSize: 12, fontWeight: 800 }}>{m.label}</span>
                        <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                          {pct}% <span style={{ color: 'var(--text-mute)' }}>· {m.users} of {totalEmployees}</span>
                        </span>
                      </div>
                      <div style={{ height: 6, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
                        <div
                          style={{
                            width: `${pct}%`,
                            height: '100%',
                            background: adoptionColour(pct),
                            borderRadius: 99,
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>

              <div
                style={{
                  marginTop: 16,
                  padding: '10px 12px',
                  background: 'rgba(155,123,250,.08)',
                  border: '1px solid rgba(155,123,250,.28)',
                  borderRadius: 8,
                  fontSize: 11.5,
                  color: 'var(--text-2)',
                }}
              >
                <Icon.info size={12} style={{ display: 'inline-block', marginRight: 6, verticalAlign: '-1px' }} />
                Adoption % = distinct employees who used the module in the last 30 days, summed across
                tenants, divided by total active employees.
              </div>
            </div>

            {/* Per-tenant heatmap */}
            <div className="card" style={{ padding: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
                Tenant × module heatmap
                <span style={{ marginLeft: 6, color: 'var(--text-mute)', fontWeight: 600 }}>
                  · Adoption %
                </span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th
                      style={{
                        padding: '6px 8px',
                        textAlign: 'left',
                        fontSize: 10,
                        fontWeight: 800,
                        color: 'var(--text-mute)',
                      }}
                    >
                      Tenant
                    </th>
                    {MODULES.map((m) => (
                      <th
                        key={m.id}
                        style={{
                          padding: '6px 6px',
                          textAlign: 'center',
                          fontSize: 10,
                          fontWeight: 800,
                          color: 'var(--text-mute)',
                          textTransform: 'capitalize',
                        }}
                      >
                        {m.id}
                      </th>
                    ))}
                    <th
                      style={{
                        padding: '6px 8px',
                        textAlign: 'right',
                        fontSize: 10,
                        fontWeight: 800,
                        color: 'var(--text-mute)',
                      }}
                    >
                      Employees
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t) => (
                    <tr key={t.tenantId}>
                      <td style={{ padding: '5px 8px', fontWeight: 800, fontSize: 11, fontFamily: 'var(--font)' }}>
                        <Link href={`/fam/tenants/${t.tenantId}`} style={{ display: 'inline-flex', gap: 8, alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>
                          <Avatar name={t.tenantName} size="sm" />
                          <span>{t.tenantName}</span>
                        </Link>
                      </td>
                      {MODULES.map((m) => {
                        const v = Math.round(t[m.id].adoption * 100)
                        return (
                          <td key={m.id} style={{ padding: 2 }}>
                            <div
                              style={{
                                padding: '6px 4px',
                                borderRadius: 4,
                                textAlign: 'center',
                                fontWeight: 800,
                                background: `rgba(62,123,250,${(v / 100) * 0.7 + 0.05})`,
                                color: v > 60 ? '#fff' : 'rgba(255,255,255,.85)',
                              }}
                            >
                              {v}
                            </div>
                          </td>
                        )
                      })}
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--text-mute)' }}>
                        {t.employeeCount}
                      </td>
                    </tr>
                  ))}
                  {tenants.length === 0 && (
                    <tr>
                      <td colSpan={MODULES.length + 2} style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)' }}>
                        No tenants tracked yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
