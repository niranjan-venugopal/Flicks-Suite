'use client'

import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { Icon, Kpi, Pill, type PillTone } from '@/components/proto'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { useTeamToday, type TeamMemberToday } from '@/lib/api/queries/use-attendance'
import { usePresence } from '@/lib/api/queries/use-presence'
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

function holidayLabel(t: TeamMemberToday): string {
  return t.holidayName ? `Holiday · ${t.holidayName}` : 'Holiday'
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
  // Round L (founder item 1): no record ≠ missed punch. The API says what
  // the day IS — on approved leave, a holiday, the shift's weekend, a pending
  // request — before anyone is called "yet to clock in".
  if (!t.attendanceStatus) {
    switch (t.derivedStatus) {
      case 'on_leave': return { tone: 'purple', label: 'On leave' }
      case 'holiday':  return { tone: '',       label: holidayLabel(t) }
      case 'weekend':  return { tone: '',       label: 'Weekend' }
      default: break
    }
    if (t.dayKind === 'half_day_leave') return { tone: 'yellow', label: 'Half-day leave' }
    if (t.pendingLeave) return { tone: 'yellow', label: 'Leave pending' }
    if (t.expected === false) return { tone: '', label: 'Not expected' }
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
    case 'holiday':         return { tone: '',       label: holidayLabel(t) }
    case 'weekend':         return { tone: '',       label: 'Weekend' }
    default:                return { tone: '',       label: t.attendanceStatus }
  }
}

/** Secondary chip next to the status — the leave type / session. */
function leaveHint(t: TeamMemberToday): string | null {
  if (!t.leave) return null
  const type = t.leave.leaveTypeName ?? 'Leave'
  if (t.leave.isHalfDay) {
    const session =
      t.leave.session === 'first_half' ? 'first half' : t.leave.session === 'second_half' ? 'second half' : 'half day'
    return `${type} · ${session}`
  }
  return type
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

  // Seed the presence batch for the faces on screen; the socket keeps the
  // dots live from there (mirrors the Team page).
  usePresence(
    useMemo(
      () => rows.map((r) => r.employeeUserId).filter((id): id is string => !!id),
      [rows],
    ),
  )

  const kpis = useMemo(() => {
    let inOffice = 0
    let wfh = 0
    let onLeave = 0
    let yetToClockIn = 0
    let late = 0
    for (const r of rows) {
      const s = r.attendanceStatus
      const remote = r.workMode === 'remote'
      // A half_day row from the leave backfill (no punch yet) says nothing
      // about the person being in — they are still to clock in.
      const halfDayNoPunch = s === 'half_day' && !r.firstPunchInAt
      if ((s === 'present' || s === 'on_duty' || s === 'comp_off' || s === 'half_day') && !halfDayNoPunch) {
        if (remote) wfh++
        else inOffice++
      } else if (s === 'work_from_home') wfh++
      else if (s === 'on_leave' || (!s && r.derivedStatus === 'on_leave')) onLeave++
      else if (s === 'late') {
        if (remote) wfh++
        else inOffice++
        if (r.isLate) late++
      } else if ((!s || s === 'absent' || halfDayNoPunch) && r.expected !== false) {
        // Round L: only people EXPECTED today count — never someone on
        // leave (handled above), on a holiday or on their weekend (both
        // `expected:false`). A pending request keeps them expected
        // (founder default #6); a half-day leave expects the other half.
        yetToClockIn++
      }
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
                const hint = leaveHint(r)
                return (
                  <tr
                    key={r.employeeId}
                    data-testid={`team-row-${r.employeeId}`}
                    data-status={pill.label}
                    style={{
                      borderBottom:
                        i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                    }}
                  >
                    <td style={{ padding: '12px 14px' }}>
                      <div className="flex items-center gap-3">
                        <RowPresenceAvatar
                          name={r.employeeName}
                          src={r.avatarUrl ?? null}
                          userId={r.employeeUserId ?? null}
                          size={30}
                        />
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
                        <Pill tone={pill.tone} dot={pill.tone === 'green' || pill.tone === 'yellow' || pill.tone === 'purple'}>
                          {pill.label}
                        </Pill>
                        {r.isLate && (
                          <Pill tone="coral">Late</Pill>
                        )}
                        {hint && (pill.label === 'On leave' || pill.label === 'Leave pending' || pill.label === 'Half-day leave' || r.attendanceStatus === 'half_day') && (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--text-mute)',
                              alignSelf: 'center',
                            }}
                          >
                            {hint}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={td}>
                      <span className="inline-flex items-center gap-1.5">
                        {/* The pin follows the LOCATION, not the punch — it
                            used to require a clock-in record, so "yet to
                            clock in" rows showed bare text next to iconed
                            ones (founder: design inconsistency). */}
                        {r.workMode === 'remote' ? (
                          <Icon.home size={12} style={{ color: 'var(--blue)' }} />
                        ) : r.locationName ? (
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
