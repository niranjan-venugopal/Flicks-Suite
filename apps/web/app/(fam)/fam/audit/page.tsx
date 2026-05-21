'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useFamPlatformAudit } from '@/lib/api/queries/use-fam'
import { timeAgo } from '@/lib/utils'

export default function FamAuditPage() {
  const [page, setPage] = useState(1)
  const limit = 50
  const audit = useFamPlatformAudit(page, limit)
  const rows = audit.data?.data ?? []
  const total = audit.data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Platform audit log"
          sub={`${total} event${total === 1 ? '' : 's'} across all tenants.`}
          right={<Pill tone="purple" dot>Sprint 3 · C5</Pill>}
        />

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
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target tenant</th>
                  <th>Metadata</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Pill tone="purple" dot>{r.action}</Pill>
                    </td>
                    <td>
                      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{r.actor}</div>
                      {r.actorEmail && (
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>{r.actorEmail}</div>
                      )}
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
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', wordBreak: 'break-word', maxWidth: 360 }}>
                      {r.metadata ? JSON.stringify(r.metadata) : '—'}
                    </td>
                    <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                      {timeAgo(r.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
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
                Page {page} of {totalPages} · {total} events
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn kind="ghost" size="sm" icon={<Icon.chevL size={12} />} disabled={page <= 1 || audit.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  Prev
                </Btn>
                <Btn kind="ghost" size="sm" iconRight={<Icon.chevR size={12} />} disabled={page >= totalPages || audit.isFetching} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
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
