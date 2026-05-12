'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useEmployees, type Employee } from '@/lib/api/queries/use-employees'

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
  const list = useEmployees({})

  // Client-side filter on top of the API list — search is local for now.
  const all = list.data?.employees ?? []
  const filtered = all.filter((e) => {
    if (filterStatus !== 'all' && e.status !== filterStatus) return false
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
              <Btn kind="secondary" size="sm" icon={<Icon.upload size={13} />}>
                Import CSV
              </Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export
              </Btn>
              <Link href="/employees/onboarding" style={{ textDecoration: 'none' }}>
                <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />}>
                  Add employee
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
              {all.length === 0
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
                        <Avatar name={e.name} size="sm" src={e.avatarUrl} />
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
                    <td>{statusPill(e.status)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Link href={`/employees/${e.id}`} style={{ textDecoration: 'none' }}>
                        <Btn kind="ghost" size="sm" iconRight={<Icon.chevR size={12} />}>
                          View
                        </Btn>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
