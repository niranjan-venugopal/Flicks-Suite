'use client'

import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Coffee, LogIn, LogOut, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  useBreakEnd,
  useBreakStart,
  useMyAttendanceToday,
  usePunchIn,
  usePunchOut,
  type TodayAttendance,
} from '@/lib/api/queries/use-attendance'

function formatHM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${h}h ${m.toString().padStart(2, '0')}m`
}

function formatTime(iso: string | null, tz: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  })
}

/**
 * Computes the effective worked minutes including the in-flight session
 * (i.e. add the time since `firstPunchInAt` if currently clocked in but not
 * on break and not yet clocked out).
 *
 * Server's stored `total_worked_minutes` is recomputed only on punch-out, so
 * we extrapolate live for the timer.
 */
function liveWorkedMinutes(
  data: TodayAttendance,
  serverNowMs: number,
  clientNowMs: number,
): number {
  const stored = data.totalWorkedMinutes ?? 0
  // If there's no firstPunchInAt or already punched out, just show stored.
  if (!data.firstPunchInAt || data.lastPunchOutAt) return stored

  // If on break, the timer pauses
  if (data.isOnBreak) return stored

  // If we've never punched out, compute time since firstPunchInAt minus
  // stored break minutes.
  const skewMs = clientNowMs - serverNowMs
  const nowMs = clientNowMs - skewMs // server-anchored "now"
  const elapsedMin = Math.max(
    0,
    Math.floor((nowMs - new Date(data.firstPunchInAt).getTime()) / 60_000),
  )
  return Math.max(0, elapsedMin - (data.totalBreakMinutes ?? 0))
}

export function ClockInCard({ compact = false }: { compact?: boolean }) {
  const today = useMyAttendanceToday()
  const punchIn = usePunchIn()
  const punchOut = usePunchOut()
  const breakStart = useBreakStart()
  const breakEnd = useBreakEnd()
  const { toast } = useToast()

  // Re-render every 30s for the live timer
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const data = today.data
  const isClockedIn = !!data?.firstPunchInAt && !data?.lastPunchOutAt
  const isClockedOut = !!data?.lastPunchOutAt
  const isOnBreak = !!data?.isOnBreak

  const tz = data?.shift?.timezone ?? 'Asia/Kolkata'

  const liveMin = useMemo(() => {
    if (!data) return 0
    return liveWorkedMinutes(data, new Date(data.now).getTime(), Date.now())
    // tick included so this re-runs on the timer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tick])

  // Geolocation is best-effort: don't block the punch
  const collectGeo = (): Promise<{
    lat?: number
    lng?: number
    accuracy?: number
  }> =>
    new Promise((resolve) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation)
        return resolve({})
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          }),
        () => resolve({}),
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60_000 },
      )
    })

  const handlePunchIn = async () => {
    try {
      const geo = await collectGeo()
      await punchIn.mutateAsync(geo)
      toast({
        title: "You're clocked in",
        description: 'Have a productive day.',
      })
    } catch (err) {
      toast({
        title: 'Clock-in failed',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handlePunchOut = async () => {
    try {
      const geo = await collectGeo()
      const res = await punchOut.mutateAsync(geo)
      toast({
        title: 'Clocked out',
        description: `${formatHM(res.totalWorkedMinutes)} logged today.`,
      })
    } catch (err) {
      toast({
        title: 'Clock-out failed',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handleBreakToggle = async () => {
    try {
      if (isOnBreak) await breakEnd.mutateAsync()
      else await breakStart.mutateAsync()
    } catch (err) {
      toast({
        title: isOnBreak ? 'Could not end break' : 'Could not start break',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  if (today.isLoading || !data) {
    return (
      <div className="glass rounded-xl p-6 flex items-center gap-3 text-white/40">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading attendance…
      </div>
    )
  }

  const busy =
    punchIn.isPending ||
    punchOut.isPending ||
    breakStart.isPending ||
    breakEnd.isPending

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass rounded-xl ${compact ? 'p-4' : 'p-6'} flex items-center justify-between gap-6 flex-wrap`}
    >
      <div className="flex-1 min-w-[240px]">
        <div className="text-xs uppercase tracking-wider text-white/40 font-gilroy">
          {!data.isWorkingDay
            ? 'Off day'
            : isClockedOut
              ? 'Wrapped up'
              : isOnBreak
                ? 'On break'
                : isClockedIn
                  ? 'Clocked in'
                  : 'Ready to start'}
        </div>
        <div
          className={`font-bold text-white font-gilroy mt-1 ${
            compact ? 'text-2xl' : 'text-3xl'
          }`}
        >
          {isClockedIn || isClockedOut ? formatHM(liveMin) : '0h 00m'}
        </div>
        <div className="text-sm text-brand-muted mt-1">
          {isClockedOut
            ? `Out ${formatTime(data.lastPunchOutAt, tz)} · in ${formatTime(data.firstPunchInAt, tz)}`
            : isClockedIn
              ? `In ${formatTime(data.firstPunchInAt, tz)} · ${data.shift.name} ${data.shift.startTime}–${data.shift.endTime}`
              : `${data.shift.name} · ${data.shift.startTime}–${data.shift.endTime} ${tz.replace('Asia/', '')}`}
        </div>
        {data.isLate && !compact && (
          <div className="mt-2 text-xs text-amber-300/80 font-gilroy inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Late by {data.lateByMinutes}m
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {isClockedIn && !isClockedOut && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={handleBreakToggle}
            className="text-white/70"
          >
            <Coffee className="w-4 h-4" />
            {isOnBreak ? 'End break' : 'Take a break'}
          </Button>
        )}
        {!isClockedIn && !isClockedOut && (
          <Button
            size={compact ? 'default' : 'xl'}
            onClick={handlePunchIn}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <LogIn className="w-5 h-5" />
            )}
            Clock in
          </Button>
        )}
        {isClockedIn && (
          <Button
            size={compact ? 'default' : 'xl'}
            variant="destructive"
            onClick={handlePunchOut}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <LogOut className="w-5 h-5" />
            )}
            Clock out
          </Button>
        )}
        {isClockedOut && (
          <span className="text-sm text-emerald-400 font-gilroy">Done for the day</span>
        )}
      </div>
    </motion.div>
  )
}
