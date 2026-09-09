'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead, type PillTone } from '@/components/proto'
import {
  usePendingTimesheets,
  useTeamTimesheets,
  useReviewTimesheet,
  type TimesheetPeriod,
  type TeamTimesheetPeriod,
} from '@/lib/api/queries/use-timesheets'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ─────────────────────────────────────────────────────────
// Round I — Team → Timesheets: two tabs.
//  • Pending review — periods submitted to me (approver_id = me) PLUS my
//    direct reports' submitted periods whose approver was never stamped
//    (created before I became their manager); reviewing stamps me.
//  • All periods — every period of my team, any status, with approver and
//    decision. Owner/HR admin see the whole workspace.
// ─────────────────────────────────────────────────────────

type ReviewAction = 'approve' | 'reject' | 'rework'
type Tab = 'pending' | 'all'

type Row = {
  id: string
  employeeId?: string
  employeeCode?: string | null
  employeeName?: string | null
  periodStart: string
  periodEnd: string
  status: string
  totalHours: number
  submittedAt?: string | null
  approverId?: string | null
  approverName?: string | null
  approvedAt?: string | null
  rejectedAt?: string | null
  rejectionComment?: string | null
}

function displayName(r: Row): string {
  const name = (r.employeeName ?? '').trim()
  if (name) return name
  if (r.employeeCode) return r.employeeCode
  if (r.employeeId) return `Employee · ${r.employeeId.slice(0, 8)}`
  return 'Employee'
}

