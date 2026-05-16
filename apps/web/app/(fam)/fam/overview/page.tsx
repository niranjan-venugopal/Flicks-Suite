'use client'

import Link from 'next/link'
import { Btn, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'

/**
 * FAM Console landing. C1 ships this as a static shell — real platform
 * stats (tenants count, MRR, signups this week, health) wire up in C2.
 */
export default function FamOverviewPage() {
  const { currentUser } = useAuthStore()
  const firstName = (currentUser?.name ?? 'Operator').split(' ')[0]

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title={`FAM Console — Hi, ${firstName}.`}
          sub="Specflicks-internal platform admin. C2 wires the real numbers."
          right={
            <Pill tone="purple" dot>
              Sprint 3 · C1
            </Pill>
          }
        />

        {/* Placeholder KPIs — values are dashes until C2 swaps in real
            aggregations from /api/v1/fam/* */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 14,
            marginBottom: 18,
          }}
        >
          <Kpi label="Active tenants" value="—" delta="Wires in C2" icon={<Icon.people size={14} />} accent="blue" />
          <Kpi label="MRR" value="—" delta="Wires in C5" icon={<Icon.chart size={14} />} accent="green" />
          <Kpi label="Signups this week" value="—" delta="Wires in C2" icon={<Icon.spark size={14} />} accent="yellow" />
          <Kpi label="Health" value="—" delta="Wires in C5" icon={<Icon.shield size={14} />} accent="purple" />
        </div>

        {/* Roadmap card */}
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 12 }}>
            Sprint 3 roadmap
          </div>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 10,
            }}
          >
            {[
              { id: 'C1', label: 'Shell + role + (fam) route group', status: 'done', href: undefined },
              { id: 'C2', label: 'Overview — platform-wide stats wired', status: 'next', href: undefined },
              { id: 'C3', label: 'Tenants list + detail (Overview / Members)', status: 'next', href: '/fam/tenants' },
              { id: 'C4', label: 'Tenant detail (Usage / Billing / Audit / Settings)', status: 'next', href: '/fam/tenants' },
              { id: 'C5', label: 'Revenue / Funnel / Feature usage / Flags / Audit / Verification', status: 'next', href: '/fam/revenue' },
              { id: 'C6', label: 'Impersonation flow + dual-audit banner', status: 'next', href: undefined },
            ].map((r) => {
              const isDone = r.status === 'done'
              return (
                <li
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    background: 'var(--surf-1)',
                    border: '1px solid var(--bord)',
                    borderRadius: 9,
                  }}
                >
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: isDone
                        ? 'rgba(39,210,128,.14)'
                        : 'var(--surf-2)',
                      color: isDone ? 'var(--green)' : 'var(--text-mute)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 800,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {r.id}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: 'var(--text-2)',
                    }}
                  >
                    {r.label}
                  </span>
                  {isDone ? (
                    <Pill tone="green" dot>
                      Done
                    </Pill>
                  ) : (
                    <Pill tone="yellow" dot>
                      Pending
                    </Pill>
                  )}
                </li>
              )
            })}
          </ul>
        </div>

        <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
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
