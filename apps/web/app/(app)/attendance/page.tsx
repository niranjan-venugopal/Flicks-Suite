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
import { ClockCard } from '@/components/attendance/ClockCard'
import { DateField } from '@/components/ui/date-picker'
import { MonthNav, monthTitle } from '@/components/ui/month-nav'
import {
  Btn,
  Icon,
  Kpi,
  Pill,
  type PillTone,
  SectionHead,
} from '@/components/proto'
import {
  useMyAttendanceRange,
  useMyAttendanceToday,
  useRequestRegularization,
  type AttendanceRecord,
  type RegularizationType,
  type TodayAttendance,
} from '@/lib/api/queries/use-attendance'

// ─── Helpers ───────────────────────────────────────────────────────────────

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

// ─── Page ──────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const [regOpen, setRegOpen] = useState(false)
  const [cursor, setCursor] = useState(new Date())
  const today = useMyAttendanceToday()
  // Daily records for the browsed month, clamped so the range never runs
  // past today (the API rejects future ranges and there's nothing to show).
  const fromDate = toISODate(new Date(cursor.getFullYear(), cursor.getMonth(), 1))
  const monthEnd = toISODate(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0))
  const toDate = monthEnd < todayISO() ? monthEnd : todayISO()
  const range = useMyAttendanceRange({ fromDate, toDate, limit: 31 })

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
          <ClockCard />
          <TimelineCard data={today.data} />
        </div>

        {/* Month toolbar — title opens the month/year chooser; next stops at now */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 16px' }}>
          <MonthNav cursor={cursor} onChange={setCursor} maxMonth={new Date()} />
        </div>

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
              {monthTitle(cursor)}
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
              No attendance records for this month.
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
            <DateField
              id="reg-date"
              value={attendanceDate}
              onChange={setAttendanceDate}
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
