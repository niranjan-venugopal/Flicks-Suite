'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Pill, SectionHead, type PillTone } from '@/components/proto'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { usePresence } from '@/lib/api/queries/use-presence'
import { EscalationPill } from '@/components/approvals/EscalationPill'
import type { ApprovalEscalation } from '@/lib/api/queries/use-dashboard'
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
//  • Pending review — periods ROUTED to me (GET /timesheet/pending: direct
//    reports, escalated to me, level 2 for owner/HR admin) PLUS, for
//    owner/HR admin, every other submitted period in the workspace with a
//    muted "With <manager> · escalates in Nh" chip — the "open directly"
//    surface (Round L). Managers see only their direct reports.
//  • All periods — every period of my team, any status, with approver and
//    decision. Owner/HR admin see the whole workspace.
// Round L: `?period=<id>` (from the bell / email) highlights that row — the
// `request` idiom from Team → Leave.
// ─────────────────────────────────────────────────────────

type ReviewAction = 'approve' | 'reject' | 'rework'
type Tab = 'pending' | 'all'

type Row = {
  id: string
  employeeId?: string
  employeeCode?: string | null
  employeeName?: string | null
  employeeUserId?: string | null
  /** Signed photo URL — optional: older API builds omit it. */
  avatarUrl?: string | null
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
  // Round L
  routedToMe?: boolean
  managerName?: string | null
  escalation?: ApprovalEscalation | null
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
  // useSearchParams() needs a Suspense boundary for Next's static export step.
  return (
    <Suspense fallback={<div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Loader2 className="w-6 h-6 animate-spin text-brand-muted" /></div>}>
      <TeamTimesheetsInner />
    </Suspense>
  )
}

function TeamTimesheetsInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<Tab>('pending')
  const pending = usePendingTimesheets()
  const teamSubmitted = useTeamTimesheets({ status: 'submitted', limit: 100 })
  const all = useTeamTimesheets({ status: 'all', limit: 100 }, tab === 'all')
  const review = useReviewTimesheet()
  const { toast } = useToast()

  const [active, setActive] = useState<Row | null>(null)
  const [action, setAction] = useState<ReviewAction>('approve')
  const [comment, setComment] = useState('')

  // Pending review = the routed queue ("mine") + for owner/HR admin every
  // other submitted period in the workspace (a manager's team list only ever
  // holds direct reports, which are all routed to them already).
  const mine: Row[] = useMemo(
    () =>
      (pending.data?.data ?? []).map((r: TimesheetPeriod) => ({
        ...r,
        status: r.status ?? 'submitted',
        routedToMe: true,
        escalation: r.escalation ? { reason: null, at: null, toName: null, ...r.escalation } : null,
      })),
    [pending.data],
  )
  const others: Row[] = useMemo(
    () => (teamSubmitted.data?.data ?? []).filter((r: TeamTimesheetPeriod) => !mine.some((m) => m.id === r.id)),
    [teamSubmitted.data, mine],
  )
  const pendingRows: Row[] = useMemo(() => [...mine, ...others], [mine, others])
  // Memoised for the same reason as `mine`/`others` above: an inline `?? []`
  // is a new array every render, and `rows` feeds a useMemo dep below.
  const allRows: Row[] = useMemo(() => all.data?.data ?? [], [all.data])
  const rows = tab === 'pending' ? pendingRows : allRows

  // Seed presence for the faces on screen; the socket keeps the dots live.
  usePresence(
    useMemo(
      () => rows.map((r) => r.employeeUserId).filter((id): id is string => !!id),
      [rows],
    ),
  )

  const loading = tab === 'pending' ? (pending.isLoading || teamSubmitted.isLoading) : all.isLoading
  const scope = teamSubmitted.data?.scope ?? all.data?.scope

  const openReview = (row: Row, a: ReviewAction) => { setActive(row); setAction(a); setComment('') }
  const close = () => setActive(null)

  // ── Deep link: ?period=<id> ───────────────────────────────────────────
  const periodParam = searchParams.get('period')
  const [highlight, setHighlight] = useState<string | null>(null)
  const consumed = useRef<string | null>(null)
  const clearParams = () => router.replace('/team/timesheets', { scroll: false })

  useEffect(() => {
    if (!periodParam) { consumed.current = null; return }
    if (pending.isLoading || teamSubmitted.isLoading) return
    if (consumed.current === periodParam) return
    consumed.current = periodParam
    const row = pendingRows.find((r) => r.id === periodParam)
    if (!row) {
      // Already decided, not in this reviewer's scope, or a stale link.
      toast({
        title: 'That timesheet isn’t waiting on you',
        description: 'It may already be reviewed, or it belongs to another manager’s team.',
      })
      clearParams()
      return
    }
    setTab('pending')
    setHighlight(row.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodParam, pending.isLoading, teamSubmitted.isLoading, pendingRows])

  useEffect(() => {
    if (!highlight) return
    const el = document.querySelector<HTMLElement>(`[data-period-id="${highlight}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlight, tab])

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
      setHighlight(null)
      if (periodParam) clearParams()
    } catch (e) {
      toast({ title: 'Could not submit review', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }

  const pendingSub =
    others.length > 0
      ? `${mine.length} ${mine.length === 1 ? 'period' : 'periods'} pending your review · ${others.length} more across the workspace, with their managers`
      : `${mine.length} ${mine.length === 1 ? 'period' : 'periods'} pending your review`

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Team timesheets"
          sub={
            tab === 'pending'
              ? pendingSub
              : scope === 'org' ? 'Every timesheet period across the workspace' : 'Every timesheet period from your direct reports'
          }
        />

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 10, marginBottom: 14, width: 'fit-content' }} data-testid="team-timesheets-tabs">
          {([['pending', 'Pending review'], ['all', 'All periods']] as Array<[Tab, string]>).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)} data-testid={`team-timesheets-tab-${k}`} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800 }}>
              {l}
              {k === 'pending' && mine.length > 0 && <span style={{ marginLeft: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--blue)' }}>{mine.length}</span>}
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
                  const highlighted = highlight === r.id
                  return (
                    <tr
                      key={r.id}
                      data-testid={`team-timesheets-row-${r.id}`}
                      data-period-id={r.id}
                      data-routed={r.routedToMe === false ? 'other' : 'me'}
                      style={{
                        background: highlighted ? 'rgba(62,123,250,.10)' : undefined,
                        boxShadow: highlighted ? 'inset 3px 0 0 var(--blue)' : undefined,
                        transition: 'background .3s',
                      }}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                          <RowPresenceAvatar
                            name={name}
                            src={r.avatarUrl ?? null}
                            userId={r.employeeUserId ?? null}
                            size={30}
                          />
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
                          {/* Round L: where the period sits in the routing chain. */}
                          {r.status === 'submitted' && (
                            <EscalationPill
                              escalation={r.escalation ?? null}
                              routedToMe={r.routedToMe ?? true}
                              managerName={r.managerName ?? null}
                              anchorAt={r.submittedAt ?? null}
                            />
                          )}
                          {r.status === 'rejected' && r.rejectionComment && <span style={{ fontSize: 11, color: 'var(--text-mute)' }} title={r.rejectionComment}>· {r.rejectionComment.slice(0, 40)}{r.rejectionComment.length > 40 ? '…' : ''}</span>}
                        </div>
                      </td>
                      {tab === 'all' && (
                        <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
                          {r.approverName ?? (
                            <span style={{ color: 'var(--text-faint)' }} title="No approver was set when this week was created — whoever reviews it is recorded as approver.">
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
        onClose={() => { close(); if (periodParam) clearParams() }}
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
    rework: { title: 'Request rework', blurb: 'The week reopens as a draft so the employee can edit and resubmit — the escalation clock restarts on resubmit.', cta: 'Send back for rework', tone: 'secondary' as const },
    reject: { title: 'Reject timesheet', blurb: 'Rejecting closes the week without further edits. A comment is required.', cta: 'Reject', tone: 'danger' as const },
  }[action]

  return (
    <Dialog open={!!period} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        <div style={{ background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 14px' }}>
          <RowPresenceAvatar
            name={displayName(period)}
            src={period.avatarUrl ?? null}
            userId={period.employeeUserId ?? null}
            size={30}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>{displayName(period)}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
              Week {period.periodStart} – {period.periodEnd} · {Number(period.totalHours).toFixed(1)}h
            </div>
          </div>
        </div>

        {period.routedToMe === false && (
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginBottom: 10 }}>
            This week is with {period.managerName?.trim() || 'the reporting manager'} — deciding it here records you as the approver, and they&apos;ll be told.
          </p>
        )}

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
          <Btn kind={copy.tone} onClick={onSubmit} disabled={isPending} data-testid="review-timesheet-confirm">{isPending ? 'Submitting…' : copy.cta}</Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