function statusTone(s: string): PillTone {
  switch (s) {
    case 'submitted': return 'blue'
    case 'approved':  return 'green'
    case 'rejected':  return 'coral'
    case 'locked':    return 'purple'
    default:          return ''
  }
}
function statusLabel(s: string): string {
  return s === 'submitted' ? 'Submitted' : s.charAt(0).toUpperCase() + s.slice(1)
}
function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export default function TeamTimesheetsPage() {
  const [tab, setTab] = useState<Tab>('pending')
  const pending = usePendingTimesheets()
  const teamSubmitted = useTeamTimesheets({ status: 'submitted', limit: 100 })
  const all = useTeamTimesheets({ status: 'all', limit: 100 }, tab === 'all')
  const review = useReviewTimesheet()
  const { toast } = useToast()

  const [active, setActive] = useState<Row | null>(null)
  const [action, setAction] = useState<ReviewAction>('approve')
  const [comment, setComment] = useState('')

  // Pending review = union of "submitted to me" and my team's submitted
  // periods with no approver stamped yet (self-healed on review).
  const mine: Row[] = (pending.data?.data ?? []).map((r: TimesheetPeriod) => ({ ...r, status: r.status }))
  const unstamped: Row[] = (teamSubmitted.data?.data ?? []).filter((r: TeamTimesheetPeriod) => r.approverId === null && !mine.some((m) => m.id === r.id))
  const pendingRows: Row[] = [...mine, ...unstamped]
  const allRows: Row[] = all.data?.data ?? []
  const rows = tab === 'pending' ? pendingRows : allRows
  const loading = tab === 'pending' ? (pending.isLoading || teamSubmitted.isLoading) : all.isLoading
  const scope = teamSubmitted.data?.scope ?? all.data?.scope

  const openReview = (row: Row, a: ReviewAction) => { setActive(row); setAction(a); setComment('') }
  const close = () => setActive(null)

  const handleSubmit = async () => {
    if (!active) return
    const needsComment = action === 'reject' || action === 'rework'
    if (needsComment && !comment.trim()) {
      toast({
        title: 'Comment required',
        description: action === 'reject' ? 'Tell the employee why their timesheet was rejected.' : 'Explain what changes the employee should make.',
        variant: 'destructive',
      })
      return
    }
    try {
      await review.mutateAsync({ periodId: active.id, action, comment: comment.trim() || undefined })
      toast({
        title: action === 'approve' ? 'Approved' : action === 'rework' ? 'Rework requested' : 'Rejected',
        description: `${displayName(active)} · ${active.periodStart}`,
      })
      close()
    } catch (e) {
      toast({ title: 'Could not submit review', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Team timesheets"
          sub={
            tab === 'pending'
              ? `${pendingRows.length} ${pendingRows.length === 1 ? 'period' : 'periods'} pending your review`
              : scope === 'org' ? 'Every timesheet period across the workspace' : 'Every timesheet period from your direct reports'
          }
        />

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 10, marginBottom: 14, width: 'fit-content' }} data-testid="team-timesheets-tabs">
          {([['pending', 'Pending review'], ['all', 'All periods']] as Array<[Tab, string]>).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)} data-testid={`team-timesheets-tab-${k}`} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800 }}>
              {l}
              {k === 'pending' && pendingRows.length > 0 && <span style={{ marginLeft: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--blue)' }}>{pendingRows.length}</span>}
            </button>
          ))}
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Loader2 className="w-4 h-4 animate-spin" /> Loading timesheets…
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-mute)', fontSize: 13, fontWeight: 600 }} data-testid="team-timesheets-empty">
              {tab === 'pending' ? 'All caught up. No timesheets waiting on you.' : 'No timesheet periods from your team yet. Periods appear as soon as someone logs hours.'}
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }} data-testid={`team-timesheets-table-${tab}`}>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Week</th>
                  <th>Hours</th>
                  <th>Status</th>
                  {tab === 'all' && <th>Approver</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const name = displayName(r)
                  const reviewable = r.status === 'submitted'
                  return (
                    <tr key={r.id} data-testid={`team-timesheets-row-${r.id}`}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                          <Avatar name={name} size="sm" />
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 800 }}>{name}</div>
                            {r.employeeCode && r.employeeName && (
                              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>{r.employeeCode}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{r.periodStart} – {r.periodEnd}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{Number(r.totalHours).toFixed(1)}h</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <Pill tone={statusTone(r.status)} dot>{statusLabel(r.status)}</Pill>
                          {r.status === 'submitted' && r.submittedAt && <span style={{ fontSize: 11, color: 'var(--text-mute)' }}>{fmtStamp(r.submittedAt)}</span>}
                          {r.status === 'rejected' && r.rejectionComment && <span style={{ fontSize: 11, color: 'var(--text-mute)' }} title={r.rejectionComment}>· {r.rejectionComment.slice(0, 40)}{r.rejectionComment.length > 40 ? '…' : ''}</span>}
                        </div>
                      </td>
                      {tab === 'all' && (
                        <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
                          {r.approverName ?? (
                            <span style={{ color: 'var(--text-faint)' }} title="No approver was set when this week was created — you’ll be recorded as approver when you review it.">
                              No approver set
                            </span>
                          )}
                        </td>
                      )}
                      <td style={{ textAlign: 'right' }}>
                        {reviewable ? (
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <Btn kind="ghost" size="sm" icon={<Icon.x size={12} />} onClick={() => openReview(r, 'reject')} disabled={review.isPending}>Reject</Btn>
                            <Btn kind="secondary" size="sm" icon={<Icon.arrowL size={12} />} onClick={() => openReview(r, 'rework')} disabled={review.isPending}>Rework</Btn>
                            <Btn kind="primary" size="sm" icon={<Icon.check size={12} />} onClick={() => openReview(r, 'approve')} disabled={review.isPending}>Approve</Btn>
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--text-faint)', fontWeight: 700 }}>
                            {r.status === 'approved' ? `Approved ${fmtStamp(r.approvedAt)}` : r.status === 'rejected' ? `Rejected ${fmtStamp(r.rejectedAt)}` : r.status === 'draft' ? 'Not submitted yet' : ''}
                          </span>
                        )}
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

function ReviewDialog({ period, action, comment, setComment, isPending, onSubmit, onClose }: {
  period: Row | null
  action: ReviewAction
  comment: string
  setComment: (v: string) => void
  isPending: boolean
  onSubmit: () => void
  onClose: () => void
}) {
  if (!period) return null

  const copy = {
    approve: { title: 'Approve timesheet', blurb: 'Approving sends a confirmation to the employee. Comment is optional.', cta: 'Approve', tone: 'primary' as const },
    rework: { title: 'Request rework', blurb: 'The week reopens as a draft so the employee can edit and resubmit.', cta: 'Send back for rework', tone: 'secondary' as const },
    reject: { title: 'Reject timesheet', blurb: 'Rejecting closes the week without further edits. A comment is required.', cta: 'Reject', tone: 'danger' as const },
  }[action]

  return (
    <Dialog open={!!period} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        <div style={{ background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 14px' }}>
          <Avatar name={displayName(period)} size="sm" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>{displayName(period)}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
              Week {period.periodStart} – {period.periodEnd} · {Number(period.totalHours).toFixed(1)}h
            </div>
          </div>
        </div>

        {period.approverId === null && (
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginBottom: 10 }}>
            No approver was set on this week — you&apos;ll be recorded as its approver.
          </p>
        )}

        <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>{copy.blurb}</p>

        <label className="label" style={{ display: 'block', marginBottom: 6 }}>
          Comment {action === 'approve' ? '(optional)' : <span style={{ color: 'var(--coral)' }}>*</span>}
        </label>
        <textarea
          className="input"
          rows={4}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={action === 'reject' ? 'Why is this timesheet being rejected?' : action === 'rework' ? 'What should the employee change before resubmitting?' : 'Optional note to the employee…'}
          maxLength={500}
          style={{ width: '100%', padding: 10, fontSize: 12.5, lineHeight: 1.5 }}
          autoFocus
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn kind="ghost" onClick={onClose} disabled={isPending}>Cancel</Btn>
          <Btn kind={copy.tone} onClick={onSubmit} disabled={isPending}>{isPending ? 'Submitting…' : copy.cta}</Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
