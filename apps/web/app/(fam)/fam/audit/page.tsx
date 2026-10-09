'use client'

import { Suspense, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Btn, Icon, SectionHead } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  downloadPlatformAuditCsv,
  useFamPlatformAudit,
  type FamAuditFilters,
} from '@/lib/api/queries/use-fam'
import { timeAgo } from '@/lib/utils'

/**
 * Platform audit log — Round R R2 wires the filters (date range, action,
 * actor, company) and the CSV export, and shows where each action came from.
 */

function actionTone(action: string) {
  if (action.includes('impersonate')) return 'var(--coral)'
  if (action.includes('suspend') || action.includes('rejected') || action.includes('signed_out')) return 'var(--coral)'
  if (action.includes('alert') || action.includes('warn') || action.includes('lockout')) return 'var(--yellow)'
  if (action.includes('verified') || action.includes('approved') || action.includes('reactivated') || action.includes('granted')) return 'var(--green)'
  return 'var(--blue)'
}

type Range = 'today' | '7d' | '30d' | 'all'
// A leading ^ anchors the term to the start of the action; commas separate
// alternatives (the API's `action` filter understands both).
const CATEGORY_ACTION: Record<string, string> = {
  all: '',
  impersonation: 'impersonat',
  lifecycle: '^tenant.',
  user: '^fam.user.',
  member: '^fam.member.',
  notes: '^fam.tenant.note_',
  flags: 'flag',
  billing: '^fam.free_months,coupon',
}

function since(range: Range): string | undefined {
  if (range === 'all') return undefined
  const d = new Date()
  if (range === 'today') d.setHours(0, 0, 0, 0)
  else d.setDate(d.getDate() - (range === '7d' ? 7 : 30))
  return d.toISOString()
}

export default function FamAuditPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <FamAuditInner />
    </Suspense>
  )
}

function FamAuditInner() {
  const { toast } = useToast()
  const sp = useSearchParams()
  // ?category= so the feature-flags page (and emails) can deep-link a slice.
  const wantedCategory = sp.get('category')
  const [page, setPage] = useState(1)
  const [range, setRange] = useState<Range>('30d')
  const [category, setCategory] = useState(wantedCategory && wantedCategory in CATEGORY_ACTION ? wantedCategory : 'all')
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [exporting, setExporting] = useState(false)
  const limit = 25

  const filters = useMemo<FamAuditFilters>(() => {
    const f: FamAuditFilters = {}
    const from = since(range)
    if (from) f.from = from
    const a = action.trim() || CATEGORY_ACTION[category] || ''
    if (a) f.action = a
    if (actor.trim()) f.actor = actor.trim()
    if (/^[0-9a-f-]{36}$/i.test(tenantId.trim())) f.tenantId = tenantId.trim()
    return f
  }, [range, category, action, actor, tenantId])

  const audit = useFamPlatformAudit(page, limit, filters)
  const rows = audit.data?.data ?? []
  const total = audit.data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const reset = () => setPage(1)

  const exportCsv = async () => {
    setExporting(true)
    try {
      await downloadPlatformAuditCsv(filters)
    } catch (e) {
      toast({ title: 'Export failed', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Platform audit log"
          sub="Every FAM action, with who, from where, and on whom"
          right={
            <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />} onClick={() => void exportCsv()} disabled={exporting} data-testid="audit-export">
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Btn>
          }
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 14 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {audit.isLoading ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
              </div>
            ) : rows.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12 }}>
                No platform events match these filters.
              </div>
            ) : (
              <table className="tbl" style={{ width: '100%' }} data-testid="audit-table">
                <thead>
                  <tr>
                    <th style={{ width: 120 }}>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>From</th>
                    <th>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mute)', whiteSpace: 'nowrap' }} title={r.createdAt}>
                        {timeAgo(r.createdAt)}
                      </td>
                      <td>
                        <div style={{ fontSize: 12.5, fontWeight: 800 }}>{r.actor}</div>
                        {r.actorEmail && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>{r.actorEmail}</div>}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 800, color: actionTone(r.action) }}>{r.action}</td>
                      <td>
                        {r.targetTenantId ? (
                          <Link href={`/fam/tenants/${r.targetTenantId}`} style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}>
                            {r.targetTenantName ?? r.targetTenantId.slice(0, 8)}
                          </Link>
                        ) : r.targetUserId ? (
                          <Link href={`/fam/users/${r.targetUserId}`} style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}>
                            person {r.targetUserId.slice(0, 8)}
                          </Link>
                        ) : (
                          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-mute)', whiteSpace: 'nowrap' }} title={r.userAgent ?? undefined}>
                        {r.ipAddress ?? '—'}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', wordBreak: 'break-word', maxWidth: 260 }}>
                        {r.metadata ? JSON.stringify(r.metadata) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--bord)', background: 'var(--surf-1)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)' }} data-testid="audit-count">
                Showing {rows.length} of {total} entries
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn kind="ghost" size="sm" icon={<Icon.chevL size={12} />} disabled={page <= 1 || audit.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))} />
                <Btn kind="ghost" size="sm" icon={<Icon.chevR size={12} />} disabled={page >= totalPages || audit.isFetching} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} />
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 18, alignSelf: 'start' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 12 }}>Filters</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <FilterGroup label="Date range">
                <select className="input" value={range} onChange={(e) => { setRange(e.target.value as Range); reset() }} data-testid="audit-range">
                  <option value="today">Today</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="all">All time</option>
                </select>
              </FilterGroup>
              <FilterGroup label="Category">
                <select className="input" value={category} onChange={(e) => { setCategory(e.target.value); setAction(''); reset() }} data-testid="audit-category">
                  <option value="all">All</option>
                  <option value="impersonation">Impersonation</option>
                  <option value="lifecycle">Company lifecycle</option>
                  <option value="user">Person actions</option>
                  <option value="member">Member actions</option>
                  <option value="notes">Support notes</option>
                  <option value="billing">Coupons & free months</option>
                  <option value="flags">Feature flags</option>
                </select>
              </FilterGroup>
              <FilterGroup label="Action contains">
                <input className="input" value={action} onChange={(e) => { setAction(e.target.value); reset() }} placeholder="e.g. tenant.suspended" data-testid="audit-action" />
              </FilterGroup>
              <FilterGroup label="Actor">
                <input className="input" value={actor} onChange={(e) => { setActor(e.target.value); reset() }} placeholder="email or name" data-testid="audit-actor" />
              </FilterGroup>
              <FilterGroup label="Company id">
                <input className="input" value={tenantId} onChange={(e) => { setTenantId(e.target.value); reset() }} placeholder="paste a tenant id" />
              </FilterGroup>
              <Btn kind="ghost" size="sm" onClick={() => { setRange('30d'); setCategory('all'); setAction(''); setActor(''); setTenantId(''); reset() }}>
                Clear filters
              </Btn>
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
      <label className="label" style={{ display: 'block', fontSize: 10, fontWeight: 800, color: 'var(--text-faint)', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  )
}
