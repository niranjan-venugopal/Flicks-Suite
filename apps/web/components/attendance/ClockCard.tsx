'use client'

import { useEffect, useState } from 'react'
import { Btn, Icon, Modal, Pill, type PillTone } from '@/components/proto'
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

/**
 * Best-effort browser position. Resolves null on denial/timeout/unsupported —
 * a punch must always go through even when location fails (PRD §6.4).
 */
function getPosition(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null)
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
    )
  })
}

/** Haversine distance in metres — client-side pre-check only; the server recomputes. */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** "12.9352° N, 77.6245° E" */
function fmtCoords(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`
}

interface OutsideFence {
  lat: number
  lng: number
  accuracy: number | null
  distanceM: number
  radiusM: number
  locationName: string
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

  // Geofence pre-check state: set when a clock-in position lands outside the
  // configured office fence — the "You're not at the office" dialog takes over.
  const [outside, setOutside] = useState<OutsideFence | null>(null)
  const [locating, setLocating] = useState(false)

  const doPunch = async (coords: { lat?: number; lng?: number; accuracy?: number }) => {
    try {
      if (isClockedIn) {
        await punchOut.mutateAsync(coords)
        toast({ title: 'Clocked out', description: 'See you tomorrow.' })
      } else {
        const res = await punchIn.mutateAsync(coords)
        toast({
          title: res.workMode === 'remote' ? 'Clocked in — WFH' : 'Clocked in',
          description:
            res.workMode === 'remote'
              ? `Outside the ${res.locationName ?? 'office'} geofence — marked as working from home today.`
              : 'Have a productive day.',
        })
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

  const handlePunch = async () => {
    if (dayComplete) {
      toast({
        title: 'Day already complete',
        description: "You've already clocked out for today. See you tomorrow!",
      })
      return
    }
    // Capture position best-effort; denial/timeout still punches (no coords).
    setLocating(true)
    const pos = await getPosition()
    setLocating(false)
    const coords = pos
      ? {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        }
      : {}
    // Clock-IN only: when the office has a geofence and we're outside it, ask
    // before punching — Mark as WFH / Try again / Cancel. The server stays
    // authoritative; this is a courtesy stop, never a hard block.
    const fence = data?.location
    if (
      !isClockedIn &&
      pos &&
      fence &&
      fence.geofenceLat !== null &&
      fence.geofenceLng !== null &&
      fence.geofenceRadiusM !== null
    ) {
      const distanceM = haversineM(
        coords.lat!,
        coords.lng!,
        fence.geofenceLat,
        fence.geofenceLng,
      )
      if (distanceM > fence.geofenceRadiusM) {
        setOutside({
          lat: coords.lat!,
          lng: coords.lng!,
          accuracy: coords.accuracy ?? null,
          distanceM: Math.round(distanceM),
          radiusM: fence.geofenceRadiusM,
          locationName: fence.name ?? 'the office',
        })
        return
      }
    }
    await doPunch(coords)
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
          {/* Check-in/out MORPH (catalog): one button that IS the state —
              clocked-in renders the green pill with a pulsing dot and the
              live worked time, popping in place (140ms). Never two buttons. */}
          {isClockedIn && !dayComplete ? (
            <button
              type="button"
              onClick={handlePunch}
              disabled={punchOut.isPending || locating}
              className="pm-pop"
              key="out"
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                height: 52, borderRadius: 10, cursor: 'pointer',
                background: 'rgba(39,210,128,.1)', border: '1px solid rgba(39,210,128,.45)',
                opacity: punchOut.isPending || locating ? 0.6 : 1,
              }}
            >
              <span className="pm-pending" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)' }} />
              <span style={{ fontSize: 15, fontWeight: 800, color: '#fff', fontFamily: 'var(--font-mono)' }}>
                {fmtHM(workedMin)}
              </span>
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--green)' }}>Clock out</span>
            </button>
          ) : (
            <Btn
              kind={dayComplete ? 'secondary' : 'primary'}
              icon={<Icon.fingerprint size={16} />}
              onClick={handlePunch}
              disabled={
                dayComplete ||
                punchIn.isPending ||
                punchOut.isPending ||
                locating ||
                today.isLoading
              }
              className="pm-pop"
              style={{ flex: 1, justifyContent: 'center', height: 52, fontSize: 15 }}
            >
              {dayComplete
                ? 'Day complete · see you tomorrow'
                : locating
                  ? 'Getting your location…'
                  : 'Clock in'}
            </Btn>
          )}
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

        {/* Geofence strip — the clock-in position vs the assigned office. */}
        {data?.lastPunchGeo && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginTop: 8,
              padding: '10px 12px',
              background:
                data.lastPunchGeo.isWithinGeofence === false
                  ? 'rgba(255,184,74,.07)'
                  : 'rgba(39,210,128,.06)',
              border:
                data.lastPunchGeo.isWithinGeofence === false
                  ? '1px solid rgba(255,184,74,.25)'
                  : '1px solid rgba(39,210,128,.22)',
              borderRadius: 8,
            }}
          >
            <Icon.pin
              size={14}
              style={{
                color:
                  data.lastPunchGeo.isWithinGeofence === false
                    ? 'var(--yellow)'
                    : 'var(--green)',
                marginTop: 1,
                flexShrink: 0,
              }}
            />
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)' }}>
              {data.lastPunchGeo.isWithinGeofence === true
                ? `Inside ${data.location?.name ?? 'office'} geofence`
                : data.lastPunchGeo.isWithinGeofence === false
                  ? `Outside ${data.location?.name ?? 'office'} geofence — working from home`
                  : 'Location recorded'}
              {' · '}
              {fmtCoords(data.lastPunchGeo.lat, data.lastPunchGeo.lng)}
              {data.lastPunchGeo.accuracyM !== null &&
                ` · ±${Math.round(data.lastPunchGeo.accuracyM)}m`}
            </div>
          </div>
        )}
      </div>

      {/* "You're not at the office" — geofence pre-check on clock-in. */}
      <Modal
        open={!!outside}
        onClose={() => setOutside(null)}
        title="You're not at the office"
        sub={
          outside
            ? `Your current position is outside the ${outside.locationName} geofence.`
            : undefined
        }
        width={440}
        footer={
          <>
            <Btn kind="ghost" onClick={() => setOutside(null)}>
              Cancel
            </Btn>
            <Btn
              kind="secondary"
              onClick={() => {
                setOutside(null)
                void handlePunch()
              }}
            >
              Try again
            </Btn>
            <Btn
              kind="primary"
              icon={<Icon.home size={14} />}
              disabled={punchIn.isPending}
              onClick={async () => {
                const o = outside!
                setOutside(null)
                await doPunch({
                  lat: o.lat,
                  lng: o.lng,
                  accuracy: o.accuracy ?? undefined,
                })
              }}
            >
              Mark as WFH today
            </Btn>
          </>
        }
      >
        {outside && (
          <div style={{ display: 'grid', gap: 10 }}>
            {(
              [
                ['Detected at', fmtCoords(outside.lat, outside.lng)],
                ['Accuracy', outside.accuracy !== null ? `±${outside.accuracy}m` : 'Unknown'],
                ['Geofence radius', `${outside.radiusM}m around ${outside.locationName}`],
                ['Distance', `${outside.distanceM >= 1000 ? `${(outside.distanceM / 1000).toFixed(1)} km` : `${outside.distanceM}m`} from the office`],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '9px 12px',
                  background: 'var(--surf-1)',
                  border: '1px solid var(--bord)',
                  borderRadius: 8,
                }}
              >
                <span className="t-caption">{label}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {value}
                </span>
              </div>
            ))}
            <div style={{ fontSize: 11.5, color: 'var(--text-mute)', fontWeight: 600 }}>
              Marking WFH clocks you in normally and shows today as working from
              home on your team&apos;s attendance.
            </div>
          </div>
        )}
      </Modal>
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
