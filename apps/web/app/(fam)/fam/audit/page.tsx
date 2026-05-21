'use client'

import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useFamPlatformAudit } from '@/lib/api/queries/use-fam'
import { timeAgo } from '@/lib/utils'

function actionTone(action: string) {
  if (action.includes('impersonate')) return 'var(--coral)'
  if (action.includes('suspend') || action.includes('rejected')) return 'var(--coral)'
  if (action.includes('alert') || action.includes('warn')) return 'var(--yellow)'
  if (action.includes('verified') || action.includes('approved')) return 'var(--green)'
  return 'var(--blue)'
}

export default function FamAuditPage() {
  const [page, setPage] = useState(1)
  const limit = 25
  const audit = useFamPlatformAudit(page, limit)
  const rows = audit.data?.data ?? []
  const total = audit.data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))

  // Today bucket — compute over the current page to avoid an extra query.
  const todayBuckets = useMemo(() => {
    const since = new Date()
    since.setHours(0, 0, 0, 0)
    const byBucket = {
      total: 0,
      impersonations: 0,
      flags: 0,
      lifecycle: 0,
      alerts: 0,
    }
    for (const r of rows) {
      if (new Date(r.createdAt) < since) continue
      byBucket.total++
      if (r.action.includes('impersonate')) byBucket.impersonations++
      else if (r.action.includes('flag') || r.action.includes('cohort')) byBucket.flags++
      else if (
        r.action.includes('suspend') ||
        r.action.includes('trial') ||
        r.action.includes('verified') ||
        r.action.includes('reactivated')
      ) {
        byBucket.lifecycle++
      } else if (r.action.includes('alert') || r.action.includes('warn')) byBucket.alerts++
    }
    return byBucket
  }, [rows])

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Platform audit log"
          sub="audit_log_platform · all FAM actions, immutable, 7-year retention"
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="secondary" size="sm" icon={<Icon.filter size={13} />}>
                Filter
              </Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export CSV
              </Btn>
            </div>
          }
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 14 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {audit.isLoading ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
              </div>
            ) : rows.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12 }}>
                No platform events yet.
              </div>
            ) : (
              <table className="tbl" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: 160 }}>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--text-mute)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {timeAgo(r.createdAt)}
                      </td>
                      <td>
                        <div style={{ fontSize: 12.5, fontWeight: 800 }}>{r.actor}</div>
                        {r.actorEmail && (
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                            {r.actorEmail}
                          </div>
                        )}
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11.5,
                          fontWeight: 800,
                          color: actionTone(r.action),
                        }}
                      >
                        {r.action}
                      </td>
                      <td>
                        {r.targetTenantId ? (
                          <Link
                            href={`/fam/tenants/${r.targetTenantId}`}
                            style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}
                          >
                            {r.targetTenantName ?? r.targetTenantId.slice(0, 8)}
                          </Link>
                        ) : (
                          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--text-2)',
                          wordBreak: 'break-word',
                          maxWidth: 280,
                        }}
                      >
                        {r.metadata ? JSON.stringify(r.metadata) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 18px',
                borderTop: '1px solid var(--bord)',
                background: 'var(--surf-1)',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)' }}>
                Showing {rows.length} of {total} entries
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn
                  kind="ghost"
                  size="sm"
                  icon={<Icon.chevL size={12} />}
                  disabled={page <= 1 || audit.isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                />
                <Btn
                  kind="ghost"
                  size="sm"
                  icon={<Icon.chevR size={12} />}
                  disabled={page >= totalPages || audit.isFetching}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                />
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 12 }}>
                Filters
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <FilterGroup label="Date range">
                  <select className="input">
                    <option>Today</option>
                    <option>Last 7 days</option>
                    <option>Last 30 days</option>
                    <option>Custom…</option>
                  </select>
                </FilterGroup>
                <FilterGroup label="Action category">
                  <select className="input">
                    <option>All</option>
                    <option>Impersonation</option>
                    <option>Tenant lifecycle</option>
                    <option>Feature flags</option>
                    <option>Billing</option>
                    <option>System alerts</option>
                  </select>
                </FilterGroup>
                <FilterGroup label="Actor">
                  <input className="input" placeholder="email or 'system'" />
                </FilterGroup>
                <FilterGroup label="Target tenant">
                  <input className="input" placeholder="tenant slug" />
                </FilterGroup>
                <Btn kind="secondary" size="sm" disabled>
                  Apply filters (preview)
                </Btn>
              </div>
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 12 }}>
                Today's stats
                <span style={{ marginLeft: 6, color: 'var(--text-mute)', fontWeight: 600 }}>
                  · From this page
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <StatRow label="Total events" value={todayBuckets.total} tone="blue" />
                <StatRow label="Impersonations" value={todayBuckets.impersonations} tone="coral" />
                <StatRow label="Flag changes" value={todayBuckets.flags} tone="yellow" />
                <StatRow label="Tenant lifecycle" value={todayBuckets.lifecycle} tone="purple" />
                <StatRow label="System alerts" value={todayBuckets.alerts} tone="yellow" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        className="label"
        style={{
          display: 'block',
          fontSize: 10,
          fontWeight: 800,
          color: 'var(--text-faint)',
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  )
}

function StatRow({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 10px',
        background: 'var(--surf-1)',
        border: '1px solid var(--bord)',
        borderRadius: 8,
      }}
    >
      <span style={{ fontSize: 11.5, fontWeight: 700 }}>{label}</span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontWeight: 800,
          fontSize: 13,
          color: `var(--${tone})`,
        }}
      >
        {value}
      </span>
    </div>
  )
}
