'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import {
  Btn,
  Icon,
  Kpi,
  Pill,
  type PillTone,
  SectionHead,
} from '@/components/proto'
import {
  useBreakEnd,
  useBreakStart,
  useMyAttendanceRange,
  useMyAttendanceToday,
  usePunchIn,
  usePunchOut,
  useRequestRegularization,
  type AttendanceRecord,
  type RegularizationType,
  type TodayAttendance,
} from '@/lib/api/queries/use-attendance'

// ─── Helpers ───────────────────────────────────────────────────────────────

function startOfMonth(date = new Date()): string {
  const d = new Date(date)
  d.setUTCDate(1)
  return d.toISOString().slice(0, 10)
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
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })
}
function todayEyebrow(): string {
  return `Today · ${new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`
}

/** Live worked minutes including the in-flight session (stops when on break or clocked out). */
function liveWorkedMinutes(t: TodayAttendance, serverNowMs: number, clientNowMs: number): number {
  const stored = t.totalWorkedMinutes ?? 0
  if (!t.firstPunchInAt || t.lastPunchOutAt) return stored
  if (t.isOnBreak) return stored
  const startMs = new Date(t.firstPunchInAt).getTime()
  // The stored value already accounts for completed in/out cycles + break offsets;
  // for the simple single-session case (no break splits), drift = now - first_in.
  // We approximate: stored represents minutes already accounted; add elapsed since
  // the latest activity. Simplest stable approximation: now - firstPunchInAt - breaks.
  const offset = clientNowMs - serverNowMs
  const nowAdjusted = clientNowMs - offset
  const elapsed = Math.max(0, Math.floor((nowAdjusted - startMs) / 60_000)) - (t.totalBreakMinutes ?? 0)
  return Math.max(stored, elapsed)
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const [regOpen, setRegOpen] = useState(false)
  const today = useMyAttendanceToday()
  const range = useMyAttendanceRange({
    fromDate: startOfMonth(),
    toDate: todayISO(),
    limit: 31,
  })

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          eyebrow={todayEyebrow()}
          title="Attendance"
          sub="Clock in once when you start, clock out when you're done."
          right={
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.cal size={13} />}
              onClick={() => setRegOpen(true)}
            >
              Request regularization
            </Btn>
          }
        />

        {/* Row 1: Clock card + timeline */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.1fr 1fr',
            gap: 18,
            marginBottom: 24,
          }}
        >
          <ClockCard data={today.data} isLoading={today.isLoading} />
          <TimelineCard data={today.data} />
        </div>

        {/* Month KPIs */}
        <SectionHead
          title={new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          sub={
            range.data
              ? `Month-to-date · ${range.data.data.length} day${range.data.data.length === 1 ? '' : 's'} logged`
              : 'Loading…'
          }
        />

        <MonthKpis records={range.data?.data ?? []} />

        {/* Daily log */}
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
            <div className="t-h3" style={{ fontSize: 15 }}>
              Daily log
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', letterSpacing: '.04em', textTransform: 'uppercase' }}>
              This month
            </div>
          </div>
          {range.isLoading ? (
            <div
              style={{
                padding: '48px',
                textAlign: 'center',
                color: 'var(--text-mute)',
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : !range.data || range.data.data.length === 0 ? (
            <div
              style={{
                padding: '48px',
                textAlign: 'center',
                color: 'var(--text-mute)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              No attendance records yet. Clock in above to start tracking.
            </div>
          ) : (
            <DailyLogTable rows={range.data.data} />
          )}
        </div>
      </div>

      <RegularizationDialog open={regOpen} onOpenChange={setRegOpen} />
    </div>
  )
}

// ─── Clock card ────────────────────────────────────────────────────────────

function ClockCard({ data, isLoading }: { data: TodayAttendance | undefined; isLoading: boolean }) {
  const punchIn = usePunchIn()
  const punchOut = usePunchOut()
  const breakStart = useBreakStart()
  const breakEnd = useBreakEnd()
  const { toast } = useToast()

  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // Force re-render once a second for the live timer / clock display
  void tick

  const serverNowMs = data?.now ? new Date(data.now).getTime() : Date.now()
  const clientNowMs = Date.now()
  const workedMin = data ? liveWorkedMinutes(data, serverNowMs, clientNowMs) : 0

  const isClockedIn = !!data?.firstPunchInAt && !data.lastPunchOutAt
  const isOnBreak = !!data?.isOnBreak
  const tz = data?.shift?.timezone ?? 'Asia/Kolkata'
  const nowStr = new Date().toLocaleTimeString('en-IN', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const handlePunch = async () => {
    try {
      if (isClockedIn) {
        await punchOut.mutateAsync({})
        toast({ title: 'Clocked out', description: 'See you tomorrow.' })
      } else {
        await punchIn.mutateAsync({})
        toast({ title: 'Clocked in', description: 'Have a productive day.' })
      }
    } catch (e) {
      toast({
        title: 'Could not record punch',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handleBreak = async () => {
    try {
      if (isOnBreak) {
        await breakEnd.mutateAsync()
        toast({ title: 'Break ended' })
      } else {
        await breakStart.mutateAsync()
        toast({ title: 'Break started' })
      }
    } catch (e) {
      toast({
        title: 'Could not record break',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const statusTone: PillTone = isOnBreak ? 'yellow' : isClockedIn ? 'green' : 'yellow'
  const statusLabel = isOnBreak ? 'On break' : isClockedIn ? 'Clocked in' : 'Not clocked in'

  const shiftLabel = data?.shift
    ? `Working hours · ${data.shift.startTime}–${data.shift.endTime} ${data.shift.timezone.split('/')[1] ?? ''}`
    : 'Working hours · —'

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', position: 'relative' }}>
      <div
        className="glow glow-blue"
        style={{ top: -100, right: -100, width: 300, height: 300, opacity: 0.4 }}
      />
      <div style={{ padding: '28px 28px 24px', position: 'relative' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 20,
          }}
        >
          <div>
            <div className="t-caption" style={{ marginBottom: 6 }}>
              {shiftLabel}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Pill tone={statusTone} dot>
                {statusLabel}
              </Pill>
              {data?.isLate && data.lateByMinutes > 0 && (
                <Pill tone="coral">Late by {data.lateByMinutes}m</Pill>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--text-mute)',
                letterSpacing: '.04em',
                textTransform: 'uppercase',
              }}
            >
              Now
            </div>
            <div
              style={{
                fontSize: 32,
                fontWeight: 800,
                letterSpacing: '-0.03em',
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {nowStr}
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 18,
            padding: '18px',
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            borderRadius: 14,
            marginBottom: 18,
          }}
        >
          <ClockStat label="Clocked in" value={fmtClock(data?.firstPunchInAt, tz)} sub={isClockedIn ? 'Active' : '—'} tone="green" />
          <Sep />
          <ClockStat label="Clocked out" value={fmtClock(data?.lastPunchOutAt, tz)} sub={isClockedIn ? 'Pending' : '—'} tone="dim" />
          <Sep />
          <ClockStat
            label="Hours so far"
            value={fmtHM(workedMin)}
            sub={data?.shift ? `Of ~${shiftDurationHrs(data.shift)}h target` : '—'}
            tone="blue"
          />
          <Sep />
          <ClockStat
            label="Break time"
            value={fmtHM(data?.totalBreakMinutes ?? 0)}
            sub={isOnBreak ? 'On break' : '—'}
            tone="dim"
          />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <Btn
            kind={isClockedIn ? 'danger' : 'primary'}
            icon={<Icon.fingerprint size={16} />}
            onClick={handlePunch}
            disabled={punchIn.isPending || punchOut.isPending || isLoading}
            style={{ flex: 1, justifyContent: 'center', height: 52, fontSize: 15 }}
          >
            {isClockedIn ? 'Clock out' : 'Clock in'}
          </Btn>
          <Btn
            kind="secondary"
            icon={<Icon.coffee size={14} />}
            onClick={handleBreak}
            disabled={!isClockedIn || breakStart.isPending || breakEnd.isPending}
            style={{ height: 52 }}
          >
            {isOnBreak ? 'End break' : 'Break'}
          </Btn>
        </div>

        {data?.shift && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginTop: 14,
              padding: '10px 12px',
              background: 'rgba(62,123,250,.06)',
              border: '1px solid rgba(62,123,250,.2)',
              borderRadius: 8,
            }}
          >
            <Icon.clock size={14} style={{ color: 'var(--blue)', marginTop: 1, flexShrink: 0 }} />
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)' }}>
              Shift: {data.shift.name} · Grace period {data.shift.gracePeriodMinutes} min ·{' '}
              {data.isWorkingDay ? 'Working day' : 'Non-working day'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ClockStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone: 'green' | 'blue' | 'dim'
}) {
  const colors = { green: 'var(--green)', blue: 'var(--blue)', dim: 'var(--text-mute)' } as const
  return (
    <div style={{ flex: 1 }}>
      <div className="t-caption" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          fontFamily: 'var(--font-mono)',
          color: colors[tone],
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
        {sub}
      </div>
    </div>
  )
}

function Sep() {
  return <div style={{ width: 1, background: 'var(--bord)' }} />
}

function shiftDurationHrs(s: TodayAttendance['shift']): number {
  const [sh, sm] = s.startTime.split(':').map(Number)
  const [eh, em] = s.endTime.split(':').map(Number)
  return Math.round((eh! * 60 + em! - sh! * 60 - sm!) / 60)
}

// ─── Timeline card ─────────────────────────────────────────────────────────

function TimelineCard({ data }: { data: TodayAttendance | undefined }) {
  const tz = data?.shift?.timezone ?? 'Asia/Kolkata'
  type Tick = { t: string; l: string; d: string; c: string; pulse?: boolean }
  const items: Tick[] = []
  if (data?.firstPunchInAt) {
    items.push({
      t: fmtClock(data.firstPunchInAt, tz),
      l: 'Clocked in',
      d: data.isLate ? `Late by ${data.lateByMinutes}m` : 'On time',
      c: 'var(--green)',
    })
  }
  if (data?.isOnBreak) {
    items.push({
      t: 'now',
      l: 'On break',
      d: `${data.totalBreakMinutes} min so far`,
      c: 'var(--yellow)',
      pulse: true,
    })
  } else if ((data?.totalBreakMinutes ?? 0) > 0) {
    items.push({
      t: '—',
      l: 'Break taken',
      d: `${data!.totalBreakMinutes} min total`,
      c: 'var(--yellow)',
    })
  }
  if (data?.lastPunchOutAt) {
    items.push({
      t: fmtClock(data.lastPunchOutAt, tz),
      l: 'Clocked out',
      d: `${fmtHM(data.totalWorkedMinutes)} worked`,
      c: 'var(--blue)',
    })
  } else if (data?.firstPunchInAt && !data.isOnBreak) {
    items.push({
      t: 'now',
      l: 'Currently working',
      d: `${fmtHM(data.totalWorkedMinutes)} logged`,
      c: 'var(--blue)',
      pulse: true,
    })
  }

  return (
    <div className="card">
      <div className="t-h3" style={{ marginBottom: 16 }}>
        Today's timeline
      </div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-mute)', fontSize: 13, fontWeight: 600, padding: '12px 0' }}>
          {data ? 'Not clocked in yet today.' : 'Loading…'}
        </div>
      ) : (
        <div style={{ position: 'relative', paddingLeft: 18 }}>
          <div
            style={{
              position: 'absolute',
              left: 5,
              top: 6,
              bottom: 6,
              width: 1.5,
              background: 'var(--bord-2)',
            }}
          />
          {items.map((it, i) => (
            <div key={i} style={{ position: 'relative', paddingBottom: 14 }}>
              <div
                style={{
                  position: 'absolute',
                  left: -18,
                  top: 2,
                  width: 11,
                  height: 11,
                  borderRadius: '50%',
                  background: 'var(--bg-2)',
                  border: `2px solid ${it.c}`,
                  boxShadow: it.pulse ? `0 0 0 4px ${it.c}33` : 'none',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  marginBottom: 1,
                }}
              >
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 800,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {it.t}
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{it.l}</span>
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                {it.d}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Month KPIs ────────────────────────────────────────────────────────────

function MonthKpis({ records }: { records: AttendanceRecord[] }) {
  const stats = useMemo(() => {
    let present = 0
    let totalWorked = 0
    let workedDays = 0
    let lateCount = 0
    let otMin = 0
    for (const r of records) {
      if (r.attendanceStatus === 'present' || r.attendanceStatus === 'late') {
        present += 1
      }
      if (r.totalWorkedMinutes > 0) {
        totalWorked += r.totalWorkedMinutes
        workedDays += 1
      }
      if (r.isLate) lateCount += 1
      // Overtime = worked minutes beyond 9*60 per day
      if (r.totalWorkedMinutes > 540) {
        otMin += r.totalWorkedMinutes - 540
      }
    }
    const avg = workedDays > 0 ? Math.round(totalWorked / workedDays) : 0
    return { present, avg, lateCount, otMin }
  }, [records])

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 14,
        marginBottom: 18,
      }}
    >
      <Kpi
        label="Days present"
        value={stats.present}
        delta={records.length > 0 ? `${Math.round((stats.present / records.filter(r => r.attendanceStatus !== 'weekend' && r.attendanceStatus !== 'holiday').length || 1) * 100)}% of working days` : '—'}
        icon={<Icon.check size={16} />}
        accent="green"
      />
      <Kpi
        label="Avg hours / day"
        value={fmtHM(stats.avg)}
        delta={stats.avg ? 'On worked days' : '—'}
        icon={<Icon.clock size={16} />}
        accent="blue"
      />
      <Kpi
        label="Late arrivals"
        value={stats.lateCount}
        delta={stats.lateCount > 0 ? 'This month' : 'None'}
        icon={<Icon.warn size={16} />}
        accent="yellow"
      />
      <Kpi
        label="Overtime"
        value={fmtHM(stats.otMin)}
        delta={stats.otMin > 0 ? 'Beyond 9h/day' : '—'}
        icon={<Icon.spark size={16} />}
        accent="purple"
      />
    </div>
  )
}

// ─── Daily log table ───────────────────────────────────────────────────────

function statusPill(s: AttendanceRecord['attendanceStatus']) {
  switch (s) {
    case 'present': return <Pill tone="green" dot>Present</Pill>
    case 'late':    return <Pill tone="yellow" dot>Late</Pill>
    case 'absent':  return <Pill tone="coral" dot>Absent</Pill>
    case 'on_leave': return <Pill tone="purple" dot>Leave</Pill>
    case 'holiday': return <Pill tone="coral">Holiday</Pill>
    case 'weekend': return <Pill>Weekend</Pill>
    case 'work_from_home': return <Pill tone="blue" dot>WFH</Pill>
    case 'half_day': return <Pill tone="yellow">Half day</Pill>
    default:        return <Pill>{s}</Pill>
  }
}

function DailyLogTable({ rows }: { rows: AttendanceRecord[] }) {
  return (
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
          <th />
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
              {statusPill(r.attendanceStatus)}
              {r.isRegularized && (
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 800, color: 'var(--yellow)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                  · regularized
                </span>
              )}
            </td>
            <td style={{ textAlign: 'right' }}>
              {(r.attendanceStatus === 'late' || r.attendanceStatus === 'absent') && (
                <Btn kind="ghost" size="sm">
                  Regularize
                </Btn>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─── Regularization dialog ─────────────────────────────────────────────────

const REG_TYPES: Array<{ value: RegularizationType; label: string }> = [
  { value: 'missing_punch', label: 'Forgot to clock in/out' },
  { value: 'wrong_time', label: 'Wrong punch time' },
  { value: 'wfh_request', label: 'Work from home' },
  { value: 'on_duty', label: 'On duty (offsite)' },
  { value: 'manual_override', label: 'Other manual override' },
]

function RegularizationDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const submit = useRequestRegularization()
  const { toast } = useToast()
  const [attendanceDate, setAttendanceDate] = useState('')
  const [requestType, setRequestType] = useState<RegularizationType>('missing_punch')
  const [proposedInTime, setProposedInTime] = useState('')
  const [proposedOutTime, setProposedOutTime] = useState('')
  const [reason, setReason] = useState('')

  const reset = () => {
    setAttendanceDate('')
    setRequestType('missing_punch')
    setProposedInTime('')
    setProposedOutTime('')
    setReason('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!attendanceDate || reason.trim().length < 10) {
      toast({
        title: 'Please fill all required fields',
        description: 'Reason must be at least 10 characters.',
        variant: 'destructive',
      })
      return
    }
    try {
      await submit.mutateAsync({
        attendanceDate,
        requestType,
        ...(proposedInTime ? { proposedInTime: new Date(`${attendanceDate}T${proposedInTime}`).toISOString() } : {}),
        ...(proposedOutTime ? { proposedOutTime: new Date(`${attendanceDate}T${proposedOutTime}`).toISOString() } : {}),
        reason,
      })
      toast({ title: 'Regularization submitted', description: 'Your manager has been notified.' })
      reset()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: 'Could not submit',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request attendance regularization</DialogTitle>
          <DialogDescription>
            Fix a missed punch, log work-from-home, or correct a clock time. Manager approval required.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reg-date">Date</Label>
            <Input
              id="reg-date"
              type="date"
              value={attendanceDate}
              onChange={(e) => setAttendanceDate(e.target.value)}
              max={todayISO()}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-type">Type</Label>
            <Select value={requestType} onValueChange={(v) => setRequestType(v as RegularizationType)}>
              <SelectTrigger id="reg-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REG_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="reg-in">Proposed in</Label>
              <Input id="reg-in" type="time" value={proposedInTime} onChange={(e) => setProposedInTime(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reg-out">Proposed out</Label>
              <Input id="reg-out" type="time" value={proposedOutTime} onChange={(e) => setProposedOutTime(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-reason">
              Reason <span className="text-white/40 text-xs">(min 10 characters)</span>
            </Label>
            <Textarea
              id="reg-reason"
              placeholder="What happened?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              minLength={10}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenChange(false)} disabled={submit.isPending}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={submit.isPending}>
              {submit.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Submitting…
                </>
              ) : (
                'Submit request'
              )}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
