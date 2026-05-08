'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Calendar, Plus, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useToast } from '@/components/ui/use-toast'
import {
  useApplyLeave,
  useLeaveTypes,
  useMyLeaveBalances,
  useMyLeaveRequests,
  usePendingLeaveRequests,
  useReviewLeave,
  type ApplyLeavePayload,
  type LeaveBalance,
  type LeaveRequest,
  type PendingLeaveRequest,
} from '@/lib/api/queries/use-leave'

export default function LeavePage() {
  const [applyOpen, setApplyOpen] = useState(false)
  const balancesQ = useMyLeaveBalances()
  const myReqs = useMyLeaveRequests()
  const pending = usePendingLeaveRequests()

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
            <h1 className="text-3xl font-bold text-white font-gilroy">Leave</h1>
            <p className="text-brand-muted mt-1">
              Plan time off and review approvals across your team
            </p>
          </div>
          <Button onClick={() => setApplyOpen(true)} className="shrink-0">
            <Plus className="w-4 h-4" />
            Apply for leave
          </Button>
        </motion.div>

        {/* ─── Balance summary ───────────────────────────────────────────── */}
        <BalanceStrip
          balances={balancesQ.data?.balances ?? []}
          loading={balancesQ.isLoading}
        />

        <Tabs defaultValue="my" className="mt-6">
          <TabsList>
            <TabsTrigger value="my">My leave</TabsTrigger>
            <TabsTrigger value="team">
              Team queue
              {pending.data && pending.data.data.length > 0 && (
                <span className="ml-2 px-1.5 py-0.5 rounded-full bg-brand-blue text-white text-[10px] font-bold">
                  {pending.data.data.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="my">
            <div className="glass rounded-xl overflow-hidden">
              {myReqs.isLoading ? (
                <LoadingRow />
              ) : !myReqs.data || myReqs.data.data.length === 0 ? (
                <EmptyState
                  icon={Calendar}
                  title="No leave taken yet"
                  description="Apply for time off and your requests will land here."
                />
              ) : (
                <MyLeaveTable rows={myReqs.data.data} />
              )}
            </div>
          </TabsContent>

          <TabsContent value="team">
            <div className="glass rounded-xl overflow-hidden">
              {pending.isLoading ? (
                <LoadingRow />
              ) : !pending.data || pending.data.data.length === 0 ? (
                <EmptyState
                  icon={Calendar}
                  title="No team requests"
                  description="When teammates apply, their requests will show up here for review."
                />
              ) : (
                <PendingLeaveTable rows={pending.data.data} />
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <ApplyLeaveDialog open={applyOpen} onOpenChange={setApplyOpen} />
    </div>
  )
}

// ─── Balance strip ──────────────────────────────────────────────────────────

function BalanceStrip({
  balances,
  loading,
}: {
  balances: LeaveBalance[]
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="glass rounded-xl p-4 flex items-center gap-3 text-white/40">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading balances…
      </div>
    )
  }
  if (balances.length === 0) {
    return (
      <div className="glass rounded-xl p-4 text-sm text-white/50 font-gilroy">
        No leave types configured yet. Ask an admin to set them up under
        Settings → Leave Policies.
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {balances.map((b) => (
        <div
          key={b.leaveTypeId}
          className="glass rounded-xl p-4"
          style={{ borderLeft: `3px solid ${b.color ?? '#6366f1'}` }}
        >
          <div className="text-xs uppercase tracking-wider text-white/40 font-gilroy">
            {b.code}
          </div>
          <div className="text-base font-semibold text-white font-gilroy mt-0.5">
            {b.leaveTypeName}
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-gilroy">
              {b.available.toFixed(1)}
            </span>
            <span className="text-xs text-white/40">available</span>
          </div>
          <div className="mt-1 text-[11px] text-white/40 font-gilroy">
            {b.used} used · {b.pending} pending
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── My leave table ─────────────────────────────────────────────────────────

function MyLeaveTable({ rows }: { rows: LeaveRequest[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/[0.06] text-left">
            <Th>Type</Th>
            <Th>From</Th>
            <Th>To</Th>
            <Th>Days</Th>
            <Th>Reason</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
            >
              <Td>
                <span className="inline-flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: r.leaveTypeColor ?? '#6366f1' }}
                  />
                  {r.leaveTypeName ?? '—'}
                </span>
              </Td>
              <Td>{r.startDate}</Td>
              <Td>{r.endDate}</Td>
              <Td>{r.totalDays}</Td>
              <Td className="max-w-xs truncate">{r.reason}</Td>
              <Td>
                <StatusBadge status={r.status} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Pending (manager queue) ───────────────────────────────────────────────

function PendingLeaveTable({ rows }: { rows: PendingLeaveRequest[] }) {
  const review = useReviewLeave()
  const { toast } = useToast()

  const handle = async (id: string, action: 'approve' | 'reject') => {
    try {
      await review.mutateAsync({ id, action })
      toast({
        title: action === 'approve' ? 'Leave approved' : 'Leave rejected',
        description: 'The applicant has been notified.',
      })
    } catch (err) {
      toast({
        title: 'Action failed',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/[0.06] text-left">
            <Th>Employee</Th>
            <Th>Type</Th>
            <Th>From</Th>
            <Th>To</Th>
            <Th>Days</Th>
            <Th>Reason</Th>
            <Th>Action</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
            >
              <Td>
                <div className="font-medium text-white">{r.employeeName}</div>
                <div className="text-[11px] text-white/40">{r.employeeCode}</div>
              </Td>
              <Td>{r.leaveTypeName ?? '—'}</Td>
              <Td>{r.startDate}</Td>
              <Td>{r.endDate}</Td>
              <Td>{r.totalDays}</Td>
              <Td className="max-w-xs truncate">{r.reason}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={review.isPending}
                    onClick={() => handle(r.id, 'approve')}
                    className="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-400/10"
                  >
                    <Check className="w-4 h-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={review.isPending}
                    onClick={() => handle(r.id, 'reject')}
                    className="text-rose-400 hover:text-rose-300 hover:bg-rose-400/10"
                  >
                    <X className="w-4 h-4" />
                    Reject
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider">
      {children}
    </th>
  )
}
function Td({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <td className={`px-6 py-4 text-sm text-white/80 font-gilroy ${className}`}>
      {children}
    </td>
  )
}
function LoadingRow() {
  return (
    <div className="px-6 py-12 flex items-center justify-center text-white/40">
      <Loader2 className="w-4 h-4 animate-spin mr-2" />
      Loading…
    </div>
  )
}

// ─── Apply dialog ──────────────────────────────────────────────────────────

function ApplyLeaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const types = useLeaveTypes()
  const apply = useApplyLeave()
  const { toast } = useToast()

  const [leaveTypeId, setLeaveTypeId] = useState<string>('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [isHalfDay, setIsHalfDay] = useState(false)
  const [halfDaySession, setHalfDaySession] = useState<
    'first_half' | 'second_half'
  >('first_half')
  const [reason, setReason] = useState('')

  const reset = () => {
    setLeaveTypeId('')
    setStartDate('')
    setEndDate('')
    setIsHalfDay(false)
    setReason('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!leaveTypeId || !startDate || !endDate || reason.trim().length < 10) {
      toast({
        title: 'Please fill all fields',
        description: 'Reason must be at least 10 characters.',
        variant: 'destructive',
      })
      return
    }
    const payload: ApplyLeavePayload = {
      leaveTypeId,
      startDate,
      endDate,
      reason,
      isHalfDay,
      ...(isHalfDay ? { halfDaySession } : {}),
    }
    try {
      await apply.mutateAsync(payload)
      toast({
        title: 'Leave request submitted',
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
          <DialogTitle>Apply for leave</DialogTitle>
          <DialogDescription>
            Pick your leave type and dates. Your manager will be notified.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="leave-type">Leave type</Label>
            <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
              <SelectTrigger id="leave-type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {(types.data?.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.code})
                  </SelectItem>
                ))}
                {types.isLoading && (
                  <div className="px-2 py-1 text-xs text-white/40">
                    Loading…
                  </div>
                )}
                {!types.isLoading &&
                  (!types.data || types.data.data.length === 0) && (
                    <div className="px-2 py-1 text-xs text-white/40">
                      No types configured
                    </div>
                  )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="leave-from">From</Label>
              <Input
                id="leave-from"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="leave-to">To</Label>
              <Input
                id="leave-to"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-white/70 font-gilroy">
            <input
              type="checkbox"
              checked={isHalfDay}
              onChange={(e) => setIsHalfDay(e.target.checked)}
              className="accent-brand-blue"
            />
            Half day
          </label>

          {isHalfDay && (
            <Select
              value={halfDaySession}
              onValueChange={(v) =>
                setHalfDaySession(v as 'first_half' | 'second_half')
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="first_half">First half</SelectItem>
                <SelectItem value="second_half">Second half</SelectItem>
              </SelectContent>
            </Select>
          )}

          <div className="space-y-2">
            <Label htmlFor="leave-reason">
              Reason <span className="text-white/40 text-xs">(min 10 characters)</span>
            </Label>
            <Textarea
              id="leave-reason"
              placeholder="Share a quick note for your manager"
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
              disabled={apply.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={apply.isPending}>
              {apply.isPending ? (
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
