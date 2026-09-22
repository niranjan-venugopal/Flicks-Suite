'use client'

import Link from 'next/link'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import {
  Btn,
  Icon,
  Kpi,
  Modal,
  Pill,
  SectionHead,
  type PillTone,
} from '@/components/proto'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { usePresence } from '@/lib/api/queries/use-presence'
import {
  useTeamLeave,
  useReviewLeave,
  type TeamLeaveRequest,
} from '@/lib/api/queries/use-leave'
import { EscalationPill } from '@/components/approvals/EscalationPill'
import { useToast } from '@/components/ui/use-toast'

// ─────────────────────────────────────────────────────────
// Round I — Team → Leave. Used to read a { data, pagination } envelope as
// an array, so it ALWAYS said "nothing waiting for you". Now three tabs
// (Pending | Upcoming | History) over GET /leave/team (managers: direct
// reports; owner/HR admin: whole workspace), a confirm dialog for every
// decision (comments allowed), and an emailed deep link
// /team/leave?request=<id>&action=approve|reject that pre-selects the
// decision — it never acts by itself.
// Round L: owner/HR admin keep the workspace-wide list (the "open directly"
// surface); each pending row carries the routing chip — muted "With
// <manager> · escalates in Nh" while it sits with the manager, coral/yellow
// once escalated — driven by `routedToMe` / `escalation` from GET /leave/team.
// ─────────────────────────────────────────────────────────

type Tab = 'pending' | 'upcoming' | 'history'
type ReviewAction = 'approve' | 'reject'

function fmtDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
function fmtRange(start: string, end: string): string {
  if (start === end) return fmtDate(start)
  return `${fmtDate(start)} – ${fmtDate(end)}`
}
function fmtStamp(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
function typePillTone(code: string | null): PillTone {
  if (!code) return ''
  if (code === 'CL') return 'blue'
  if (code === 'SL' || code === 'ML' || code === 'LOP') return 'coral'
  if (code === 'CO' || code === 'WFH') return 'green'
  return 'purple'
}
function statusPill(s: TeamLeaveRequest['status']) {
  switch (s) {
    case 'pending':   return <Pill tone="yellow" dot>Pending</Pill>
    case 'approved':  return <Pill tone="green" dot>Approved</Pill>
    case 'rejected':  return <Pill tone="coral" dot>Rejected</Pill>
    case 'cancelled': return <Pill tone="" dot>Cancelled</Pill>
    default:          return <Pill tone="">{s}</Pill>
  }
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}
function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function TeamLeavePage() {
  // useSearchParams() needs a Suspense boundary for Next's static export step.
  return (
    <Suspense fallback={<div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Loader2 className="w-6 h-6 animate-spin text-brand-muted" /></div>}>
      <TeamLeaveInner />
    </Suspense>
  )
}

function TeamLeaveInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const review = useReviewLeave()

  const [tab, setTab] = useState<Tab>('pending')
  const today = useMemo(() => isoToday(), [])
  const historyFrom = useMemo(() => isoDaysAgo(90), [])

  const pending = useTeamLeave({ status: 'pending', limit: 100 })
  const upcoming = useTeamLeave({ status: 'approved', from: today, limit: 100 }, tab === 'upcoming')
  const history = useTeamLeave({ status: 'all', from: historyFrom, limit: 100 }, tab === 'history')

  // Memoised so the deep-link effect below (dep: pendingRows) and the presence
  // id array don't re-run on every render — `?? []` / `.filter()` inline would
  // hand them a brand-new array each time.
  const pendingRows = useMemo(() => pending.data?.data ?? [], [pending.data])
  const upcomingRows = useMemo(() => upcoming.data?.data ?? [], [upcoming.data])
  // History = everything decided/cancelled in the window (pending has its own tab).
  const historyRows = useMemo(
    () => (history.data?.data ?? []).filter((r) => r.status !== 'pending'),
    [history.data],
  )
  const scope = pending.data?.scope

  // ── Review dialog state ────────────────────────────────────────────────
  const [active, setActive] = useState<TeamLeaveRequest | null>(null)
  const [action, setAction] = useState<ReviewAction>('approve')
  const [comment, setComment] = useState('')
  const openReview = (row: TeamLeaveRequest, a: ReviewAction) => {
    setActive(row); setAction(a); setComment('')
  }
  const closeReview = () => setActive(null)

  // ── Deep link: ?request=<id>[&action=approve|reject] ───────────────────
  const requestParam = searchParams.get('request')
  const actionParam = searchParams.get('action')
  const [highlight, setHighlight] = useState<string | null>(null)
  const consumed = useRef<string | null>(null)
  const clearParams = () => router.replace('/team/leave', { scroll: false })

  useEffect(() => {
    if (!requestParam || pending.isLoading) return
    const key = `${requestParam}:${actionParam ?? ''}`
    if (consumed.current === key) return
    consumed.current = key
    const row = pendingRows.find((r) => r.id === requestParam)
    if (!row) {
      // Already decided, not in this reviewer's scope, or a stale link.
      toast({
        title: 'That request isn’t waiting on you',
        description: 'It may already be reviewed, or it belongs to another manager’s team.',
      })
      clearParams()
      return
    }
    setTab('pending')
    setHighlight(row.id)
    if (actionParam === 'approve' || actionParam === 'reject') openReview(row, actionParam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestParam, actionParam, pending.isLoading, pendingRows])

  useEffect(() => {
    if (!highlight) return
    const el = document.querySelector<HTMLElement>(`[data-request-id="${highlight}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlight, tab])

  const submitReview = async () => {
    if (!active) return
    try {
      await review.mutateAsync({ id: active.id, action, comment: comment.trim() || undefined })
      toast({
        title: action === 'approve'
          ? `Approved — ${active.employeeName} notified`
          : `Rejected — ${active.employeeName} notified`,
      })
      closeReview()
      setHighlight(null)
      if (requestParam) clearParams()
    } catch (e) {
      toast({
        title: 'Could not record review',
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const kpis = useMemo(() => {
    const total = pendingRows.length
    const totalDays = pendingRows.reduce((sum, r) => sum + (Number(r.totalDays) || 0), 0)
    const employees = new Set(pendingRows.map((r) => r.employeeId)).size
    return { total, totalDays, employees }
  }, [pendingRows])

  const rows = tab === 'pending' ? pendingRows : tab === 'upcoming' ? upcomingRows : historyRows

  // Seed presence for the faces on screen; the socket keeps the dots live.
  usePresence(
    useMemo(
      () => rows.map((r) => r.employeeUserId).filter((id): id is string => !!id),
      [rows],
    ),
  )

  const loading = tab === 'pending' ? pending.isLoading : tab === 'upcoming' ? upcoming.isLoading : history.isLoading
  const errored = tab === 'pending' ? pending.isError : tab === 'upcoming' ? upcoming.isError : history.isError
  const refetch = tab === 'pending' ? pending.refetch : tab === 'upcoming' ? upcoming.refetch : history.refetch

  const empty = {
    pending: ['No pending leave', 'You’re all caught up. New requests from your team will appear here.'],
    upcoming: ['Nothing upcoming', 'Approved leave that hasn’t ended yet will show here.'],
    history: ['No history yet', 'Decisions from the last 90 days will show here.'],
  }[tab]

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Team leave"
          sub={scope === 'org' ? 'Leave requests across the workspace' : 'Leave requests from your direct reports'}
          right={
            <Link href="/inbox?tab=approvals" style={{ textDecoration: 'none' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.inbox size={13} />}>Full Inbox</Btn>
            </Link>
          }
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 18 }}>
          <Kpi label="Pending requests" value={kpis.total.toString()} icon={<Icon.inbox size={14} />} accent="yellow" />
          <Kpi label="Total days requested" value={kpis.totalDays.toFixed(1)} icon={<Icon.cal size={14} />} accent="purple" />
          <Kpi label="Employees affected" value={kpis.employees.toString()} icon={<Icon.people size={14} />} accent="blue" />
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 10, marginBottom: 14, width: 'fit-content' }} data-testid="team-leave-tabs">
          {([['pending', 'Pending'], ['upcoming', 'Upcoming'], ['history', 'History']] as Array<[Tab, string]>).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)} data-testid={`team-leave-tab-${k}`} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800 }}>
              {l}
              {k === 'pending' && pendingRows.length > 0 && <span style={{ marginLeft: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--yellow)' }}>{pendingRows.length}</span>}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="card" style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : errored ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)', fontSize: 13, fontWeight: 600 }}>
            Couldn’t load team leave. <Btn kind="secondary" size="sm" onClick={() => void refetch()} style={{ marginLeft: 8 }}>Retry</Btn>
          </div>
        ) : rows.length === 0 ? (
          <div className="card" style={{ padding: 60, textAlign: 'center', color: 'var(--text-mute)', fontSize: 13, fontWeight: 600 }} data-testid="team-leave-empty">
            <Icon.cal size={28} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
            <div style={{ fontSize: 14, fontWeight: 800, color: '#fff', marginBottom: 6 }}>{empty[0]}</div>
            <div>{empty[1]}</div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid={`team-leave-table-${tab}`}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                  <th style={th}>Employee</th>
                  <th style={th}>Type</th>
                  <th style={th}>Dates</th>
                  <th style={th}>Days</th>
                  <th style={th}>{tab === 'pending' ? 'Applied' : 'Decided'}</th>
                  <th style={th}>Status</th>
                  <th style={th}>{tab === 'pending' ? 'Reason' : 'Reviewer'}</th>
                  {tab === 'pending' && <th style={{ ...th, textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i, arr) => (
                  <tr
                    key={r.id}
                    data-request-id={r.id}
                    data-testid={`team-leave-row-${r.id}`}
                    className="pm-row"
                    style={{
                      borderBottom: i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                      background: highlight === r.id ? 'rgba(62,123,250,.10)' : undefined,
                      boxShadow: highlight === r.id ? 'inset 3px 0 0 var(--blue)' : undefined,
                      transition: 'background .3s',
                    }}
                  >
                    <td style={{ padding: '12px 14px' }}>
                      <div className="flex items-center gap-3">
                        <RowPresenceAvatar
                          name={r.employeeName}
                          src={r.avatarUrl ?? null}
                          userId={r.employeeUserId}
                          size={30}
                        />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>{r.employeeName}</div>
                          {r.employeeCode && <div style={{ fontSize: 11, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>{r.employeeCode}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <Pill tone={typePillTone(r.leaveTypeCode)}>{r.leaveTypeName ?? '—'}</Pill>
                    </td>
                    <td style={td}>{fmtRange(r.startDate, r.endDate)}{r.isHalfDay ? ' · ½' : ''}</td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{r.totalDays}</td>
                    <td style={{ ...td, fontSize: 11, color: 'var(--text-mute)' }}>
                      {tab === 'pending' ? fmtStamp(r.appliedAt) : fmtStamp(r.approvedAt ?? r.rejectedAt ?? r.cancelledAt)}
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {statusPill(r.status)}
                        {r.status === 'pending' && (
                          <EscalationPill
                            escalation={r.escalation ?? null}
                            routedToMe={r.routedToMe ?? true}
                            managerName={r.managerName ?? null}
                            anchorAt={r.appliedAt}
                          />
                        )}
                      </div>
                    </td>
                    <td style={{ ...td, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(tab === 'pending' ? r.reason : r.approverComment) ?? undefined}>
                      {tab === 'pending' ? (r.reason ?? '—') : (
                        <span>
                          {r.approverName ?? '—'}
                          {r.approverComment && <span style={{ color: 'var(--text-mute)' }}> · {r.approverComment}</span>}
                        </span>
                      )}
                    </td>
                    {tab === 'pending' && (
                      <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                        <div className="flex justify-end gap-2 pm-row-acts">
                          <Btn kind="ghost" size="sm" onClick={() => openReview(r, 'reject')} disabled={review.isPending}>Reject</Btn>
                          <Btn kind="primary" size="sm" onClick={() => openReview(r, 'approve')} disabled={review.isPending}>Approve</Btn>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ReviewLeaveDialog
        request={active}
        action={action}
        comment={comment}
        setComment={setComment}
        isPending={review.isPending}
        onSubmit={() => void submitReview()}
        onClose={() => { closeReview(); if (requestParam) clearParams() }}
      />
    </div>
  )
}

/**
 * One confirming click for every decision. Reached from the row buttons and
 * from the emailed Approve/Reject links (preset action) — the link alone
 * never changes anything.
 */
function ReviewLeaveDialog({ request, action, comment, setComment, isPending, onSubmit, onClose }: {
  request: TeamLeaveRequest | null
  action: ReviewAction
  comment: string
  setComment: (v: string) => void
  isPending: boolean
  onSubmit: () => void
  onClose: () => void
}) {
  if (!request) return null
  const approve = action === 'approve'
  return (
    <Modal
      open
      onClose={isPending ? () => {} : onClose}
      width={460}
      title={approve ? 'Approve leave' : 'Reject leave'}
      sub={`${request.employeeName} · ${request.leaveTypeName ?? 'Leave'} · ${fmtRange(request.startDate, request.endDate)} · ${request.totalDays} day${Number(request.totalDays) === 1 ? '' : 's'}`}
      footer={<>
        <Btn kind="ghost" onClick={onClose} disabled={isPending}>Cancel</Btn>
        <Btn kind={approve ? 'primary' : 'danger'} icon={approve ? <Icon.check size={14} /> : <Icon.x size={14} />} onClick={onSubmit} disabled={isPending} data-testid="review-leave-confirm">
          {isPending ? 'Saving…' : approve ? 'Approve' : 'Reject'}
        </Btn>
      </>}
    >
      {request.routedToMe === false && (
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginBottom: 10 }} data-testid="review-leave-on-behalf">
          This request is with {request.managerName?.trim() || 'the reporting manager'} — deciding it here records you as the approver, and they&apos;ll be told.
        </p>
      )}
      {request.reason && (
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', padding: '10px 12px', borderRadius: 10, background: 'var(--surf-1)', border: '1px solid var(--bord)', marginBottom: 14 }}>
          <span style={{ color: 'var(--text-mute)' }}>Reason · </span>{request.reason}
        </div>
      )}
      <div className="label">Comment <span style={{ color: 'var(--text-faint)' }}>· optional, the employee sees it</span></div>
      <textarea
        className="input"
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={500}
        placeholder={approve ? 'Enjoy the break…' : 'Coverage gap that week — could you move it?'}
        style={{ width: '100%', padding: 10, fontSize: 12.5, lineHeight: 1.5, resize: 'none' }}
        autoFocus
      />
      <div className="t-caption" style={{ marginTop: 10 }}>
        {approve ? 'Approving books the days off and updates the team calendar.' : 'Rejecting releases the days back to their balance.'} The employee is notified either way.
      </div>
    </Modal>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '10px 14px', fontSize: 11.5, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-mute)',
}
const td: React.CSSProperties = { padding: '12px 14px', fontSize: 12.5, color: 'var(--text-2)' }
