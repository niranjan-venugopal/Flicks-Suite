'use client'

import { useMemo, useState } from 'react'
import { Icon, Kpi, Pill } from '@/components/proto'
import { MonthNav, monthTitle } from '@/components/ui/month-nav'
import { SkeletonRows, StateEmpty } from '@/components/states'
import {
  useEmployeeAttendance,
  type EmployeeAttendanceRecord,
} from '@/lib/api/queries/use-attendance'

// Employee-360° → Attendance tab (founder round 15): the employee's REAL
// month-by-month history in place of the old "open the module" dead end.
// Mirrors the personal Attendance page's month KPIs + daily log, minus the
// self-service bits (clock card, regularize) that only make sense for "me".
// Access is enforced server-side: the employee themselves, their reporting
// manager, and owner/admin/finance.

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
function fmtHM(mins: number): string {
  if (!mins) return '—'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${m.toString().padStart(2, '0')}m`
}
function fmtClock(iso: string | null | undefined, tz = 'Asia/Kolkata'): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
    hour12: false,
  })
}
function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })
}

function statusPill(r: EmployeeAttendanceRecord) {
  // A remote day shows WFH — status carries lateness, work_mode carries place.
  if (
    r.workMode === 'remote' &&
    (r.attendanceStatus === 'present' || r.attendanceStatus === 'late' || r.attendanceStatus === 'half_day')
  ) {
    return <Pill tone="blue" dot>WFH</Pill>
  }
  switch (r.attendanceStatus) {
    case 'present': return <Pill tone="green" dot>Present</Pill>
    case 'late':    return <Pill tone="yellow" dot>Late</Pill>
    case 'absent':  return <Pill tone="coral" dot>Absent</Pill>
    case 'on_leave': return <Pill tone="purple" dot>Leave</Pill>
    case 'holiday': return <Pill tone="coral">Holiday</Pill>
    case 'weekend': return <Pill>Weekend</Pill>
    case 'work_from_home': return <Pill tone="blue" dot>WFH</Pill>
    case 'half_day': return <Pill tone="yellow">Half day</Pill>
    default:        return <Pill>{r.attendanceStatus}</Pill>
  }
}

export function EmployeeAttendanceTab({ employeeId }: { employeeId: string }) {
  const [cursor, setCursor] = useState(new Date())
  const fromDate = toISODate(new Date(cursor.getFullYear(), cursor.getMonth(), 1))
  const monthEnd = toISODate(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0))
  const toDate = monthEnd < todayISO() ? monthEnd : todayISO()
  const range = useEmployeeAttendance(employeeId, { fromDate, toDate, limit: 31 })
  const rows = useMemo(() => range.data?.data ?? [], [range.data])

  const stats = useMemo(() => {
    let present = 0
    let wfh = 0
    let totalWorked = 0
    let workedDays = 0
    let lateCount = 0
    for (const r of rows) {
      if (r.attendanceStatus === 'present' || r.attendanceStatus === 'late') {
        present += 1
        if (r.workMode === 'remote') wfh += 1
      }
      if (r.totalWorkedMinutes > 0) {
        totalWorked += r.totalWorkedMinutes
        workedDays += 1
      }
      if (r.isLate) lateCount += 1
    }
    const avg = workedDays > 0 ? Math.round(totalWorked / workedDays) : 0
    return { present, wfh, avg, lateCount }
  }, [rows])

  // The server refuses when the viewer isn't the employee, their manager, or
  // an admin — say so honestly instead of an empty table.
  if (range.error) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center' }}>
        <div className="t-h3" style={{ marginBottom: 8 }}>Attendance</div>
        <p className="t-mute" style={{ fontSize: 13, maxWidth: 460, margin: '0 auto' }}>
          Attendance history here is visible to the employee themselves, their
          reporting manager, and workspace admins.
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <MonthNav cursor={cursor} onChange={setCursor} maxMonth={new Date()} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <Kpi
          label="Days present"
          value={stats.present}
          delta={stats.present > 0 ? monthTitle(cursor) : '—'}
          icon={<Icon.check size={16} />}
          accent="green"
        />
        <Kpi
          label="WFH days"
          value={stats.wfh}
          delta={stats.wfh > 0 ? 'Outside the geofence' : 'None'}
          icon={<Icon.home size={16} />}
          accent="blue"
        />
        <Kpi
          label="Avg hours / day"
          value={fmtHM(stats.avg)}
          delta={stats.avg ? 'On worked days' : '—'}
          icon={<Icon.clock size={16} />}
          accent="purple"
        />
        <Kpi
          label="Late arrivals"
          value={stats.lateCount}
          delta={stats.lateCount > 0 ? monthTitle(cursor) : 'None'}
          icon={<Icon.warn size={16} />}
          accent="yellow"
        />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--bord)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div className="t-h3" style={{ fontSize: 15 }}>Daily log</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', letterSpacing: '.04em', textTransform: 'uppercase' }}>
            {monthTitle(cursor)}
          </div>
        </div>
        {range.isLoading ? (
          <SkeletonRows rows={6} height={44} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 20 }}>
            <StateEmpty
              line="No attendance records for this month."
              icon={<Icon.fingerprint size={20} />}
            />
          </div>
        ) : (
          <table className="tbl" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Day</th>
                <th>In</th>
                <th>Out</th>
                <th>Hours</th>
                <th>Break</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 800 }}>{fmtDate(r.attendanceDate)}</td>
                  <td style={{ color: 'var(--text-mute)' }}>{fmtDay(r.attendanceDate)}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmtClock(r.firstPunchInAt)}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmtClock(r.lastPunchOutAt)}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: r.totalWorkedMinutes > 540 ? 'var(--purple)' : '#fff' }}>
                    {fmtHM(r.totalWorkedMinutes)}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{fmtHM(r.totalBreakMinutes)}</td>
                  <td>
                    {statusPill(r)}
                    {r.isLate && r.lateByMinutes > 0 && (
                      <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: 'var(--yellow)' }}>
                        +{r.lateByMinutes}m
                      </span>
                    )}
                    {r.isRegularized && (
                      <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 800, color: 'var(--yellow)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                        · regularized
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
