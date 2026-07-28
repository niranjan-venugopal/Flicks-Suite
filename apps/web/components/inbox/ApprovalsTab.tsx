'use client'

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useAdminOverview, type AdminOverview } from '@/lib/api/queries/use-dashboard'
import { useReviewLeave } from '@/lib/api/queries/use-leave'
import { useReviewRegularization } from '@/lib/api/queries/use-attendance'
import { Btn, Icon, Pill, type PillTone } from '@/components/proto'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { usePresence } from '@/lib/api/queries/use-presence'
import { useToast } from '@/components/ui/use-toast'

// ─────────────────────────────────────────────────────────
// Approvals tab of the common Inbox (approver roles only): the leave +
// regularization review queue — filter pills, master–detail list, comment
// box, approve/reject. Extracted unchanged from the old /inbox page.
// ─────────────────────────────────────────────────────────

type FilterKey = 'all' | 'leave' | 'regularization'

interface InboxItem {
  kind: 'leave' | 'regularization'
  id: string
  who: string
  userId: string | null
  what: string
  when: string
  reason: string | null
  tone: PillTone
  raw:
    | AdminOverview['pending']['leaves'][number]
    | AdminOverview['pending']['regularizations'][number]
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

function buildItems(o: AdminOverview | undefined): InboxItem[] {
  if (!o) return []
  const items: InboxItem[] = []
  for (const l of o.pending.leaves) {
    items.push({
      kind: 'leave',
      id: l.id,
      who: l.employeeName,
      userId: l.userId,
      what: `${l.leaveTypeCode ?? l.leaveTypeName ?? 'Leave'} · ${l.totalDays}d (${fmtRange(l.startDate, l.endDate)})`,
      when: relativeTime(l.appliedAt),
      reason: l.reason,
      tone: 'blue',
      raw: l,
    })
  }
  for (const r of o.pending.regularizations) {
    items.push({
      kind: 'regularization',
      id: r.id,
      who: r.employeeName,
      userId: r.userId,
      what: `${r.requestType} · ${r.attendanceDate}`,
      when: relativeTime(r.requestedAt),
      reason: r.reason,
      tone: 'coral',
      raw: r,
    })
  }
  return items
}

export function ApprovalsTab() {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [exiting, setExiting] = useState<string | null>(null)
  const qc = useQueryClient()
  const overview = useAdminOverview()
  const { toast } = useToast()
  const reviewLeave = useReviewLeave()
  const reviewReg = useReviewRegularization()

  const items = useMemo(() => buildItems(overview.data), [overview.data])
  // D9 — seed the presence batch once so inbox rows show the status dot.
  usePresence(items.map((i) => i.userId).filter((id): id is string => !!id))
  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  )

  const counts = {
    all: items.length,
    leave: items.filter((i) => i.kind === 'leave').length,
    regularization: items.filter((i) => i.kind === 'regularization').length,
  }

  const selected = filtered.find((i) => i.id === selectedId) ?? filtered[0] ?? null

  const refresh = () => qc.invalidateQueries({ queryKey: ['dashboard'] })

  const handleAction = async (action: 'approve' | 'reject') => {
    if (!selected) return
    const who = selected.who
    // Slide the row out first (160ms) so the list settles before the refetch.
    setExiting(selected.id)
    await new Promise((r) => setTimeout(r, 170))
    try {
      if (selected.kind === 'leave') {
        await reviewLeave.mutateAsync({ id: selected.id, action, comment: comment || undefined })
      } else {
        await reviewReg.mutateAsync({ id: selected.id, action, comment: comment || undefined })
      }
      setComment('')
      setSelectedId(null)
      setExiting(null)
      refresh()
      // Decisions notify the requester, so this is feedback rather than a
      // rollback handle — the toast states plainly what the other side saw.
      toast({
        title: action === 'approve' ? `Approved — ${who} notified` : `Rejected — ${who} notified`,
      })
    } catch {
      setExiting(null)
      /* pendingApprovals will retry on the next overview poll */
    }
  }

  return (
    <div>
      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {[
          { k: 'all' as const, l: 'All', c: counts.all },
          { k: 'leave' as const, l: 'Leave', c: counts.leave },
          { k: 'regularization' as const, l: 'Regularization', c: counts.regularization },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setFilter(t.k)}
            type="button"
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
                  <RowPresenceAvatar name={a.who} userId={a.userId} size={26} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 800 }}>{a.who}</span>
                      <Pill tone={a.tone}>{a.kind === 'leave' ? 'Leave' : 'Regularize'}</Pill>
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
              isPending={reviewLeave.isPending || reviewReg.isPending}
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
  isPending,
}: {
  item: InboxItem
  comment: string
  onCommentChange: (s: string) => void
  onApprove: () => void
  onReject: () => void
  isPending: boolean
}) {
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
        <RowPresenceAvatar name={item.who} userId={item.userId} size={48} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Pill tone={item.tone}>{item.kind.toUpperCase()}</Pill>
            <Pill>{item.id.slice(0, 8)}</Pill>
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
          const l = item.raw as AdminOverview['pending']['leaves'][number]
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

        {item.kind === 'regularization' && (() => {
          const r = item.raw as AdminOverview['pending']['regularizations'][number]
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
              <Field label="Type" value={r.requestType.replaceAll('_', ' ')} />
              <Field label="Date" value={r.attendanceDate} />
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
              (optional)
            </span>
          </div>
          <textarea
            className="input"
            style={{ height: 80, padding: 12, resize: 'none' }}
            placeholder="A note for the requester…"
            value={comment}
            onChange={(e) => onCommentChange(e.target.value)}
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
        <Btn kind="danger" icon={<Icon.x size={14} />} onClick={onReject} disabled={isPending}>
          Reject
        </Btn>
        <div style={{ flex: 1 }} />
        <Btn kind="primary" icon={<Icon.check size={14} />} onClick={onApprove} disabled={isPending}>
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
