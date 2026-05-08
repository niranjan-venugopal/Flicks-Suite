'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Calendar, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useToast } from '@/components/ui/use-toast'
import { ClockInCard } from '@/components/attendance/ClockInCard'
import {
  useMyAttendanceRange,
  useRequestRegularization,
  type AttendanceRecord,
  type RegularizationType,
} from '@/lib/api/queries/use-attendance'

function startOfMonth(date = new Date()): string {
  const d = new Date(date)
  d.setUTCDate(1)
  return d.toISOString().slice(0, 10)
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatHM(totalMinutes: number): string {
  if (!totalMinutes) return '—'
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${h}h ${m.toString().padStart(2, '0')}m`
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

export default function AttendancePage() {
  const [regOpen, setRegOpen] = useState(false)
  const range = useMyAttendanceRange({
    fromDate: startOfMonth(),
    toDate: todayISO(),
    limit: 31,
  })

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start justify-between gap-4 mb-8 flex-wrap"
        >
          <div>
            <h1 className="text-3xl font-bold text-white font-gilroy">
              Attendance
            </h1>
            <p className="text-brand-muted mt-1">
              Track your work day and review recent activity
            </p>
          </div>
          <Button variant="ghost" onClick={() => setRegOpen(true)}>
            <Plus className="w-4 h-4" />
            Request regularization
          </Button>
        </motion.div>

        {/* Hero clock-in card */}
        <ClockInCard />

        {/* Recent days table */}
        <div className="glass rounded-xl overflow-hidden mt-6">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h2 className="text-sm font-semibold text-white font-gilroy">
              This month
            </h2>
          </div>
          {range.isLoading ? (
            <div className="px-6 py-12 flex items-center justify-center text-white/40">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading…
            </div>
          ) : !range.data || range.data.data.length === 0 ? (
            <EmptyState
              icon={Calendar}
              title="No attendance records yet"
              description="Clock in above to start tracking. Your history will appear here."
            />
          ) : (
            <RecentTable rows={range.data.data} />
          )}
        </div>
      </div>

      <RegularizationDialog open={regOpen} onOpenChange={setRegOpen} />
    </div>
  )
}

function RecentTable({ rows }: { rows: AttendanceRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/[0.06] text-left">
            {['Date', 'In', 'Out', 'Worked', 'Break', 'Status'].map((h) => (
              <th
                key={h}
                className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
            >
              <td className="px-6 py-4 text-sm text-white font-gilroy">
                {formatDate(r.attendanceDate)}
                {r.isRegularized && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-300/80">
                    regularized
                  </span>
                )}
              </td>
              <td className="px-6 py-4 text-sm text-white/70 font-gilroy">
                {formatTime(r.firstPunchInAt)}
              </td>
              <td className="px-6 py-4 text-sm text-white/70 font-gilroy">
                {formatTime(r.lastPunchOutAt)}
              </td>
              <td className="px-6 py-4 text-sm text-white/70 font-gilroy">
                {formatHM(r.totalWorkedMinutes)}
              </td>
              <td className="px-6 py-4 text-sm text-white/70 font-gilroy">
                {formatHM(r.totalBreakMinutes)}
              </td>
              <td className="px-6 py-4">
                <StatusBadge status={r.attendanceStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const REG_TYPES: Array<{ value: RegularizationType; label: string }> = [
  { value: 'missing_punch', label: 'Forgot to clock in/out' },
  { value: 'wrong_time', label: 'Wrong punch time' },
  { value: 'wfh_request', label: 'Work from home' },
  { value: 'on_duty', label: 'On duty (offsite work)' },
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
  const [requestType, setRequestType] =
    useState<RegularizationType>('missing_punch')
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
        ...(proposedInTime
          ? { proposedInTime: new Date(`${attendanceDate}T${proposedInTime}`).toISOString() }
          : {}),
        ...(proposedOutTime
          ? { proposedOutTime: new Date(`${attendanceDate}T${proposedOutTime}`).toISOString() }
          : {}),
        reason,
      })
      toast({
        title: 'Regularization submitted',
        description: 'Your manager has been notified.',
      })
      reset()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: 'Could not submit',
        description: err instanceof Error ? err.message : 'Please try again',
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
            Use this to fix a missed punch, log work-from-home, or correct a
            wrong clock time. Manager approval required.
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
            <Select
              value={requestType}
              onValueChange={(v) => setRequestType(v as RegularizationType)}
            >
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
              <Input
                id="reg-in"
                type="time"
                value={proposedInTime}
                onChange={(e) => setProposedInTime(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reg-out">Proposed out</Label>
              <Input
                id="reg-out"
                type="time"
                value={proposedOutTime}
                onChange={(e) => setProposedOutTime(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-reason">
              Reason{' '}
              <span className="text-white/40 text-xs">
                (min 10 characters)
              </span>
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
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submit.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Submitting…
                </>
              ) : (
                'Submit request'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
