'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  usePendingTimesheets,
  useReviewTimesheet,
  type TimesheetPeriod,
} from '@/lib/api/queries/use-timesheets'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type ReviewAction = 'approve' | 'reject' | 'rework'

function displayName(r: TimesheetPeriod): string {
  const name = (r.employeeName ?? '').trim()
  if (name) return name
  if (r.employeeCode) return r.employeeCode
  if (r.employeeId) return `Employee · ${r.employeeId.slice(0, 8)}`
  return 'Employee'
}

export default function TeamTimesheetsPage() {
  const pending = usePendingTimesheets()
  const review = useReviewTimesheet()
  const { toast } = useToast()

  const [active, setActive] = useState<TimesheetPeriod | null>(null)
  const [action, setAction] = useState<ReviewAction>('approve')
  const [comment, setComment] = useState('')

  const rows = pending.data?.data ?? []

  const openReview = (row: TimesheetPeriod, a: ReviewAction) => {
    setActive(row)
    setAction(a)
    setComment('')
  }
  const close = () => setActive(null)

  const handleSubmit = async () => {
    if (!active) return
    const needsComment = action === 'reject' || action === 'rework'
    if (needsComment && !comment.trim()) {
      toast({
        title: 'Comment required',
        description:
          action === 'reject'
            ? 'Tell the employee why their timesheet was rejected.'
            : 'Explain what changes the employee should make.',
        variant: 'destructive',
      })
      return
    }
    try {
      await review.mutateAsync({
        periodId: active.id,
        action,
        comment: comment.trim() || undefined,
      })
      toast({
        title:
          action === 'approve'
            ? 'Approved'
            : action === 'rework'
              ? 'Rework requested'
              : 'Rejected',
        description: `${displayName(active)} · ${active.periodStart}`,
      })
      close()
    } catch (e) {
      toast({
        title: 'Could not submit review',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Team timesheets"
          sub={`${rows.length} ${rows.length === 1 ? 'period' : 'periods'} pending your review`}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="secondary" size="sm" icon={<Icon.filter size={13} />}>
                Filter
              </Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export
              </Btn>
            </div>
          }
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {pending.isLoading ? (
            <div
              style={{
                padding: 48,
                textAlign: 'center',
                color: 'var(--text-mute)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <Loader2 className="w-4 h-4 animate-spin" /> Loading pending timesheets…
            </div>
          ) : rows.length === 0 ? (
            <div
              style={{
                padding: 60,
                textAlign: 'center',
                color: 'var(--text-mute)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              All caught up. No timesheets waiting on you.
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Week</th>
                  <th>Hours</th>
                  <th>Submitted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const name = displayName(r)
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                          <Avatar name={name} size="sm" />
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 800 }}>{name}</div>
                            {r.employeeCode && r.employeeName && (
                              <div
                                style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  color: 'var(--text-mute)',
                                }}
                              >
                                {r.employeeCode}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        {r.periodStart} – {r.periodEnd}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                        {r.totalHours.toFixed(1)}h
                      </td>
                      <td>
                        <Pill tone="blue" dot>Submitted</Pill>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <Btn
                            kind="ghost"
                            size="sm"
                            icon={<Icon.x size={12} />}
                            onClick={() => openReview(r, 'reject')}
                            disabled={review.isPending}
                          >
                            Reject
                          </Btn>
                          <Btn
                            kind="secondary"
                            size="sm"
                            icon={<Icon.arrowL size={12} />}
                            onClick={() => openReview(r, 'rework')}
                            disabled={review.isPending}
                          >
                            Rework
                          </Btn>
                          <Btn
                            kind="primary"
                            size="sm"
                            icon={<Icon.check size={12} />}
                            onClick={() => openReview(r, 'approve')}
                            disabled={review.isPending}
                          >
                            Approve
                          </Btn>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <ReviewDialog
        period={active}
        action={action}
        comment={comment}
        setComment={setComment}
        isPending={review.isPending}
        onSubmit={handleSubmit}
        onClose={close}
      />
    </div>
  )
}

function ReviewDialog({
  period,
  action,
  comment,
  setComment,
  isPending,
  onSubmit,
  onClose,
}: {
  period: TimesheetPeriod | null
  action: ReviewAction
  comment: string
  setComment: (v: string) => void
  isPending: boolean
  onSubmit: () => void
  onClose: () => void
}) {
  if (!period) return null

  const copy = {
    approve: {
      title: 'Approve timesheet',
      blurb: 'Approving sends a confirmation to the employee. Comment is optional.',
      cta: 'Approve',
      tone: 'primary' as const,
    },
    rework: {
      title: 'Request rework',
      blurb: 'The week reopens as a draft so the employee can edit and resubmit.',
      cta: 'Send back for rework',
      tone: 'secondary' as const,
    },
    reject: {
      title: 'Reject timesheet',
      blurb: 'Rejecting closes the week without further edits. A comment is required.',
      cta: 'Reject',
      tone: 'danger' as const,
    },
  }[action]

  return (
    <Dialog open={!!period} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        <div
          style={{
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            borderRadius: 10,
            padding: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '4px 0 14px',
          }}
        >
          <Avatar name={displayName(period)} size="sm" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>{displayName(period)}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
              Week {period.periodStart} – {period.periodEnd} · {period.totalHours.toFixed(1)}h
            </div>
          </div>
        </div>

        <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
          {copy.blurb}
        </p>

        <label className="label" style={{ display: 'block', marginBottom: 6 }}>
          Comment {action === 'approve' ? '(optional)' : <span style={{ color: 'var(--coral)' }}>*</span>}
        </label>
        <textarea
          className="input"
          rows={4}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={
            action === 'reject'
              ? 'Why is this timesheet being rejected?'
              : action === 'rework'
                ? 'What should the employee change before resubmitting?'
                : 'Optional note to the employee…'
          }
          maxLength={500}
          style={{ width: '100%', padding: 10, fontSize: 12.5, lineHeight: 1.5 }}
          autoFocus
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn kind="ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </Btn>
          <Btn kind={copy.tone} onClick={onSubmit} disabled={isPending}>
            {isPending ? 'Submitting…' : copy.cta}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
