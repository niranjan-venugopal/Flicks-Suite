'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { api } from '@/lib/api/client'
import {
  useAdminOverview,
  type AdminOverview,
  type ApprovalEscalation,
  type PendingTimesheetRow,
} from '@/lib/api/queries/use-dashboard'
import { useReviewLeave } from '@/lib/api/queries/use-leave'
import { useReviewRegularization } from '@/lib/api/queries/use-attendance'
import { useReviewTimesheet } from '@/lib/api/queries/use-timesheets'
import {
  useApproveOnboarding,
  useRejectOnboarding,
} from '@/lib/api/queries/use-employees'
import { Btn, Icon, Pill, type PillTone } from '@/components/proto'
import { EscalationPill } from '@/components/approvals/EscalationPill'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { usePresence } from '@/lib/api/queries/use-presence'
import { useToast } from '@/components/ui/use-toast'

// ─────────────────────────────────────────────────────────
// Approvals tab of the common Inbox (approver roles only): the leave +
// regularization + timesheet review queue — filter pills, master–detail
// list, comment box, approve/reject (+ rework for timesheets).
// Round K: `focusId` (from /inbox?tab=approvals&request=<id>) pre-selects
// and highlights that row once the queue loads — the Round I idiom from
// Team → Leave. The source stays the overview, now up to 50 rows per kind.
// Round L: only ROUTED items are listed (direct reports, escalated to me,
// level 2 for owner/HR admin) with the escalation pill; timesheets join the
// queue; a deep link to a regularization that is not in the queue falls
// back to GET /attendance/regularizations/:id (the "open directly" surface
// for owner/HR admin) before the "not waiting on you" toast.
// ─────────────────────────────────────────────────────────

type FilterKey = 'all' | 'leave' | 'regularization' | 'timesheet' | 'onboarding'
type ReviewAction = 'approve' | 'reject' | 'rework'

/** Presence batch cap — the ids travel in a GET query string. */
const PRESENCE_MAX_IDS = 40
/** How long the deep-linked row keeps its ring. */
const HIGHLIGHT_MS = 2500

/** Browser-local clock time — the same zone the requester typed it in. */
function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

type LeaveRow = AdminOverview['pending']['leaves'][number]
type RegularizationRow = AdminOverview['pending']['regularizations'][number]
type OnboardingRow = AdminOverview['pending']['onboarding'][number]

interface InboxItem {
  kind: 'leave' | 'regularization' | 'timesheet' | 'onboarding'
  id: string
  who: string
  userId: string | null
  /** Signed avatar URL from the API; falls back to initials when null. */
  avatarUrl: string | null
  what: string
  when: string
  reason: string | null
  tone: PillTone
  /** Round L — null while the item is still with the reporting manager. */
  escalation: ApprovalEscalation | null
  raw: LeaveRow | RegularizationRow | PendingTimesheetRow | OnboardingRow
}

function relativeTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'yesterday' : `${d}d ago`
}

function fmtRange(start: string, end: string): string {
  if (start === end) return new Date(start).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  const s = new Date(start).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  const e = new Date(end).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  return `${s} – ${e}`
}

function regularizationItem(r: RegularizationRow): InboxItem {
  return {
    kind: 'regularization',
    id: r.id,
    who: r.employeeName,
    userId: r.userId,
    avatarUrl: r.avatarUrl,
    what: `${r.requestType} · ${r.attendanceDate}`,
    when: relativeTime(r.requestedAt),
    reason: r.reason,
    tone: 'coral',
    escalation: r.escalation ?? null,
    raw: r,
  }
}

