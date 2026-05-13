'use client'

import { useEffect, useState } from 'react'
import { Btn, Icon, Pill, type PillTone } from '@/components/proto'
import {
  useBreakEnd,
  useBreakStart,
  useMyAttendanceToday,
  usePunchIn,
  usePunchOut,
  type TodayAttendance,
} from '@/lib/api/queries/use-attendance'
import { useToast } from '@/components/ui/use-toast'

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function liveWorkedMinutes(t: TodayAttendance, serverNowMs: number, clientNowMs: number): number {
  const stored = t.totalWorkedMinutes ?? 0
  if (!t.firstPunchInAt || t.lastPunchOutAt) return stored
  if (t.isOnBreak) return stored
  const startMs = new Date(t.firstPunchInAt).getTime()
  const offset = clientNowMs - serverNowMs
  const nowAdjusted = clientNowMs - offset
  const elapsed = Math.max(0, Math.floor((nowAdjusted - startMs) / 60_000)) - (t.totalBreakMinutes ?? 0)
  return Math.max(stored, elapsed)
}

function shiftDurationHrs(s: TodayAttendance['shift']): number {
  const [sh, sm] = s.startTime.split(':').map(Number)
  const [eh, em] = s.endTime.split(':').map(Number)
  return Math.round((eh! * 60 + em! - sh! * 60 - sm!) / 60)
}

// ─── ClockCard ─────────────────────────────────────────────────────────────

/**
 * Live clock-in card used on both the attendance page and the employee
 * dashboard. Wires to usePunchIn/Out + useBreakStart/End. Re-renders every
 * second for the live wall-clock display.
 */
export function ClockCard() {
  const today = useMyAttendanceToday()
  const punchIn = usePunchIn()
  const punchOut = usePunchOut()
  const breakStart = useBreakStart()
  const breakEnd = useBreakEnd()
  const { toast } = useToast()

  // Mount guard — Date.now() / new Date() during SSR produces a value that's
  // a second or two stale by the time React hydrates on the client, which
  // triggers a hydration-mismatch warning. Wait until after mount to render
  // anything that depends on the current wall-clock time.
  const [mounted, setMounted] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    setMounted(true)
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  void tick // force re-render every tick

  const data = today.data
  const serverNowMs = data?.now ? new Date(data.now).getTime() : Date.now()
  const clientNowMs = mounted ? Date.now() : serverNowMs
  const workedMin = data ? liveWorkedMinutes(data, serverNowMs, clientNowMs) : 0

  const isClockedIn = !!data?.firstPunchInAt && !data.lastPunchOutAt
  // Day complete = both timestamps set. The user has lived a full day and
  // cannot punch in again until tomorrow's attendance_date rolls over.
  const dayComplete = !!data?.firstPunchInAt && !!data?.lastPunchOutAt
  const isOnBreak = !!data?.isOnBreak
  const tz = data?.shift?.timezone ?? 'Asia/Kolkata'
  const nowStr = mounted
    ? new Date().toLocaleTimeString('en-IN', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '--:--:--'

  const handlePunch = async () => {
    if (dayComplete) {
      toast({
        title: 'Day already complete',
        description: "You've already clocked out for today. See you tomorrow!",
      })
      return
    }
    try {
      if (isClockedIn) {
        await punchOut.mutateAsync({})
        toast({ title: 'Clocked out', description: 'See you tomorrow.' })
      } else {
        await punchIn.mutateAsync({})
        toast({ title: 'Clocked in', description: 'Have a productive day.' })
      }
    } catch (e) {
      // The 409 from the backend carries the exact message we want to show;
      // any other failure mode falls back to a generic destructive toast.
      const msg = e instanceof Error ? e.message : 'Try again'
      const isAlreadyDone = msg.toLowerCase().includes('clocked out')
      toast({
        title: isAlreadyDone ? 'Day already complete' : 'Could not record punch',
        description: msg,
        variant: isAlreadyDone ? 'default' : 'destructive',
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

  const statusTone: PillTone = dayComplete
    ? 'green'
    : isOnBreak
      ? 'yellow'
      : isClockedIn
        ? 'green'
        : 'yellow'
  const statusLabel = dayComplete
    ? 'Day complete'
    : isOnBreak
      ? 'On break'
      : isClockedIn
        ? 'Clocked in'
        : 'Not clocked in'

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
          <Stat label="Clocked in" value={fmtClock(data?.firstPunchInAt, tz)} sub={isClockedIn ? 'Active' : '—'} tone="green" />
          <Sep />
          <Stat label="Clocked out" value={fmtClock(data?.lastPunchOutAt, tz)} sub={isClockedIn ? 'Pending' : '—'} tone="dim" />
          <Sep />
          <Stat
            label="Hours so far"
            value={fmtHM(workedMin)}
            sub={data?.shift ? `Of ~${shiftDurationHrs(data.shift)}h target` : '—'}
            tone="blue"
          />
          <Sep />
          <Stat
            label="Break time"
            value={fmtHM(data?.totalBreakMinutes ?? 0)}
            sub={isOnBreak ? 'On break' : '—'}
            tone="dim"
          />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <Btn
            kind={dayComplete ? 'secondary' : isClockedIn ? 'danger' : 'primary'}
            icon={<Icon.fingerprint size={16} />}
            onClick={handlePunch}
            disabled={
              dayComplete ||
              punchIn.isPending ||
              punchOut.isPending ||
              today.isLoading
            }
            style={{ flex: 1, justifyContent: 'center', height: 52, fontSize: 15 }}
          >
            {dayComplete
              ? 'Day complete · see you tomorrow'
              : isClockedIn
                ? 'Clock out'
                : 'Clock in'}
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

function Stat({
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
