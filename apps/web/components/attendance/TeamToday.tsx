'use client'

import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { Avatar, Icon, Kpi, Pill, type PillTone } from '@/components/proto'
import { useTeamToday, type TeamMemberToday } from '@/lib/api/queries/use-attendance'
import { useAuthStore } from '@/lib/stores/auth.store'

// The "complete" attendance view (founder round 14): embedded in the
// Attendance page behind the My/Team toggle instead of living on its own
// route. Managers see direct reports; owner/admin/finance see the whole
// workspace (the API scopes by role).

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function fmtWorked(min: number | null): string {
  if (!min) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${h}h ${m.toString().padStart(2, '0')}m`
}

function statusPill(t: TeamMemberToday): { tone: PillTone; label: string } {
  // Work mode wins for present-ish days: a remote day shows WFH even though
  // its attendance_status is present/late (status carries lateness, not place).
  if (
    t.workMode === 'remote' &&
    (t.attendanceStatus === 'present' || t.attendanceStatus === 'late' || t.attendanceStatus === 'half_day')
  ) {
    return { tone: 'blue', label: 'WFH' }
  }
  if (!t.attendanceStatus) {
    return { tone: 'yellow', label: 'Yet to clock in' }
  }
  switch (t.attendanceStatus) {
    case 'present':         return { tone: 'green',  label: 'Present' }
    case 'late':            return { tone: 'yellow', label: 'Late' }
    case 'work_from_home':  return { tone: 'blue',   label: 'WFH' }
    case 'on_leave':        return { tone: 'purple', label: 'On leave' }
    case 'on_duty':         return { tone: 'blue',   label: 'On duty' }
    case 'comp_off':        return { tone: 'green',  label: 'Comp off' }
    case 'absent':          return { tone: 'coral',  label: 'Absent' }
    case 'half_day':        return { tone: 'yellow', label: 'Half day' }
    case 'holiday':         return { tone: '',       label: 'Holiday' }
    case 'weekend':         return { tone: '',       label: 'Weekend' }
    default:                return { tone: '',       label: t.attendanceStatus }
  }
}

function locationLabel(t: TeamMemberToday): string {
  if (t.workMode === 'remote') return 'Home'
  if (t.recordId && t.locationName) return t.locationName
  return t.locationName ?? '—'
}

export function TeamToday() {
  const { data, isLoading } = useTeamToday()
  const role = useAuthStore((s) => s.currentUser?.role)
  // Managers get their direct reports from the API; every other permitted
  // role (owner/admin/finance) gets the whole workspace.
  const orgWide = role !== 'MANAGER'
  const rows = data ?? []

  const kpis = useMemo(() => {
    let inOffice = 0
    let wfh = 0
    let onLeave = 0
    let yetToClockIn = 0
    let late = 0
    for (const r of rows) {
      const s = r.attendanceStatus
      const remote = r.workMode === 'remote'
      if (s === 'present' || s === 'on_duty' || s === 'comp_off' || s === 'half_day') {
        if (remote) wfh++
        else inOffice++
      } else if (s === 'work_from_home') wfh++
      else if (s === 'on_leave') onLeave++
      else if (s === 'late') {
        if (remote) wfh++
        else inOffice++
        if (r.isLate) late++
      } else if (!s || s === 'absent') yetToClockIn++
      // holiday / weekend days count in no tile — nobody is expected in.
    }
    return { inOffice, wfh, onLeave, yetToClockIn, late }
  }, [rows])

  return (
    <>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          color: 'var(--text-mute)',
          margin: '2px 0 14px',
        }}
      >
        {orgWide
          ? `Live · everyone in your workspace today (${rows.length})`
          : `Live · ${rows.length} direct report${rows.length === 1 ? '' : 's'} today`}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 12,
          marginBottom: 18,
        }}
      >
        <Kpi
          label="In office"
          value={kpis.inOffice.toString()}
          icon={<Icon.building size={14} />}
          accent="green"
        />
        <Kpi
          label="WFH"
          value={kpis.wfh.toString()}
          icon={<Icon.home size={14} />}
          accent="blue"
        />
        <Kpi
          label="On leave"
          value={kpis.onLeave.toString()}
          icon={<Icon.cal size={14} />}
          accent="purple"
        />
        <Kpi
          label="Yet to clock in"
          value={kpis.yetToClockIn.toString()}
          icon={<Icon.clock size={14} />}
          accent="yellow"
        />
        <Kpi
          label="Late today"
          value={kpis.late.toString()}
          icon={<Icon.warn size={14} />}
          accent="coral"
        />
      </div>

      {isLoading ? (
        <div
          className="card"
          style={{ padding: 60, display: 'flex', justifyContent: 'center' }}
        >
          <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
        </div>
      ) : rows.length === 0 ? (
        <div
          className="card"
          style={{
            padding: 60,
            textAlign: 'center',
            color: 'var(--text-mute)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <Icon.clock
            size={28}
            style={{ color: 'var(--text-faint)', marginBottom: 12 }}
          />
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: '#fff',
              marginBottom: 6,
            }}
          >
            {orgWide ? 'No active employees yet' : 'No direct reports yet'}
          </div>
          <div>
            {orgWide
              ? 'Add employees in People and their attendance shows up here.'
              : 'Once employees are assigned to you as their manager, their attendance shows up here.'}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                <th style={th}>Employee</th>
                <th style={th}>Status</th>
                <th style={th}>Location</th>
                <th style={th}>Clock in</th>
                <th style={th}>Clock out</th>
                <th style={th}>Worked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i, arr) => {
                const pill = statusPill(r)
                return (
                  <tr
                    key={r.employeeId}
                    style={{
                      borderBottom:
                        i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                    }}
                  >
                    <td style={{ padding: '12px 14px' }}>
                      <div className="flex items-center gap-3">
                        <Avatar name={r.employeeName} size="sm" />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>
                            {r.employeeName}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--text-mute)',
                              fontFamily: 'var(--font-mono)',
                            }}
                          >
                            {r.employeeCode}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <div className="flex flex-wrap gap-1.5">
                        <Pill tone={pill.tone} dot={pill.tone === 'green' || pill.tone === 'yellow'}>
                          {pill.label}
                        </Pill>
                        {r.isLate && (
                          <Pill tone="coral">Late</Pill>
                        )}
                      </div>
                    </td>
                    <td style={td}>
                      <span className="inline-flex items-center gap-1.5">
                        {r.workMode === 'remote' ? (
                          <Icon.home size={12} style={{ color: 'var(--blue)' }} />
                        ) : r.recordId && r.locationName ? (
                          <Icon.pin size={12} style={{ color: 'var(--text-mute)' }} />
                        ) : null}
                        {locationLabel(r)}
                      </span>
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>
                      {fmtTime(r.firstPunchInAt)}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>
                      {fmtTime(r.lastPunchOutAt)}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                      {fmtWorked(r.totalWorkedMinutes)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
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
  padding: '12px 14px',
  fontSize: 12.5,
  color: 'var(--text-2)',
}
