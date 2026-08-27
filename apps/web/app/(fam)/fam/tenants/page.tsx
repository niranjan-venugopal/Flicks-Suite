'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  useFamTenants,
  type FamTenantRow,
} from '@/lib/api/queries/use-fam'
import { formatCurrency, timeAgo } from '@/lib/utils'

const STATUS_OPTIONS = ['all', 'trialing', 'active', 'past_due', 'suspended', 'canceled'] as const
const SIGNAL_OPTIONS = ['all', 'healthy', 'at_risk', 'churning', 'expanding', 'new'] as const

function statusTone(s: FamTenantRow['status']) {
  switch (s) {
    case 'active':    return 'green'
    case 'trialing':  return 'blue'
    case 'past_due':  return 'yellow'
    case 'suspended':
    case 'canceled':  return 'coral'
    default:          return ''
  }
}
function signalTone(s: FamTenantRow['signal']) {
  switch (s) {
    case 'healthy':   return 'green'
    case 'expanding': return 'blue'
    case 'new':       return 'yellow'
    case 'at_risk':   return 'yellow'
    case 'churning':  return 'coral'
    default:          return ''
  }
}

export default function FamTenantsPage() {
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>('all')
  const [signal, setSignal] = useState<(typeof SIGNAL_OPTIONS)[number]>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const limit = 20

  const tenants = useFamTenants({
    status: status === 'all' ? undefined : status,
    signal: signal === 'all' ? undefined : signal,
    search: search.trim() || undefined,
    page,
    limit,
  })

  const rows = tenants.data?.data ?? []
  const total = tenants.data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Tenants"
          sub={`${total} workspace${total === 1 ? '' : 's'} on the platform`}
        />

        {/* Filter bar */}
        <div
          className="card"
          style={{
            padding: 14,
            marginBottom: 14,
            display: 'flex',
            gap: 14,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 220 }}>
            <Icon.search
              size={14}
              style={{
                position: 'absolute',
                left: 11,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-faint)',
                pointerEvents: 'none',
              }}
            />
            <input
              className="input with-icon"
              placeholder="Search by name or slug…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              style={{ height: 34, fontSize: 12.5, paddingLeft: 33 }}
            />
          </div>

          <FilterGroup label="Status">
            {STATUS_OPTIONS.map((s) => (
              <FilterPill
                key={s}
                active={status === s}
                onClick={() => {
                  setStatus(s)
                  setPage(1)
                }}
              >
                {s === 'all' ? 'All' : s.replace('_', ' ')}
              </FilterPill>
            ))}
          </FilterGroup>

          <FilterGroup label="Health">
            {SIGNAL_OPTIONS.map((s) => (
              <FilterPill
                key={s}
                active={signal === s}
                onClick={() => {
                  setSignal(s)
                  setPage(1)
                }}
              >
                {s === 'all' ? 'All' : s.replace('_', ' ')}
              </FilterPill>
            ))}
          </FilterGroup>
        </div>

        {/* Table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {tenants.isLoading ? (
            <div
              style={{
                padding: 48,
                textAlign: 'center',
                color: 'var(--text-mute)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <Loader2 className="w-4 h-4 animate-spin" /> Loading tenants…
            </div>
          ) : rows.length === 0 ? (
            <div
              style={{
                padding: 60,
                textAlign: 'center',
                color: 'var(--text-mute)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              No tenants match those filters.
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Plan</th>
                  <th>MRR</th>
                  <th>Users</th>
                  <th>Health</th>
                  <th>Status</th>
                  <th>Verified</th>
                  <th>Joined</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link
                        href={`/fam/tenants/${t.id}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 11,
                          textDecoration: 'none',
                          color: 'inherit',
                        }}
                      >
                        <Avatar name={t.name} size="sm" src={t.logoUrl ?? undefined} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>{t.name}</div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                            {t.slug}
                          </div>
                        </div>
                      </Link>
                    </td>
                    <td style={{ fontSize: 12, fontWeight: 700 }}>
                      <span style={{ textTransform: 'capitalize' }}>{t.plan ?? '—'}</span>
                      {/* D22 — billing chip: live subscription state at a glance */}
                      {t.subStatus && (
                        <span
                          style={{
                            marginLeft: 6,
                            padding: '2px 7px',
                            borderRadius: 99,
                            fontSize: 9.5,
                            fontWeight: 800,
                            textTransform: 'uppercase',
                            letterSpacing: '.04em',
                            background:
                              t.subStatus === 'active'
                                ? 'rgba(39,210,128,.14)'
                                : t.subStatus === 'trialing'
                                  ? 'rgba(254,216,0,.12)'
                                  : 'rgba(248,120,107,.14)',
                            color:
                              t.subStatus === 'active'
                                ? 'var(--green)'
                                : t.subStatus === 'trialing'
                                  ? 'var(--yellow)'
                                  : 'var(--coral)',
                          }}
                        >
                          {t.subStatus.replace('_', ' ')}
                        </span>
                      )}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                      {t.mrr > 0 ? formatCurrency(t.mrr, 'INR') : '—'}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                      {t.userCount > 0 ? t.userCount : t.memberCount}
                    </td>
                    <td>
                      {t.signal ? (
                        <Pill tone={signalTone(t.signal)} dot>
                          {t.signal.replace('_', ' ')}
                        </Pill>
                      ) : (
                        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td>
                      <Pill tone={statusTone(t.status)} dot>
                        {t.status.replace('_', ' ')}
                      </Pill>
                    </td>
                    <td>
                      {/* Distinct from the billing-status pill on purpose —
                          verification comes ONLY from the FAM verify action. */}
                      {t.verifiedAt ? (
                        <Pill tone="green" dot>Verified</Pill>
                      ) : (
                        <Pill tone="yellow" dot>Unverified</Pill>
                      )}
                    </td>
                    <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                      {timeAgo(t.createdAt)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Link
                        href={`/fam/tenants/${t.id}`}
                        style={{ textDecoration: 'none' }}
                      >
                        <Btn kind="ghost" size="sm" iconRight={<Icon.chevR size={11} />}>
                          Open
                        </Btn>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {rows.length > 0 && totalPages > 1 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                borderTop: '1px solid var(--bord)',
                background: 'var(--surf-0)',
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                Page {page} of {totalPages} · {total} tenants
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn
                  kind="ghost"
                  size="sm"
                  icon={<Icon.chevL size={12} />}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || tenants.isFetching}
                >
                  Prev
                </Btn>
                <Btn
                  kind="ghost"
                  size="sm"
                  iconRight={<Icon.chevR size={12} />}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || tenants.isFetching}
                >
                  Next
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FilterGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 800,
          color: 'var(--text-faint)',
          letterSpacing: '.06em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{children}</div>
    </div>
  )
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? 'var(--blue)' : 'var(--surf-1)',
        color: active ? '#fff' : 'var(--text-2)',
        border: `1px solid ${active ? 'var(--blue)' : 'var(--bord)'}`,
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 11,
        fontWeight: 700,
        cursor: 'pointer',
        textTransform: 'capitalize',
      }}
    >
      {children}
    </button>
  )
}