function buildItems(o: AdminOverview | undefined): InboxItem[] {
  if (!o) return []
  const items: InboxItem[] = []
  for (const l of o.pending.leaves) {
    items.push({
      kind: 'leave',
      id: l.id,
      who: l.employeeName,
      userId: l.userId,
      avatarUrl: l.avatarUrl,
      what: `${l.leaveTypeCode ?? l.leaveTypeName ?? 'Leave'} · ${l.totalDays}d (${fmtRange(l.startDate, l.endDate)})`,
      when: relativeTime(l.appliedAt),
      reason: l.reason,
      tone: 'blue',
      escalation: l.escalation ?? null,
      raw: l,
    })
  }
  for (const r of o.pending.regularizations) items.push(regularizationItem(r))
  // Round L: submitted timesheets routed to the caller (Approve / Reject /
  // Rework). Absent until the dashboard integration ships the rows.
  for (const t of o.pending.timesheets ?? []) {
    items.push({
      kind: 'timesheet',
      id: t.id,
      who: t.employeeName,
      userId: t.userId,
      avatarUrl: t.avatarUrl,
      what: `Week ${fmtRange(t.periodStart, t.periodEnd)} · ${Number(t.totalHours).toFixed(1)}h`,
      when: relativeTime(t.submittedAt),
      reason: null,
      tone: 'purple',
      escalation: t.escalation ?? null,
      raw: t,
    })
  }
  // Onboarding reviews (admin+ only; the API returns an empty list for
  // other roles and never includes the viewer's own row). Round 18: an HR
  // admin's own file is filtered out too unless the viewer is an owner.
  for (const ob of o.pending.onboarding ?? []) {
    items.push({
      kind: 'onboarding',
      id: ob.employeeId,
      who: ob.employeeName || 'New joiner',
      userId: ob.userId,
      avatarUrl: ob.avatarUrl,
      what:
        [ob.designationTitle, ob.employeeCode].filter(Boolean).join(' · ') ||
        'Onboarding review',
      when: relativeTime(ob.submittedAt),
      reason: null,
      tone: 'yellow',
      escalation: null,
      raw: ob,
    })
  }
  return items
}

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  leave: 'Leave',
  regularization: 'Regularize',
  timesheet: 'Timesheet',
  onboarding: 'Onboarding',
}

