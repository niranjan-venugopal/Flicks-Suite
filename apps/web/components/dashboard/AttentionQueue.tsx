'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { Avatar, Btn, Icon, Pill, SectionHead, type PillTone } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import type { AdminOverview } from '@/lib/api/queries/use-dashboard'
import { useReviewLeave } from '@/lib/api/queries/use-leave'
import { useReviewRegularization } from '@/lib/api/queries/use-attendance'
import { useReviewTimesheet } from '@/lib/api/queries/use-timesheets'
import { useApproveOnboarding } from '@/lib/api/queries/use-employees'

/**
 * Round R — "Needs your attention" (Owner / HR dashboard) and the manager's
 * "Approvals queue", one component.
 *
 * What was wrong with several items waiting (founder, 2026-10-07):
 *  - the API answer was browser-cached for 15 s, so after Approve the row
 *    stayed and a second click answered "Cannot review an approved request"
 *    (fixed server-side with `no-store`; here the row leaves the list the
 *    moment the server confirms, before any refetch);
 *  - one click disabled every row's buttons (shared `isPending`) — now each
 *    row has its own busy state;
 *  - the list only ever held leaves + regularizations while the header
 *    counted timesheets and onboarding too, so "All caught up" could sit
 *    under "4 items waiting" — every kind is listed, newest first, and the
 *    totals come from the server, not from the rows shown.
 */

export type AttentionKind = 'leave' | 'regularization' | 'timesheet' | 'onboarding'

export interface AttentionItem {
  kind: AttentionKind
  id: string
  who: string
  what: string
  /** ISO instant the request was made — the sort key. */
  at: string | null
  tone: PillTone
  avatarUrl: string | null
}

const KIND_LABEL: Record<AttentionKind, string> = {
  leave: 'Leave',
  regularization: 'Regularize',
  timesheet: 'Timesheet',
  onboarding: 'Onboarding',
}

function fmtRange(start: string, end: string): string {
  const f = (d: string) => new Date(d).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  return start === end ? f(start) : `${f(start)} – ${f(end)}`
}

