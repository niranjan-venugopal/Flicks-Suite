'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Modal, Pill, SectionHead, type PillTone } from '@/components/proto'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { usePresence } from '@/lib/api/queries/use-presence'
import {
  EMPLOYEES_PAGE_MAX,
  UI_STATUS_LABELS,
  isPendingInvite,
  useEmployees,
  useImportEmployees,
  useResendAllInvites,
  useResendInvite,
  useRestoreEmployee,
  type EmployeeUiStatus,
  type ImportEmployeeRow,
  type ImportResult,
  type ResendInviteResult,
} from '@/lib/api/queries/use-employees'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Minimal CSV parser: first row is the header. Maps known headers (case- and
// space-insensitive) onto the import payload. Handles simple quoted fields.
const HEADER_MAP: Record<string, keyof ImportEmployeeRow> = {
  fullname: 'fullName',
  name: 'fullName',
  email: 'email',
  employeecode: 'employeeCode',
  code: 'employeeCode',
  department: 'department',
  designation: 'designation',
  title: 'designation',
  location: 'location',
  employmenttype: 'employmentType',
  type: 'employmentType',
  joiningdate: 'joiningDate',
  jobtitle: 'jobTitle',
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

function parseCsv(text: string): ImportEmployeeRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ''))
  const rows: ImportEmployeeRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i])
    const row: Partial<ImportEmployeeRow> = {}
    headers.forEach((h, idx) => {
      const key = HEADER_MAP[h]
      const val = cells[idx]
      if (key && val) row[key] = val
    })
    if (row.fullName && row.email && row.employeeCode) {
      rows.push(row as ImportEmployeeRow)
    }
  }
  return rows
}

// Round P (R1.3): the pill keys on the DERIVED status (use-employees
// deriveUiStatus) — `inactive` alone never told HR whether the person had
// opened their invite, stalled mid-wizard or was waiting on approval.
const UI_STATUS_TONES: Record<EmployeeUiStatus, PillTone> = {
  active: 'green',
  invited: 'yellow',
  onboarding: 'blue',
  submitted: 'purple',
  on_leave: 'yellow',
  notice_period: 'coral',
  separated: 'coral',
  absconded: 'coral',
  no_access: '',
}

// Filter dropdown, in the order HR thinks about them. "Removed" is a separate
// server-side view, appended at the bottom.
const STATUS_FILTERS: EmployeeUiStatus[] = [
  'active',
  'invited',
  'onboarding',
  'submitted',
  'on_leave',
  'notice_period',
  'separated',
  'absconded',
  'no_access',
]

function statusPill(s: EmployeeUiStatus) {
  return (
    <Pill tone={UI_STATUS_TONES[s] ?? ''} dot>
      {UI_STATUS_LABELS[s] ?? s}
    </Pill>
  )
}

/**
 * Resend toast copy (R1.1). The API's own message is the toast for every
 * 409/429 (ALREADY_ONBOARDED / SEAT_DEACTIVATED / EMPLOYEE_REMOVED /
 * RESEND_TOO_SOON) — it already says what to do next. A 200 with
 * `emailSent: false` means the ledger row exists but the provider refused
 * the mail, which must read as a failure, not a success.
 */
function resendToast(
  toast: ReturnType<typeof useToast>['toast'],
  name: string,
  outcome: { ok: true; result: ResendInviteResult } | { ok: false; error: unknown },
) {
  if (!outcome.ok) {
    toast({
      title: 'Could not resend invite',
      description: outcome.error instanceof Error ? outcome.error.message : 'Try again',
      variant: 'destructive',
    })
    return
  }
  if (!outcome.result.emailSent) {
    toast({
      title: 'Invite saved but the email could not be sent — try Resend in a minute',
      description: outcome.result.email,
      variant: 'destructive',
    })
    return
  }
  toast({
    title: `Invite re-sent to ${name}`,
    description: `${outcome.result.email} · reminder #${outcome.result.resentCount}. Earlier links still work.`,
  })
}

