'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  CheckCircle2,
  XCircle,
  ChevronDown,
  Clock,
  Calendar,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useReviewLeave } from '@/lib/api/queries/use-leave'
import { useReviewRegularization } from '@/lib/api/queries/use-attendance'
import type { AdminOverview } from '@/lib/api/queries/use-dashboard'

type Tab = 'leave' | 'regularization'

export function PendingActionsCard({
  overview,
  isLoading,
  onMutated,
}: {
  overview?: AdminOverview
  isLoading: boolean
  onMutated: () => void
}) {
  const [tab, setTab] = useState<Tab>('leave')

  const leaveCount = overview?.pending.leaveCount ?? 0
  const regCount = overview?.pending.regularizationCount ?? 0
  const total = leaveCount + regCount

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-white font-gilroy flex items-center gap-2">
            Pending approvals
            {total > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-brand-coral/20 text-brand-coral text-xs font-medium">
                {total}
              </span>
            )}
          </h2>
          <p className="text-sm text-brand-muted mt-1">
            One-click approve from here — no need to navigate away.
          </p>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-4 p-1 rounded-lg bg-white/[0.03] w-fit">
        <TabButton active={tab === 'leave'} onClick={() => setTab('leave')}>
          Leave ({leaveCount})
        </TabButton>
        <TabButton
          active={tab === 'regularization'}
          onClick={() => setTab('regularization')}
        >
          Regularization ({regCount})
        </TabButton>
      </div>

      {isLoading ? (
        <SkeletonRows />
      ) : tab === 'leave' ? (
        overview && overview.pending.leaves.length > 0 ? (
          <ul className="space-y-2">
            {overview.pending.leaves.map((l) => (
              <LeaveRow key={l.id} item={l} onMutated={onMutated} />
            ))}
          </ul>
        ) : (
          <EmptyRow message="All leave requests are caught up." />
        )
      ) : overview && overview.pending.regularizations.length > 0 ? (
        <ul className="space-y-2">
          {overview.pending.regularizations.map((r) => (
            <RegRow key={r.id} item={r} onMutated={onMutated} />
          ))}
        </ul>
      ) : (
        <EmptyRow message="No regularization requests pending." />
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors font-gilroy ${
        active
          ? 'bg-white/[0.08] text-white'
          : 'text-white/50 hover:text-white/80'
      }`}
    >
      {children}
    </button>
  )
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="py-8 flex items-center justify-center gap-2 text-white/40 text-sm font-gilroy">
      <CheckCircle2 className="w-4 h-4 text-brand-green" />
      {message}
    </div>
  )
}

function SkeletonRows() {
  return (
    <ul className="space-y-2">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="h-14 rounded-lg bg-white/[0.03] animate-pulse"
        />
      ))}
    </ul>
  )
}

function LeaveRow({
  item,
  onMutated,
}: {
  item: NonNullable<AdminOverview['pending']['leaves'][number]>
  onMutated: () => void
}) {
  const [open, setOpen] = useState(false)
  const review = useReviewLeave()
  const { toast } = useToast()

  const handle = async (action: 'approve' | 'reject') => {
    try {
      await review.mutateAsync({ id: item.id, action })
      toast({
        title: action === 'approve' ? 'Leave approved' : 'Leave rejected',
        description: `${item.employeeName} · ${item.leaveTypeCode ?? 'Leave'}`,
      })
      onMutated()
    } catch (e) {
      toast({
        title: `Failed to ${action}`,
        description: e instanceof Error ? e.message : 'Try again.',
        variant: 'destructive',
      })
    }
  }

  return (
    <li className="rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Calendar className="w-4 h-4 text-brand-blue shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-white font-gilroy truncate">
              <span className="font-medium">{item.employeeName}</span>
              <span className="text-white/50">
                {' · '}
                {item.leaveTypeCode ?? 'Leave'} ·{' '}
                {item.totalDays} day{item.totalDays === 1 ? '' : 's'}
              </span>
            </div>
            <div className="text-xs text-white/40">
              {item.startDate} → {item.endDate}
            </div>
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-white/30 transition-transform shrink-0 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden border-t border-white/[0.04]"
          >
            <div className="px-4 py-3 space-y-3">
              {item.reason && (
                <div className="text-xs text-white/60 font-gilroy">
                  <span className="text-white/40">Reason:</span> {item.reason}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handle('approve')
                  }}
                  disabled={review.isPending}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handle('reject')
                  }}
                  disabled={review.isPending}
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Reject
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}

function RegRow({
  item,
  onMutated,
}: {
  item: NonNullable<AdminOverview['pending']['regularizations'][number]>
  onMutated: () => void
}) {
  const [open, setOpen] = useState(false)
  const review = useReviewRegularization()
  const { toast } = useToast()

  const handle = async (action: 'approve' | 'reject') => {
    try {
      await review.mutateAsync({ id: item.id, action })
      toast({
        title:
          action === 'approve'
            ? 'Regularization approved'
            : 'Regularization rejected',
        description: `${item.employeeName} · ${item.attendanceDate}`,
      })
      onMutated()
    } catch (e) {
      toast({
        title: `Failed to ${action}`,
        description: e instanceof Error ? e.message : 'Try again.',
        variant: 'destructive',
      })
    }
  }

  return (
    <li className="rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Clock className="w-4 h-4 text-brand-yellow shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-white font-gilroy truncate">
              <span className="font-medium">{item.employeeName}</span>
              <span className="text-white/50">
                {' · '}
                {humanizeReqType(item.requestType)}
              </span>
            </div>
            <div className="text-xs text-white/40">
              For {item.attendanceDate}
            </div>
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-white/30 transition-transform shrink-0 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden border-t border-white/[0.04]"
          >
            <div className="px-4 py-3 space-y-3">
              <div className="text-xs text-white/60 font-gilroy">
                <span className="text-white/40">Reason:</span> {item.reason}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handle('approve')
                  }}
                  disabled={review.isPending}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handle('reject')
                  }}
                  disabled={review.isPending}
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Reject
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}

function humanizeReqType(t: string): string {
  switch (t) {
    case 'missing_punch':
      return 'Missing punch'
    case 'wrong_time':
      return 'Wrong time'
    case 'wfh_request':
      return 'Work from home'
    case 'on_duty':
      return 'On duty'
    case 'manual_override':
      return 'Manual override'
    default:
      return t
  }
}
