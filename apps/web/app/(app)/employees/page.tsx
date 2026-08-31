'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { usePresence } from '@/lib/api/queries/use-presence'
import {
  useEmployees,
  useImportEmployees,
  useRestoreEmployee,
  type Employee,
  type ImportEmployeeRow,
  type ImportResult,
} from '@/lib/api/queries/use-employees'
import { useToast } from '@/components/ui/use-toast'
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

function statusPill(s: Employee['status']) {
  switch (s) {
    case 'active':   return <Pill tone="green" dot>Active</Pill>
    case 'invited':  return <Pill tone="yellow" dot>Pending invite</Pill>
    case 'on_leave': return <Pill tone="purple" dot>On leave</Pill>
    case 'on_notice':return <Pill tone="coral" dot>On notice</Pill>
    case 'inactive': return <Pill dot>Inactive</Pill>
    default:         return <Pill>{s}</Pill>
  }
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
  const importEmployees = useImportEmployees()
  const restore = useRestoreEmployee()
  const { toast } = useToast()

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
      toast({
        title: `Imported ${res.created} of ${res.total}`,
        description: res.failed.length > 0 ? `${res.failed.length} row(s) failed.` : 'All rows imported.',
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
    if (filterStatus !== 'all' && !removedView && e.status !== filterStatus) return false
    if (filterDept !== 'all' && (e.department ?? '') !== filterDept) return false
    if (search) {
      const q = search.toLowerCase()
      if (!e.name.toLowerCase().includes(q) && !e.email.toLowerCase().includes(q)) return false
    }
    return true
  })

  const allDepts = Array.from(new Set(all.map((e) => e.department).filter(Boolean))) as string[]

  const counts = {
    active: all.filter((e) => e.status === 'active').length,
    invited: all.filter((e) => e.status === 'invited').length,
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Employees"
          sub={
            list.isLoading
              ? 'Loading…'
              : `${counts.active} active${counts.invited > 0 ? ` · ${counts.invited} pending invites` : ''}`
          }
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn
                kind="secondary"
                size="sm"
                icon={<Icon.upload size={13} />}
                onClick={() => setImportOpen(true)}
              >
                Import CSV
              </Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export
              </Btn>
              <Link href="/employees/add" style={{ textDecoration: 'none' }}>
                <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />}>
                  Invite employee
                </Btn>
              </Link>
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
            <option value="active">Active</option>
            <option value="invited">Pending</option>
            <option value="inactive">Inactive</option>
            <option value="on_leave">On leave</option>
            <option value="on_notice">On notice</option>
            <option value="removed">Removed</option>
          </select>
        </div>

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
                    <td>{removedView ? <Pill tone="coral" dot>Removed</Pill> : statusPill(e.status)}</td>
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
                              toast({
                                title: `${e.name} restored`,
                                description:
                                  'Their record is back in the directory. Their sign-in stays revoked — re-invite them if they need access.',
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
                        <Link href={`/employees/${e.id}`} style={{ textDecoration: 'none' }}>
                          <Btn kind="ghost" size="sm" iconRight={<Icon.chevR size={12} />}>
                            View
                          </Btn>
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

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
              </div>
              {result.failed.length > 0 && (
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {result.failed.map((f) => (
                    <div
                      key={f.row}
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