function relativeTime(iso: string | null | undefined): string {
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

/** Every pending item the overview lists, every kind, newest first. */
export function buildAttentionList(o: AdminOverview | undefined): AttentionItem[] {
  if (!o) return []
  const items: AttentionItem[] = []
  for (const l of o.pending.leaves ?? []) {
    items.push({
      kind: 'leave',
      id: l.id,
      who: l.employeeName,
      what: `${l.leaveTypeCode ?? l.leaveTypeName ?? 'Leave'} · ${l.totalDays}d (${fmtRange(l.startDate, l.endDate)})`,
      at: l.appliedAt ?? null,
      tone: 'blue',
      avatarUrl: l.avatarUrl ?? null,
    })
  }
  for (const r of o.pending.regularizations ?? []) {
    items.push({
      kind: 'regularization',
      id: r.id,
      who: r.employeeName,
      what: `${r.requestType.replaceAll('_', ' ')} · ${fmtRange(r.attendanceDate, r.attendanceDate)}`,
      at: r.requestedAt ?? null,
      tone: 'coral',
      avatarUrl: r.avatarUrl ?? null,
    })
  }
  for (const t of o.pending.timesheets ?? []) {
    items.push({
      kind: 'timesheet',
      id: t.id,
      who: t.employeeName,
      what: `${fmtRange(t.periodStart, t.periodEnd)} · ${t.totalHours}h`,
      at: t.submittedAt ?? null,
      tone: 'purple',
      avatarUrl: t.avatarUrl ?? null,
    })
  }
  for (const ob of o.pending.onboarding ?? []) {
    items.push({
      kind: 'onboarding',
      id: ob.employeeId,
      who: ob.employeeName || 'New joiner',
      what: [ob.designationTitle, ob.employeeCode].filter(Boolean).join(' · ') || 'Self-onboarding submitted',
      at: ob.submittedAt ?? null,
      tone: 'yellow',
      avatarUrl: ob.avatarUrl ?? null,
    })
  }
  return items.sort((a, b) => (b.at ? new Date(b.at).getTime() : 0) - (a.at ? new Date(a.at).getTime() : 0))
}

/** The server's own count across every kind — what the header and "+N more" quote. */
export function attentionTotal(o: AdminOverview | undefined): number {
  if (!o) return 0
  const p = o.pending
  return (p.leaveCount ?? 0) + (p.regularizationCount ?? 0) + (p.timesheetCount ?? 0) + (p.onboardingCount ?? 0)
}

/** Drop a decided item from every cached overview (dashboard + Inbox variants) and fix the counts. */
function withoutItem(old: AdminOverview | undefined, item: AttentionItem): AdminOverview | undefined {
  if (!old) return old
  const p = { ...old.pending }
  if (item.kind === 'leave') {
    p.leaves = p.leaves.filter((l) => l.id !== item.id)
    p.leaveCount = Math.max(0, p.leaveCount - 1)
  } else if (item.kind === 'regularization') {
    p.regularizations = p.regularizations.filter((r) => r.id !== item.id)
    p.regularizationCount = Math.max(0, p.regularizationCount - 1)
  } else if (item.kind === 'timesheet') {
    p.timesheets = (p.timesheets ?? []).filter((t) => t.id !== item.id)
    p.timesheetCount = Math.max(0, (p.timesheetCount ?? 0) - 1)
  } else {
    p.onboarding = p.onboarding.filter((o) => o.employeeId !== item.id)
    p.onboardingCount = Math.max(0, p.onboardingCount - 1)
  }
  return {
    ...old,
    pending: p,
    stats: { ...old.stats, pendingApprovals: Math.max(0, old.stats.pendingApprovals - 1) },
  }
}

export function AttentionQueue({
  overview,
  variant,
  limit = 5,
}: {
  overview: { data?: AdminOverview; isLoading: boolean }
  variant: 'admin' | 'manager'
  limit?: number
}) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const reviewLeave = useReviewLeave()
  const reviewReg = useReviewRegularization()
  const reviewTimesheet = useReviewTimesheet()
  const approveOnboarding = useApproveOnboarding()
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())

  const items = useMemo(() => buildAttentionList(overview.data), [overview.data])
  const total = attentionTotal(overview.data)
  const shown = items.slice(0, limit)
  const more = Math.max(0, total - shown.length)
  const key = (i: AttentionItem) => `${i.kind}-${i.id}`

  const decide = async (item: AttentionItem, action: 'approve' | 'reject') => {
    const k = key(item)
    if (busy.has(k)) return
    setBusy((prev) => new Set(prev).add(k))
    try {
      if (item.kind === 'leave') await reviewLeave.mutateAsync({ id: item.id, action })
      else if (item.kind === 'regularization') await reviewReg.mutateAsync({ id: item.id, action })
      else if (item.kind === 'timesheet') await reviewTimesheet.mutateAsync({ periodId: item.id, action })
      else await approveOnboarding.mutateAsync(item.id)
      // Gone from the card the moment the server confirmed; the refetch
      // behind it lands on the same state.
      qc.setQueriesData<AdminOverview>({ queryKey: ['dashboard', 'admin', 'overview'] }, (old) =>
        withoutItem(old, item),
      )
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: `${action === 'approve' ? 'Approved' : 'Rejected'} · ${item.who}` })
    } catch (e) {
      // The API message says why (already reviewed, not yours, …); the
      // refetch drops a row that was decided elsewhere meanwhile.
      toast({
        title: action === 'approve' ? 'Could not approve' : 'Could not reject',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(k)
        return next
      })
    }
  }

  const compact = variant === 'manager'
  const empty = shown.length === 0

  const rows = shown.map((a, i) => {
    const k = key(a)
    const rowBusy = busy.has(k)
    return (
      <div
        key={k}
        data-testid="attention-row"
        data-kind={a.kind}
        style={{
          padding: compact ? '10px 0' : '14px 22px',
          borderBottom: i < shown.length - 1 ? '1px solid var(--bord)' : 'none',
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 10 : 14,
          opacity: rowBusy ? 0.6 : 1,
        }}
      >
        <Avatar name={a.who} size="sm" src={a.avatarUrl ?? undefined} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, minWidth: 0 }}>
            <span
              style={{
                fontSize: compact ? 12 : 13,
                fontWeight: 800,
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {a.who}
            </span>
            <Pill tone={a.tone} dot>
              {KIND_LABEL[a.kind]}
            </Pill>
          </div>
          <div
            style={{
              fontSize: compact ? 11 : 12,
              fontWeight: 600,
              color: 'var(--text-2)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {a.what} <span style={{ color: 'var(--text-faint)' }}>· {relativeTime(a.at)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {a.kind === 'onboarding' ? (
            <Link href={`/employees/onboarding?employee=${a.id}`} style={{ textDecoration: 'none' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.eye size={12} />} aria-label="Review" title="Review the submitted details, or send it back" />
            </Link>
          ) : (
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.x size={12} />}
              onClick={() => void decide(a, 'reject')}
              disabled={rowBusy}
              aria-label="Reject"
              title="Reject"
            />
          )}
          <Btn
            kind="primary"
            size="sm"
            icon={<Icon.check size={12} />}
            onClick={() => void decide(a, 'approve')}
            disabled={rowBusy}
            data-testid="attention-approve"
          >
            {compact ? '' : rowBusy ? 'Saving…' : 'Approve'}
          </Btn>
        </div>
      </div>
    )
  })

  const emptyState = (
    <div
      style={{
        padding: compact ? '24px 0' : '40px 22px',
        textAlign: 'center',
        color: 'var(--text-mute)',
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      {overview.isLoading ? 'Loading…' : 'All caught up. No pending approvals.'}
    </div>
  )

  const moreLink = more > 0 && (
    <Link
      href="/inbox?tab=approvals"
      data-testid="attention-more"
      style={{
        display: 'block',
        padding: compact ? '12px 0 0' : '12px 22px',
        background: compact ? 'transparent' : 'var(--surf-1)',
        textAlign: 'center',
        fontSize: 12,
        fontWeight: 800,
        color: 'var(--blue)',
        textDecoration: 'none',
      }}
    >
      + {more} more waiting → open Inbox
    </Link>
  )

  if (compact) {
    return (
      <div className="card" data-testid="attention-queue">
        <SectionHead title="Approvals queue" sub={total > 0 ? `${total} waiting on you` : undefined} />
        {empty ? emptyState : rows}
        {moreLink}
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }} data-testid="attention-queue">
      <div
        style={{
          padding: '18px 22px',
          borderBottom: '1px solid var(--bord)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <div className="t-h3">Needs your attention</div>
          <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }} data-testid="attention-total">
            {total > 0
              ? `${total} ${total === 1 ? 'item' : 'items'} waiting · one-click approve where it's safe`
              : "One-click approve where it's safe"}
          </div>
        </div>
        <Link href="/inbox?tab=approvals" style={{ textDecoration: 'none' }}>
          <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
            Open inbox
          </Btn>
        </Link>
      </div>
      <div>
        {empty ? emptyState : rows}
        {moreLink}
      </div>
    </div>
  )
}
