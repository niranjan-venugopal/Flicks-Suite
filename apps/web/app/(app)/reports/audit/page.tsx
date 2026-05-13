'use client'

import Link from 'next/link'
import { Fragment, useMemo, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead, type PillTone } from '@/components/proto'
import { useAuditLog, type AuditLogEntry } from '@/lib/api/queries/use-reports'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RESOURCE_TYPES = [
  '',
  'tenant',
  'department',
  'location',
  'designation',
  'shift_template',
  'leave_type',
  'membership',
  'employee',
  'leave_request',
  'attendance_regularization',
] as const

function fmtTimestamp(t: string): string {
  const d = new Date(t)
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

// Action → coloured pill tone. Falls back to neutral.
function actionTone(action: string): PillTone {
  if (action.endsWith('.created') || action.endsWith('.invited') || action.endsWith('.reactivated'))
    return 'green'
  if (action.endsWith('.updated') || action.endsWith('.role_changed') || action.endsWith('.transferred'))
    return 'blue'
  if (action.endsWith('.deleted') || action.endsWith('.deactivated') || action.endsWith('.rejected') || action.endsWith('.terminated'))
    return 'coral'
  if (action.endsWith('.approved'))
    return 'green'
  return ''
}

function diffSummary(entry: AuditLogEntry): string {
  const before = entry.beforeState ?? {}
  const after = entry.afterState ?? {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const parts: string[] = []
  for (const k of keys) {
    const b = (before as Record<string, unknown>)[k]
    const a = (after as Record<string, unknown>)[k]
    if (b !== a) {
      const bs = b === null || b === undefined ? '—' : String(b)
      const as = a === null || a === undefined ? '—' : String(a)
      if (bs.length < 30 && as.length < 30) {
        parts.push(`${k}: ${bs} → ${as}`)
      } else {
        parts.push(k)
      }
    }
  }
  if (parts.length === 0) {
    if (Object.keys(after).length > 0) {
      const k = Object.keys(after)[0]
      const v = (after as Record<string, unknown>)[k]
      return `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`
    }
    return ''
  }
  return parts.slice(0, 3).join(' · ')
}

const PAGE_SIZE = 50

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AuditLogReportPage() {
  const [page, setPage] = useState(1)
  const [resourceType, setResourceType] = useState('')
  const [action, setAction] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { data, isLoading } = useAuditLog({
    page,
    limit: PAGE_SIZE,
    resourceType: resourceType || undefined,
    action: action || undefined,
  })

  const items = data?.data ?? []
  const total = data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Build a unique action list from what we have, for the action filter.
  const knownActions = useMemo(() => {
    const set = new Set<string>()
    for (const e of items) set.add(e.action)
    return Array.from(set).sort()
  }, [items])

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="relative min-h-full">
      <div className="relative z-10 p-8 max-w-6xl mx-auto">
        <div style={{ marginBottom: 16 }}>
          <Link
            href="/reports"
            className="inline-flex items-center gap-2 text-sm text-brand-muted hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to reports
          </Link>
        </div>

        <SectionHead
          title="Audit log"
          sub={`Immutable · 7-year retention · DPDP-aligned · ${total.toLocaleString()} records`}
          right={
            <div style={{ display: 'flex', gap: 6 }}>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>Export CSV</Btn>
            </div>
          }
        />

        {/* Filters ────────────────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 14, padding: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label className="t-caption" style={{ fontSize: 11 }}>Resource type</label>
            <select
              className="input"
              style={{ minWidth: 160, height: 36, padding: '0 10px', fontSize: 12.5 }}
              value={resourceType}
              onChange={(e) => {
                setResourceType(e.target.value)
                setPage(1)
              }}
            >
              {RESOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === '' ? 'All types' : t}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label className="t-caption" style={{ fontSize: 11 }}>Action</label>
            <select
              className="input"
              style={{ minWidth: 200, height: 36, padding: '0 10px', fontSize: 12.5 }}
              value={action}
              onChange={(e) => {
                setAction(e.target.value)
                setPage(1)
              }}
            >
              <option value="">All actions</option>
              {knownActions.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          {(resourceType || action) && (
            <Btn
              kind="ghost"
              size="sm"
              onClick={() => {
                setResourceType('')
                setAction('')
                setPage(1)
              }}
            >
              Clear
            </Btn>
          )}
        </div>

        {/* Table ───────────────────────────────────────────────────────── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {isLoading ? (
            <div className="p-12 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center' }}>
              <div className="t-h3" style={{ marginBottom: 4 }}>No matching events</div>
              <div className="t-mute" style={{ fontSize: 12 }}>
                Adjust the filters or wait for new activity.
              </div>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                  <th style={th}>When</th>
                  <th style={th}>Actor</th>
                  <th style={th}>Action</th>
                  <th style={th}>Resource</th>
                  <th style={th}>Change</th>
                  <th style={th}>IP</th>
                  <th style={{ ...th, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((e, i) => {
                  const isOpen = expanded.has(e.id)
                  const hasDiff =
                    (e.beforeState && Object.keys(e.beforeState).length > 0) ||
                    (e.afterState && Object.keys(e.afterState).length > 0)
                  return (
                    <Fragment key={e.id}>
                      <tr
                        style={{
                          borderBottom: '1px solid var(--bord)',
                          background: i % 2 === 1 ? 'rgba(255,255,255,0.015)' : 'transparent',
                        }}
                      >
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                          {fmtTimestamp(e.createdAt)}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          {e.actorName ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <Avatar name={e.actorName} size="sm" />
                              <div>
                                <div style={{ fontSize: 12.5, fontWeight: 800 }}>{e.actorName}</div>
                                {e.actorEmail && (
                                  <div style={{ fontSize: 10.5, color: 'var(--text-mute)' }}>
                                    {e.actorEmail}
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : (
                            <span style={{ fontSize: 12, color: 'var(--text-mute)', fontStyle: 'italic' }}>
                              System
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <Pill tone={actionTone(e.action)}>{e.action}</Pill>
                        </td>
                        <td style={td}>
                          <span style={{ fontWeight: 700 }}>{e.resourceType}</span>
                          {e.resourceId && (
                            <div
                              style={{
                                fontSize: 10.5,
                                color: 'var(--text-mute)',
                                fontFamily: 'var(--font-mono)',
                                marginTop: 2,
                              }}
                            >
                              {e.resourceId.slice(0, 8)}…
                            </div>
                          )}
                        </td>
                        <td style={{ ...td, fontSize: 11.5, color: 'var(--text-2)' }}>
                          {diffSummary(e) || '—'}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mute)' }}>
                          {e.ipAddress ?? '—'}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                          {hasDiff && (
                            <Btn kind="ghost" size="sm" onClick={() => toggle(e.id)}>
                              {isOpen ? 'Hide' : 'Diff'}
                            </Btn>
                          )}
                        </td>
                      </tr>
                      {isOpen && hasDiff && (
                        <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                          <td colSpan={7} style={{ padding: 14, background: 'var(--surf-1)' }}>
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: 12,
                              }}
                            >
                              <div>
                                <div className="t-caption" style={{ fontSize: 11, marginBottom: 6 }}>Before</div>
                                <pre
                                  style={{
                                    margin: 0,
                                    padding: 10,
                                    background: 'var(--surf-2)',
                                    border: '1px solid var(--bord)',
                                    borderRadius: 8,
                                    fontSize: 11,
                                    fontFamily: 'var(--font-mono)',
                                    overflow: 'auto',
                                    maxHeight: 200,
                                  }}
                                >
                                  {e.beforeState ? JSON.stringify(e.beforeState, null, 2) : '—'}
                                </pre>
                              </div>
                              <div>
                                <div className="t-caption" style={{ fontSize: 11, marginBottom: 6 }}>After</div>
                                <pre
                                  style={{
                                    margin: 0,
                                    padding: 10,
                                    background: 'var(--surf-2)',
                                    border: '1px solid var(--bord)',
                                    borderRadius: 8,
                                    fontSize: 11,
                                    fontFamily: 'var(--font-mono)',
                                    overflow: 'auto',
                                    maxHeight: 200,
                                  }}
                                >
                                  {e.afterState ? JSON.stringify(e.afterState, null, 2) : '—'}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* Pagination ────────────────────────────────────────────────── */}
          {items.length > 0 && (
            <div
              style={{
                padding: '14px 22px',
                borderTop: '1px solid var(--bord)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 12,
                color: 'var(--text-mute)',
              }}
            >
              <div>
                Page {page} of {totalPages} · Showing {items.length} of {total.toLocaleString()}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn
                  kind="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  icon={<ChevronLeft className="w-3.5 h-3.5" />}
                >
                  Prev
                </Btn>
                <Btn
                  kind="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  iconRight={<ChevronRight className="w-3.5 h-3.5" />}
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

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 11.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-mute)',
}

const td: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 12.5,
  color: 'var(--text-2)',
}