function fmtJoin(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function EmployeesPage() {
  const [search, setSearch] = useState('')
  const [filterDept, setFilterDept] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [importOpen, setImportOpen] = useState(false)
  const [parsedRows, setParsedRows] = useState<ImportEmployeeRow[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  // "Removed" is a separate server-side view (deleted_at IS NOT NULL), not a
  // status value — round 21's archive-on-remove keeps these out of every
  // normal directory read.
  const removedView = filterStatus === 'removed'
  const list = useEmployees(removedView ? { removed: true } : {})
  // GET /employees is manager-or-above, but both resend endpoints are
  // admin-only (contracts C1/C2) — same gate as the 360 header, so a manager
  // never sees a button that can only 403.
  const role = useAuthStore((s) => s.currentUser?.role)
  const canResend = role === 'OWNER' || role === 'HR_ADMIN'
  const importEmployees = useImportEmployees()
  const restore = useRestoreEmployee()
  const resend = useResendInvite()
  const resendAll = useResendAllInvites()
  const [resendAllOpen, setResendAllOpen] = useState(false)
  // Which row's Resend is in flight — only that button shows "Sending…".
  const [resendingId, setResendingId] = useState<string | null>(null)
  const { toast } = useToast()

  const handleResend = async (id: string, name: string) => {
    setResendingId(id)
    try {
      const result = await resend.mutateAsync(id)
      resendToast(toast, name, { ok: true, result })
    } catch (error) {
      resendToast(toast, name, { ok: false, error })
    } finally {
      setResendingId(null)
    }
  }

  // Server-side "everyone still waiting" (ids omitted) rather than the ids on
  // screen: the list is capped at 100 rows and may be filtered, and the API
  // applies the same per-row eligibility + 60 s throttle either way.
  const handleResendAll = async () => {
    try {
      const res = await resendAll.mutateAsync(undefined)
      setResendAllOpen(false)
      const skipped = res.skipped.length
      toast({
        title: `Re-sent ${res.sent} invite${res.sent === 1 ? '' : 's'}`,
        description:
          skipped === 0
            ? 'Everyone still waiting has a fresh link in their inbox.'
            : `${skipped} skipped — ${res.skipped
                .slice(0, 3)
                .map((s) => `${s.email || 'unknown'}: ${s.reason}`)
                .join('; ')}${skipped > 3 ? '; …' : ''}`,
        variant: res.sent === 0 && skipped > 0 ? 'destructive' : undefined,
      })
    } catch (err) {
      toast({
        title: 'Could not resend invites',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handleFile = async (file: File | undefined) => {
    setResult(null)
    setParseError(null)
    if (!file) return
    const text = await file.text()
    const rows = parseCsv(text)
    if (rows.length === 0) {
      setParseError(
        'No valid rows found. The header row needs at least fullName, email, employeeCode.',
      )
      setParsedRows([])
      return
    }
    setParsedRows(rows)
  }

  const handleImport = async () => {
    if (parsedRows.length === 0) return
    try {
      const res = await importEmployees.mutateAsync(parsedRows)
      setResult(res)
      const skippedN = res.skipped?.length ?? 0
      toast({
        title: `Imported ${res.created} of ${res.total}`,
        description:
          res.failed.length > 0
            ? `${res.failed.length} row(s) failed.${skippedN ? ` ${skippedN} already invited.` : ''}`
            : skippedN
              ? `${skippedN} row(s) skipped — already invited. Use Resend invite instead.`
              : 'All rows imported.',
        variant: res.failed.length > 0 ? 'destructive' : undefined,
      })
    } catch (e) {
      toast({
        title: 'Import failed',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const closeImport = () => {
    setImportOpen(false)
    setParsedRows([])
    setParseError(null)
    setResult(null)
  }

  // Client-side filter on top of the API list — search is local for now.
  const all = list.data?.employees ?? []
  // D9 (PRD v4 §5) — seed batched presence for the visible people.
  usePresence(all.map((e) => e.userId).filter((id): id is string => !!id))
  const filtered = all.filter((e) => {
    if (filterStatus !== 'all' && !removedView && e.uiStatus !== filterStatus) return false
    if (filterDept !== 'all' && (e.department ?? '') !== filterDept) return false
    if (search) {
      const q = search.toLowerCase()
      if (!e.name.toLowerCase().includes(q) && !e.email.toLowerCase().includes(q)) return false
    }
    return true
  })

  const allDepts = Array.from(new Set(all.map((e) => e.department).filter(Boolean))) as string[]

  const counts = {
    active: all.filter((e) => e.uiStatus === 'active').length,
    invited: all.filter((e) => e.uiStatus === 'invited').length,
    onboarding: all.filter((e) => e.uiStatus === 'onboarding').length,
    submitted: all.filter((e) => e.uiStatus === 'submitted').length,
  }
  // Rows Resend applies to: never opened the link, or opened it and stalled.
  const pendingCount = counts.invited + counts.onboarding
  // The API caps a page at 100 (contract C4) and `total` is now a real count,
  // so we can say when the roster is longer than what's on screen.
  const total = list.data?.total ?? 0
  const truncated = !removedView && total > all.length

  // "N active · N invited · N awaiting approval" — zero segments are dropped
  // so a small team doesn't read "0 invited · 0 awaiting approval" forever.
  // Past the page cap the counts only describe the rows on screen (search and
  // the filters are client-side too), so say so instead of understating.
  const countSegments = [
    `${counts.active} active`,
    counts.invited > 0 ? `${counts.invited} invited` : null,
    counts.onboarding > 0 ? `${counts.onboarding} onboarding` : null,
    counts.submitted > 0 ? `${counts.submitted} awaiting approval` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const headerSub = truncated
    ? `${total} employees · first ${all.length} shown: ${countSegments}`
    : countSegments

  // "Resend all pending" sends ids-omitted, so the server mails EVERY eligible
  // row — beyond the first page too. Only promise a number when the whole
  // roster is on screen; otherwise the button stays available but count-free.
  const showResendAll = canResend && !removedView && (pendingCount > 0 || truncated)
  const resendAllLabel = truncated ? 'Resend all pending' : `Resend all pending (${pendingCount})`
  const resendAllSub = truncated
    ? `Everyone still waiting on their invite gets a reminder — ${pendingCount} on this page, and anyone beyond the first ${all.length} rows.`
    : `${pendingCount} ${pendingCount === 1 ? 'person is' : 'people are'} still waiting on their invite.`
  const resendAllConfirm = truncated ? 'Resend all' : `Resend ${pendingCount}`

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Employees"
          sub={list.isLoading ? 'Loading…' : headerSub}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              {showResendAll && (
                <Btn
                  kind="secondary"
                  size="sm"
                  icon={<Icon.send size={13} />}
                  onClick={() => setResendAllOpen(true)}
                  disabled={resendAll.isPending}
                >
                  {resendAllLabel}
                </Btn>
              )}
              {/* Round Q: inviting and importing are Owner / HR actions (the
                  API is @Roles('admin')) — a manager opening this page by URL
                  no longer sees buttons that can only fail. */}
              {canResend && (
                <Btn
                  kind="secondary"
                  size="sm"
                  icon={<Icon.upload size={13} />}
                  onClick={() => setImportOpen(true)}
                >
                  Import CSV
                </Btn>
              )}
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export
              </Btn>
              {canResend && (
                <Link href="/employees/add" style={{ textDecoration: 'none' }}>
                  <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />}>
                    Invite employee
                  </Btn>
                </Link>
              )}
            </div>
          }
        />

        {/* Filter bar */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
            <Icon.search
              size={14}
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-faint)',
              }}
            />
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email…"
              style={{ paddingLeft: 34, height: 38 }}
            />
          </div>
          <select
            className="input"
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
            style={{ height: 38, width: 160 }}
          >
            <option value="all">All departments</option>
            {allDepts.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select
            className="input"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ height: 38, width: 140 }}
          >
            <option value="all">All statuses</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {UI_STATUS_LABELS[s]}
              </option>
            ))}
            <option value="removed">Removed</option>
          </select>
        </div>

        {truncated && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 12,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-mute)',
            }}
          >
            <Icon.info size={13} />
            Showing the first {Math.min(all.length, EMPLOYEES_PAGE_MAX)} of {total} employees — people
            beyond that aren&apos;t listed here yet. Search and the filters only cover these rows.
          </div>
        )}

        {/* List */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {list.isLoading ? (
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
              <Loader2 className="w-4 h-4 animate-spin" /> Loading employees…
            </div>
          ) : list.isError ? (
            <div
              style={{
                padding: 48,
                textAlign: 'center',
                color: 'var(--coral)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Could not load employees. You may need manager-or-above permissions.
            </div>
          ) : filtered.length === 0 ? (
            <div
              style={{
                padding: 60,
                textAlign: 'center',
                color: 'var(--text-mute)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {removedView
                ? 'Nobody has been removed. Removed employees appear here and can be restored.'
                : all.length === 0
                  ? 'No employees yet. Invite your first teammate.'
                  : `No employees match the current filters (${all.length} total).`}
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Code</th>
                  <th>Department</th>
                  <th>Location</th>
                  <th>Joined</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id} style={{ cursor: 'pointer' }}>
                    <td>
                      <Link
                        href={`/employees/${e.id}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 11,
                          textDecoration: 'none',
                          color: 'inherit',
                        }}
                      >
                        <RowPresenceAvatar name={e.name} size={30} src={e.avatarUrl} userId={e.userId} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em' }}>
                            {e.name}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--text-mute)',
                              fontFamily: 'var(--font-mono)',
                            }}
                          >
                            {e.email || '—'}
                          </div>
                        </div>
                      </Link>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                      {e.employeeCode ?? '—'}
                    </td>
                    <td>
                      {e.department ? <Pill>{e.department}</Pill> : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                    </td>
                    <td style={{ color: 'var(--text-2)' }}>{e.location ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {fmtJoin(e.joinDate)}
                    </td>
                    <td>{removedView ? <Pill tone="coral" dot>Removed</Pill> : statusPill(e.uiStatus)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {removedView ? (
                        <Btn
                          kind="secondary"
                          size="sm"
                          icon={<Icon.refresh size={12} />}
                          disabled={restore.isPending}
                          onClick={async () => {
                            try {
                              await restore.mutateAsync(e.id)
                              // R1.2: restore now relinks the seat too — the
                              // old "sign-in stays revoked" copy was wrong.
                              toast({
                                title: `${e.name} restored`,
                                description:
                                  'Record and sign-in restored. If they never accepted their invite, use Resend invite.',
                              })
                            } catch (err) {
                              toast({
                                title: 'Could not restore',
                                description: err instanceof Error ? err.message : 'Try again',
                                variant: 'destructive',
                              })
                            }
                          }}
                        >
                          Restore
                        </Btn>
                      ) : (
                        <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          {canResend && isPendingInvite(e.uiStatus) && (
                            <Btn
                              kind="secondary"
                              size="sm"
                              icon={<Icon.send size={12} />}
                              disabled={resendingId === e.id || resendAll.isPending}
                              onClick={() => handleResend(e.id, e.name)}
                            >
                              {resendingId === e.id ? 'Sending…' : 'Resend invite'}
                            </Btn>
                          )}
                          <Link href={`/employees/${e.id}`} style={{ textDecoration: 'none' }}>
                            <Btn kind="ghost" size="sm" iconRight={<Icon.chevR size={12} />}>
                              View
                            </Btn>
                          </Link>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {canResend && (
        <Modal
          open={resendAllOpen}
          onClose={() => !resendAll.isPending && setResendAllOpen(false)}
          title="Resend all pending invites?"
          sub={resendAllSub}
          width={460}
          footer={
            <>
              <Btn kind="ghost" onClick={() => setResendAllOpen(false)} disabled={resendAll.isPending}>
                Cancel
              </Btn>
              <Btn
                kind="primary"
                icon={<Icon.send size={13} />}
                onClick={handleResendAll}
                disabled={resendAll.isPending}
              >
                {resendAll.isPending ? 'Sending…' : resendAllConfirm}
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: 0, lineHeight: 1.55 }}>
            Everyone who hasn&apos;t accepted yet gets a reminder email with a fresh 7-day link.
            Earlier links keep working. Anyone emailed in the last minute is skipped, and the
            result tells you who.
          </p>
        </Modal>
      )}

      <Dialog open={importOpen} onOpenChange={(o) => (o ? setImportOpen(true) : closeImport())}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import employees from CSV</DialogTitle>
          </DialogHeader>

          {result ? (
            <div>
              <div
                style={{
                  background: 'var(--surf-1)',
                  border: '1px solid var(--bord)',
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 800 }}>
                  {result.created} of {result.total} imported
                </div>
                {result.failed.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--coral)', marginTop: 4 }}>
                    {result.failed.length} row(s) failed
                  </div>
                )}
                {(result.skipped?.length ?? 0) > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-mute)', marginTop: 4 }}>
                    {result.skipped!.length} row(s) skipped — already invited
                  </div>
                )}
              </div>
              {(result.failed.length > 0 || (result.skipped?.length ?? 0) > 0) && (
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {result.failed.map((f) => (
                    <div
                      key={`f-${f.row}`}
                      style={{
                        fontSize: 12,
                        padding: '6px 0',
                        borderTop: '1px solid var(--bord)',
                      }}
                    >
                      <span style={{ fontWeight: 700 }}>Row {f.row}</span>{' '}
                      <span style={{ color: 'var(--text-mute)' }}>{f.email}</span>
                      <div style={{ color: 'var(--coral)' }}>{f.error}</div>
                    </div>
                  ))}
                  {(result.skipped ?? []).map((s) => (
                    <div
                      key={`s-${s.row}`}
                      style={{
                        fontSize: 12,
                        padding: '6px 0',
                        borderTop: '1px solid var(--bord)',
                      }}
                    >
                      <span style={{ fontWeight: 700 }}>Row {s.row}</span>{' '}
                      <span style={{ color: 'var(--text-mute)' }}>{s.email}</span>
                      <div style={{ color: 'var(--text-2)' }}>{s.reason}</div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <Btn kind="primary" onClick={closeImport}>Done</Btn>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
                Upload a CSV with a header row. Required columns:{' '}
                <code>fullName</code>, <code>email</code>, <code>employeeCode</code>. Optional:{' '}
                <code>department</code>, <code>designation</code>, <code>location</code>,{' '}
                <code>employmentType</code>, <code>joiningDate</code>, <code>jobTitle</code>.
                Department / designation / location are matched by name.
              </p>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => handleFile(e.target.files?.[0])}
                className="input"
                style={{ width: '100%', padding: 8, fontSize: 12.5 }}
              />
              {parseError && (
                <p style={{ fontSize: 12, color: 'var(--coral)', marginTop: 8 }}>{parseError}</p>
              )}
              {parsedRows.length > 0 && (
                <p style={{ fontSize: 12.5, color: 'var(--green)', marginTop: 8 }}>
                  {parsedRows.length} valid row(s) ready to import.
                </p>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <Btn kind="ghost" onClick={closeImport} disabled={importEmployees.isPending}>
                  Cancel
                </Btn>
                <Btn
                  kind="primary"
                  onClick={handleImport}
                  disabled={parsedRows.length === 0 || importEmployees.isPending}
                >
                  {importEmployees.isPending ? 'Importing…' : `Import ${parsedRows.length || ''}`.trim()}
                </Btn>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
