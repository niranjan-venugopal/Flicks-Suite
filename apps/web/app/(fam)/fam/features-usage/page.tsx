'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Avatar, Icon, Pill, SectionHead } from '@/components/proto'
import { useFamFeatureUsage } from '@/lib/api/queries/use-fam'

function AdoptionBar({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const colour =
    pct >= 70 ? 'var(--green)' : pct >= 30 ? 'var(--blue)' : 'var(--coral)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          flex: 1,
          height: 8,
          background: 'var(--surf-2)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: colour }} />
      </div>
      <span style={{ width: 36, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>
        {pct}%
      </span>
    </div>
  )
}

export default function FamFeatureUsagePage() {
  const usage = useFamFeatureUsage()
  const d = usage.data

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Feature usage"
          sub={`Per-tenant module adoption over the last ${d?.windowDays ?? 30} days.`}
          right={<Pill tone="purple" dot>Sprint 3 · C5</Pill>}
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {usage.isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
              <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
            </div>
          ) : (d?.tenants ?? []).length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12 }}>
              No tenants yet.
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Employees</th>
                  <th style={{ width: 200 }}>Attendance</th>
                  <th style={{ width: 200 }}>Leave</th>
                  <th style={{ width: 200 }}>Timesheet</th>
                </tr>
              </thead>
              <tbody>
                {(d?.tenants ?? []).map((t) => (
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
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{t.employeeCount}</td>
                    <td>
                      <AdoptionBar value={t.attendance.adoption} />
                      <div style={{ fontSize: 10.5, color: 'var(--text-mute)', marginTop: 4 }}>
                        {t.attendance.users} / {t.employeeCount} active
                      </div>
                    </td>
                    <td>
                      <AdoptionBar value={t.leave.adoption} />
                      <div style={{ fontSize: 10.5, color: 'var(--text-mute)', marginTop: 4 }}>
                        {t.leave.users} requests
                      </div>
                    </td>
                    <td>
                      <AdoptionBar value={t.timesheet.adoption} />
                      <div style={{ fontSize: 10.5, color: 'var(--text-mute)', marginTop: 4 }}>
                        {t.timesheet.users} submitted
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, fontSize: 11.5, color: 'var(--text-mute)' }}>
          <Icon.info size={12} style={{ display: 'inline-block', marginRight: 6, verticalAlign: '-1px' }} />
          Adoption % = distinct employees who used the module in the last 30d ÷ active employees.
        </div>
      </div>
    </div>
  )
}