export function ApprovalsTab({
  focusId,
  onFocusConsumed,
}: {
  /** Request id from the deep link; selected + highlighted once loaded. */
  focusId?: string | null
  /** Called when the focused row is gone, or once it has been decided — the page scrubs the URL. */
  onFocusConsumed?: () => void
}) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [exiting, setExiting] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  // Round L: a regularization opened DIRECTLY (owner/HR admin deep link to a
  // request that is still with the manager) — merged into the list.
  const [directItem, setDirectItem] = useState<InboxItem | null>(null)
  const consumed = useRef<string | null>(null)
  const qc = useQueryClient()
  const overview = useAdminOverview(true, { pendingLimit: 50 })
  const { toast } = useToast()
  const reviewLeave = useReviewLeave()
  const reviewReg = useReviewRegularization()
  const reviewTimesheet = useReviewTimesheet()
  const approveOnb = useApproveOnboarding()
  const rejectOnb = useRejectOnboarding()

  const items = useMemo(() => {
    const base = buildItems(overview.data)
    if (directItem && !base.some((i) => i.id === directItem.id)) return [directItem, ...base]
    return base
  }, [overview.data, directItem])
  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  )
  // D9 — seed the presence batch once so inbox rows show the status dot.
  // Capped to the first rendered ids: the batch is a GET query string.
  const presenceIds = useMemo(
    () =>
      Array.from(
        new Set(filtered.map((i) => i.userId).filter((id): id is string => !!id)),
      ).slice(0, PRESENCE_MAX_IDS),
    [filtered],
  )
  usePresence(presenceIds)

  const counts = {
    all: items.length,
    leave: items.filter((i) => i.kind === 'leave').length,
    regularization: items.filter((i) => i.kind === 'regularization').length,
    timesheet: items.filter((i) => i.kind === 'timesheet').length,
    onboarding: items.filter((i) => i.kind === 'onboarding').length,
  }

  const selected = filtered.find((i) => i.id === selectedId) ?? filtered[0] ?? null

  const refresh = () => qc.invalidateQueries({ queryKey: ['dashboard'] })

  // A deep link is judged only against data fetched AFTER it arrived: the
  // cached overview (staleTime 30 s, HTTP max-age 15 s) predates the very
  // request the notification is about, and a stale miss would toast "not
  // waiting on you" for a request that IS waiting.
  const focusArrivedAt = useRef(0)
  useEffect(() => {
    if (!focusId) return
    focusArrivedAt.current = Date.now()
    void overview.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  // ── Deep link: select the requested row once the queue has loaded ──────
  useEffect(() => {
    if (!focusId) {
      // URL scrubbed — the same id can be focused again by a later click.
      consumed.current = null
      return
    }
    if (!overview.data) return
    if (consumed.current === focusId) return
    if (overview.isFetching || overview.dataUpdatedAt < focusArrivedAt.current) return
    consumed.current = focusId
    const row = items.find((i) => i.id === focusId)
    if (row) {
      setFilter('all')
      setSelectedId(row.id)
      setHighlight(row.id)
      return
    }
    // Round L: not in the routed queue — an owner/HR admin may still open a
    // regularization DIRECTLY (it is with the manager, not escalated yet).
    // The route lands in Phase 2; a 404 (route missing, decided, or not
    // ours) falls through to the toast exactly as today.
    void (async () => {
      try {
        const direct = await api.get<RegularizationRow>(
          `/api/v1/attendance/regularizations/${encodeURIComponent(focusId)}`,
        )
        if (direct && direct.id === focusId && direct.employeeId) {
          const item = regularizationItem(direct)
          setDirectItem(item)
          setFilter('all')
          setSelectedId(item.id)
          setHighlight(item.id)
          return
        }
      } catch {
        /* 404 / not permitted → not waiting on us */
      }
      // Already decided, not in this reviewer's scope, or a stale link.
      toast({
        title: 'That request isn’t waiting on you',
        description: 'It may already be reviewed, or it belongs to another manager’s team.',
      })
      onFocusConsumed?.()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, overview.data, overview.isFetching, overview.dataUpdatedAt, items])

  useEffect(() => {
    if (!highlight) return
    document
      .querySelector<HTMLElement>(`[data-request-id="${highlight}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
    return () => clearTimeout(t)
  }, [highlight])

  const handleAction = async (action: ReviewAction) => {
    if (!selected) return
    const who = selected.who
    // Timesheets: reject and rework need a note the employee can act on
    // (the API refuses without one) — say so before the row slides out.
    if (selected.kind === 'timesheet' && action !== 'approve' && !comment.trim()) {
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
    // Slide the row out first (160ms) so the list settles before the refetch.
    setExiting(selected.id)
    await new Promise((r) => setTimeout(r, 170))
    try {
      if (selected.kind === 'leave') {
        await reviewLeave.mutateAsync({
          id: selected.id,
          action: action === 'approve' ? 'approve' : 'reject',
          comment: comment || undefined,
        })
      } else if (selected.kind === 'regularization') {
        await reviewReg.mutateAsync({
          id: selected.id,
          action: action === 'approve' ? 'approve' : 'reject',
          comment: comment || undefined,
        })
      } else if (selected.kind === 'timesheet') {
        await reviewTimesheet.mutateAsync({ periodId: selected.id, action, comment: comment.trim() || undefined })
      } else if (action === 'approve') {
        await approveOnb.mutateAsync(selected.id)
      } else {
        // "Send back" — the comment doubles as the reason the joiner sees.
        await rejectOnb.mutateAsync({ id: selected.id, reason: comment || undefined })
      }
      setComment('')
      setSelectedId(null)
      setExiting(null)
      setHighlight(null)
      if (directItem?.id === selected.id) setDirectItem(null)
      // The deep-linked request is decided — drop `?request=` from the URL.
      if (focusId && selected.id === focusId) onFocusConsumed?.()
      refresh()
      // Decisions notify the requester, so this is feedback rather than a
      // rollback handle — the toast states plainly what the other side saw.
      toast({
        title:
          selected.kind === 'onboarding'
            ? action === 'approve'
              ? `Approved — ${who}'s profile is now active`
              : `Sent back to ${who} for changes`
            : action === 'approve'
              ? `Approved — ${who} notified`
              : action === 'rework'
                ? `Sent back to ${who} for rework`
                : `Rejected — ${who} notified`,
      })
    } catch (e) {
      setExiting(null)
      // The API's refusals are written for people ("You can only review
      // requests from your direct reports…", "A comment is required…") —
      // show them instead of silently putting the row back.
      toast({
        title: 'Could not record review',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div>
      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {[
          { k: 'all' as const, l: 'All', c: counts.all },
          { k: 'leave' as const, l: 'Leave', c: counts.leave },
          { k: 'regularization' as const, l: 'Regularization', c: counts.regularization },
          { k: 'timesheet' as const, l: 'Timesheets', c: counts.timesheet },
          { k: 'onboarding' as const, l: 'Onboarding', c: counts.onboarding },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setFilter(t.k)}
            type="button"
            data-testid={`approvals-filter-${t.k}`}
            style={{
              padding: '8px 14px',
              borderRadius: 99,
              border: '1px solid ' + (filter === t.k ? 'var(--bord-3)' : 'var(--bord)'),
              background: filter === t.k ? 'var(--surf-3)' : 'var(--surf-1)',
              color: filter === t.k ? '#fff' : 'var(--text-2)',
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
              display: 'flex',
              gap: 7,
              alignItems: 'center',
            }}
          >
            {t.l}
            <span style={{ fontWeight: 800, color: 'var(--text-faint)' }}>{t.c}</span>
          </button>
        ))}
      </div>

      {overview.isLoading ? (
        <div
          className="card"
          style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--text-mute)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <Loader2 className="w-4 h-4 animate-spin" /> Loading inbox…
        </div>
      ) : overview.isError ? (
        <div
          className="card"
          style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--text-mute)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <div style={{ marginBottom: 12 }}>Couldn’t load your approvals.</div>
          <Btn kind="secondary" size="sm" onClick={() => void overview.refetch()}>
            Retry
          </Btn>
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="card"
          style={{
            padding: 60,
            textAlign: 'center',
            color: 'var(--text-mute)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          All caught up. No {filter === 'all' ? '' : filter + ' '}requests waiting on you.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: 18 }}>
          {/* List */}
          <div
            className="card"
            style={{
              padding: 0,
              overflow: 'hidden',
              height: 'fit-content',
              maxHeight: 'calc(100vh - 280px)',
              overflowY: 'auto',
            }}
          >
            {filtered.map((a, i) => {
              const isActive = selected?.id === a.id
              return (
                <button
                  key={a.id}
                  type="button"
                  data-request-id={a.id}
                  data-kind={a.kind}
                  aria-selected={isActive}
                  onClick={() => setSelectedId(a.id)}
                  className={exiting === a.id ? 'pm-exit-right pm-row' : 'pm-row'}
                  style={{
                    padding: '14px 18px',
                    borderBottom: i < filtered.length - 1 ? '1px solid var(--bord)' : 'none',
                    display: 'flex',
                    gap: 12,
                    cursor: 'pointer',
                    position: 'relative',
                    background: isActive ? 'var(--surf-2)' : 'transparent',
                    boxShadow: highlight === a.id ? 'inset 0 0 0 1px var(--blue)' : undefined,
                    transition: 'box-shadow 200ms',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    color: 'inherit',
                  }}
                >
                  {isActive && (
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 8,
                        bottom: 8,
                        width: 3,
                        borderRadius: '0 3px 3px 0',
                        background: 'var(--blue)',
                      }}
                    />
                  )}
                  <RowPresenceAvatar name={a.who} src={a.avatarUrl} userId={a.userId} size={26} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 800 }}>{a.who}</span>
                      <Pill tone={a.tone}>{KIND_LABEL[a.kind]}</Pill>
                      {/* Round L: everything listed here is routed to the caller. */}
                      <EscalationPill escalation={a.escalation} routedToMe />
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 2 }}>
                      {a.what}
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)' }}>
                      {a.when} · {a.id.slice(0, 8)}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Detail */}
          {selected ? (
            <ApprovalDetail
              item={selected}
              comment={comment}
              onCommentChange={setComment}
              onApprove={() => handleAction('approve')}
              onReject={() => handleAction('reject')}
              onRework={selected.kind === 'timesheet' ? () => handleAction('rework') : undefined}
              isPending={
                reviewLeave.isPending ||
                reviewReg.isPending ||
                reviewTimesheet.isPending ||
                approveOnb.isPending ||
                rejectOnb.isPending
              }
            />
          ) : (
            <div
              className="card"
              style={{ padding: 60, textAlign: 'center', color: 'var(--text-mute)' }}
            >
              Select a request from the list to review it.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Detail panel ──────────────────────────────────────────────────────────

function ApprovalDetail({
  item,
  comment,
  onCommentChange,
  onApprove,
  onReject,
  onRework,
  isPending,
}: {
  item: InboxItem
  comment: string
  onCommentChange: (s: string) => void
  onApprove: () => void
  onReject: () => void
  /** Timesheets only — reopen the week as a draft with a required note. */
  onRework?: () => void
  isPending: boolean
}) {
  const commentRequired = item.kind === 'timesheet'
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', height: 'fit-content' }}>
      <div
        style={{
          padding: '18px 22px',
          borderBottom: '1px solid var(--bord)',
          display: 'flex',
          gap: 14,
          alignItems: 'flex-start',
        }}
      >
        <RowPresenceAvatar name={item.who} src={item.avatarUrl} userId={item.userId} size={48} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <Pill tone={item.tone}>{item.kind.toUpperCase()}</Pill>
            <Pill>{item.id.slice(0, 8)}</Pill>
            <EscalationPill escalation={item.escalation} routedToMe />
          </div>
          <div className="t-h2" style={{ fontSize: 18 }}>
            {item.who}
          </div>
          <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
            {item.what} · {item.when}
          </div>
        </div>
        <Btn kind="ghost" size="sm" icon={<Icon.more size={14} />} />
      </div>

      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {item.reason && <Field label="Reason" value={item.reason} />}

        {item.kind === 'leave' && (() => {
          const l = item.raw as LeaveRow
          return (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Field label="Leave type" value={l.leaveTypeName ?? l.leaveTypeCode ?? '—'} />
                <Field label="Days requested" value={`${l.totalDays}`} />
              </div>
              <div>
                <div className="t-caption" style={{ marginBottom: 8 }}>
                  Leave dates
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div
                    style={{
                      padding: '6px 10px',
                      background: 'var(--surf-2)',
                      border: '1px solid var(--bord-2)',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {fmtRange(l.startDate, l.endDate)}
                  </div>
                </div>
              </div>
            </>
          )
        })()}

        {item.kind === 'onboarding' && (() => {
          const ob = item.raw as OnboardingRow
          return (
            <>
              <div
                style={{
                  padding: '14px',
                  background: 'rgba(255,199,89,.06)',
                  border: '1px solid rgba(255,199,89,.25)',
                  borderRadius: 10,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--text-2)',
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: '#fff' }}>{item.who}</strong> finished
                self-onboarding and is waiting for approval. Approving activates
                their profile; &ldquo;Send back&rdquo; returns it for changes
                (your comment becomes the reason they see).
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Field label="Designation" value={ob.designationTitle ?? '—'} />
                <Field label="Employee code" value={ob.employeeCode ?? '—'} />
              </div>
              <Link
                href={`/employees/onboarding?employee=${ob.employeeId}`}
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: 'var(--blue)',
                  textDecoration: 'none',
                }}
              >
                Review submitted details →
              </Link>
            </>
          )
        })()}

        {item.kind === 'regularization' && (() => {
          const r = item.raw as RegularizationRow
          const firstName = item.who.trim().split(/\s+/)[0] || 'this employee'
          const hasProposed = !!(r.proposedInTime || r.proposedOutTime)
          return (
            <>
              <div
                style={{
                  padding: '14px',
                  background: 'rgba(248,120,107,.06)',
                  border: '1px solid rgba(248,120,107,.25)',
                  borderRadius: 10,
                  display: 'flex',
                  gap: 10,
                }}
              >
                <Icon.pin
                  size={16}
                  style={{ color: 'var(--coral)', marginTop: 1, flexShrink: 0 }}
                />
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-2)',
                    lineHeight: 1.5,
                  }}
                >
                  {r.requestType.replaceAll('_', ' ')} request for{' '}
                  <strong style={{ color: '#fff' }}>{r.attendanceDate}</strong>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Field label="Type" value={r.requestType.replaceAll('_', ' ')} />
                <Field label="Date" value={r.attendanceDate} />
              </div>
              {/* Approving writes these into the attendance record. */}
              {hasProposed && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <Field label="Proposed in" value={<span style={{ fontFamily: 'var(--font-mono)' }}>{fmtTime(r.proposedInTime)}</span>} />
                  <Field label="Proposed out" value={<span style={{ fontFamily: 'var(--font-mono)' }}>{fmtTime(r.proposedOutTime)}</span>} />
                </div>
              )}
              <Link
                href={`/employees/${r.employeeId}?tab=attendance`}
                data-testid="view-attendance-link"
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: 'var(--blue)',
                  textDecoration: 'none',
                }}
              >
                View {firstName}&apos;s attendance →
              </Link>
            </>
          )
        })()}

        {item.kind === 'timesheet' && (() => {
          const t = item.raw as PendingTimesheetRow
          const billable = Number(t.totalBillableHours ?? 0)
          const total = Number(t.totalHours ?? 0)
          return (
            <>
              <div
                style={{
                  padding: '14px',
                  background: 'rgba(167,139,250,.06)',
                  border: '1px solid rgba(167,139,250,.25)',
                  borderRadius: 10,
                  display: 'flex',
                  gap: 10,
                }}
              >
                <Icon.sheet size={16} style={{ color: 'var(--purple)', marginTop: 1, flexShrink: 0 }} />
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
                  Week of <strong style={{ color: '#fff' }}>{t.periodStart}</strong> submitted for review.
                  Approving confirms the hours; &ldquo;Rework&rdquo; reopens the week as a draft
                  (your note tells them what to change); rejecting closes it.
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
                <Field label="Week" value={`${t.periodStart} – ${t.periodEnd}`} />
                <Field label="Total hours" value={<span style={{ fontFamily: 'var(--font-mono)' }}>{total.toFixed(1)}h</span>} />
                <Field label="Billable" value={<span style={{ fontFamily: 'var(--font-mono)' }}>{billable.toFixed(1)}h</span>} />
              </div>
              <Link
                href={`/team/timesheets?period=${encodeURIComponent(t.id)}`}
                data-testid="view-timesheet-link"
                style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}
              >
                Open in Team → Timesheets →
              </Link>
            </>
          )
        })()}

        <div>
          <div className="t-caption" style={{ marginBottom: 8 }}>
            Add a comment{' '}
            <span
              style={{
                color: 'var(--text-faint)',
                textTransform: 'none',
                letterSpacing: 0,
              }}
            >
              {commentRequired ? '(required to reject or send back for rework)' : '(optional)'}
            </span>
          </div>
          <textarea
            className="input"
            style={{ height: 80, padding: 12, resize: 'none' }}
            placeholder={commentRequired ? 'What should the employee change, or why is it rejected?' : 'A note for the requester…'}
            value={comment}
            onChange={(e) => onCommentChange(e.target.value)}
            data-testid="approval-comment"
          />
        </div>
      </div>

      <div
        style={{
          padding: '14px 22px',
          borderTop: '1px solid var(--bord)',
          display: 'flex',
          gap: 10,
          background: 'var(--surf-1)',
        }}
      >
        <Btn kind="danger" icon={<Icon.x size={14} />} onClick={onReject} disabled={isPending} data-testid="approval-reject">
          {item.kind === 'onboarding' ? 'Send back' : 'Reject'}
        </Btn>
        {onRework && (
          <Btn kind="secondary" icon={<Icon.arrowL size={14} />} onClick={onRework} disabled={isPending} data-testid="approval-rework">
            Rework
          </Btn>
        )}
        <div style={{ flex: 1 }} />
        <Btn kind="primary" icon={<Icon.check size={14} />} onClick={onApprove} disabled={isPending} data-testid="approval-approve">
          Approve
        </Btn>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="t-caption" style={{ marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{value}</div>
    </div>
  )
}
