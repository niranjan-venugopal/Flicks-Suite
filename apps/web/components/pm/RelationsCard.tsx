'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { useQueryClient } from '@tanstack/react-query'
import { Btn, Icon } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { toast } from '@/components/ui/use-toast'
import { IssuePicker, type PickedIssue } from '@/components/pm/IssuePicker'
import { api } from '@/lib/api/client'
import type { PmSyncEngine } from '@/lib/pm/engine'
import { issueHref } from '@/lib/pm/nav'
import { issuePrefetchProps } from '@/lib/pm/prefetch'

// ─────────────────────────────────────────────────────────
// Round L — issue relations (founder: "an issue can be related to another
// issue"). Add relation → Relates to / Blocks / Blocked by / Duplicate of →
// pick the other issue. One stored direction: "Blocked by X" is X→me
// 'blocks'. Duplicate of confirms (it closes this issue as Duplicate). Every
// chip carries the OTHER issue's team key (the old chips printed this
// issue's key for a cross-team link). × removes. Works in both PM modes.
// ─────────────────────────────────────────────────────────

export type RelationType = 'blocks' | 'duplicate_of' | 'relates_to'

export interface DetailRelation {
  id: string
  issue_id: string
  related_issue_id: string
  type: string
  related_issue: {
    id: string
    number: number
    title: string
    team_id: string
    team_key: string
    state_id: string
    completed_at: string | null
    canceled_at?: string | null
  }
}

type Choice = 'relates_to' | 'blocks' | 'blocked_by' | 'duplicate_of'

const CHOICES: Array<{ id: Choice; label: string; hint: string }> = [
  { id: 'relates_to', label: 'Relates to', hint: 'Loosely connected work' },
  { id: 'blocks', label: 'Blocks', hint: 'This issue blocks the other one' },
  { id: 'blocked_by', label: 'Blocked by', hint: 'The other issue blocks this one' },
  { id: 'duplicate_of', label: 'Duplicate of', hint: 'Closes this issue as Duplicate' },
]

/** Verb as read from THIS issue's side. */
function verbFor(type: string, forward: boolean): string {
  if (type === 'blocks') return forward ? 'blocks' : 'blocked by'
  if (type === 'duplicate_of') return forward ? 'duplicate of' : 'duplicated by'
  return 'relates to'
}

function toneFor(type: string): string {
  if (type === 'blocks') return 'var(--coral)'
  if (type === 'duplicate_of') return 'var(--yellow)'
  return 'var(--text-faint)'
}

interface OtherInfo {
  number: number
  title: string
  team_key: string
  /** Done or canceled — the chip strikes through. */
  closed: boolean
}

interface Row {
  key: string // logical: issue_id:related_issue_id:type
  relationId: string
  otherId: string
  stored: { issue_id: string; related_issue_id: string; type: RelationType }
  forward: boolean
  pending: boolean
}

export const RelationsCard = observer(function RelationsCard({
  issueId,
  issueKey,
  issueTitle,
  engine,
  relations,
  from,
  onChanged,
}: {
  issueId: string
  /** KEY-N of this issue (for the duplicate confirmation copy). */
  issueKey: string
  issueTitle: string
  engine: PmSyncEngine | null
  /** Enriched rows from GET /pm/issues/:id/detail (visibility-filtered). */
  relations: DetailRelation[]
  /** The page's origin — forwarded across the hop (founder default 12). */
  from: string | null
  /** REST mode: refetch the detail after a write. */
  onChanged?: () => void
}) {
  const router = useRouter()
  const qc = useQueryClient()
  const store = engine?.store
  const [adding, setAdding] = useState<null | { choice: Choice | null }>(null)
  const [confirmDup, setConfirmDup] = useState<PickedIssue | null>(null)
  // REST mode only: removed here but maybe still in a stale detail payload →
  // hidden until the refetch; re-adding the same link clears the entry. In
  // engine mode the store drops the row optimistically and puts it back on
  // rejection, so masking would hide the restored row.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set())
  // Issues picked from the server search aren't in the store; remember
  // what we know about them so the optimistic chip has a label.
  const [picked, setPicked] = useState<Map<string, OtherInfo>>(() => new Map())
  // The adder owns focus while open so Escape lands here, not on the page's
  // hotkey (which would leave the issue).
  const adderRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (adding && adding.choice === null) adderRef.current?.focus()
  }, [adding])

  // Other-end labels from the detail enrichment.
  const enriched = useMemo(() => {
    const m = new Map<string, OtherInfo>()
    for (const r of relations) {
      const o = r.related_issue
      m.set(o.id, { number: o.number, title: o.title, team_key: o.team_key, closed: !!(o.completed_at || o.canceled_at) })
    }
    return m
  }, [relations])

  const otherInfo = (otherId: string): OtherInfo | null => {
    const live = store?.issues.get(otherId)
    if (live && !live.deleted_at) {
      return {
        number: live.number,
        title: live.title,
        team_key: store?.teams.get(live.team_id)?.key ?? enriched.get(otherId)?.team_key ?? '',
        closed: !!(live.completed_at || live.canceled_at),
      }
    }
    return enriched.get(otherId) ?? picked.get(otherId) ?? null
  }

  // Union of the lazy REST rows and the live store rows, keyed by the
  // logical link so a temp (optimistic) row and its acked twin never both
  // show. Store rows win (they carry the pending flag).
  const rows: Row[] = (() => {
    const byKey = new Map<string, Row>()
    const add = (r: { id: string; issue_id: string; related_issue_id: string; type: string; _pending?: boolean }) => {
      const key = `${r.issue_id}:${r.related_issue_id}:${r.type}`
      const forward = r.issue_id === issueId
      byKey.set(key, {
        key,
        relationId: r.id,
        otherId: forward ? r.related_issue_id : r.issue_id,
        stored: { issue_id: r.issue_id, related_issue_id: r.related_issue_id, type: r.type as RelationType },
        forward,
        pending: !!r._pending,
      })
    }
    for (const r of relations) add(r)
    if (store) for (const r of store.relationsForIssue(issueId)) add(r)
    return [...byKey.values()].filter((r) => engine || !removed.has(r.key))
  })()

  const linkedIds = rows.map((r) => r.otherId)

  const fail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })

  const relate = (a: string, b: string, type: RelationType) => {
    setRemoved((prev) => {
      if (!prev.has(`${a}:${b}:${type}`)) return prev
      const next = new Set(prev)
      next.delete(`${a}:${b}:${type}`)
      return next
    })
    if (engine) engine.relateIssues(a, b, type)
    else {
      void api
        .post(`/api/v1/pm/issues/${a}/relate`, { related_issue_id: b, type })
        .then(() => onChanged?.())
        .catch(fail('Couldn’t link the issues'))
    }
  }

  const unrelate = (row: Row) => {
    const { issue_id, related_issue_id, type } = row.stored
    if (engine) engine.unrelateIssues(issue_id, related_issue_id, type)
    else {
      setRemoved((prev) => new Set(prev).add(row.key))
      void api
        .post(`/api/v1/pm/issues/${issue_id}/unrelate`, { related_issue_id, type })
        .then(() => onChanged?.())
        .catch((err: unknown) => {
          setRemoved((prev) => {
            const next = new Set(prev)
            next.delete(row.key)
            return next
          })
          fail('Couldn’t remove the link')(err)
        })
    }
  }

  const applyChoice = (choice: Choice, other: PickedIssue) => {
    setPicked((prev) => new Map(prev).set(other.id, { number: other.number, title: other.title, team_key: other.team_key, closed: false }))
    if (choice === 'relates_to') relate(issueId, other.id, 'relates_to')
    else if (choice === 'blocks') relate(issueId, other.id, 'blocks')
    else if (choice === 'blocked_by') relate(other.id, issueId, 'blocks')
    else relate(issueId, other.id, 'duplicate_of')
  }

  const onPick = (other: PickedIssue) => {
    const choice = adding?.choice
    setAdding(null)
    if (!choice) return
    if (choice === 'duplicate_of') {
      setConfirmDup(other)
      return
    }
    applyChoice(choice, other)
  }

  const open = (otherId: string) => router.replace(issueHref(otherId, from))

  const visibleRows = rows.map((r) => ({ ...r, other: otherInfo(r.otherId) })).filter((r) => r.other !== null)

  return (
    <div className="card" data-testid="relations-card" style={{ padding: 0, overflow: 'visible', marginBottom: 16, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 8px 14px', borderBottom: visibleRows.length ? '1px solid var(--bord)' : 'none' }}>
        <span className="t-caption">Relations</span>
        {visibleRows.length > 0 && (
          <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{visibleRows.length}</span>
        )}
        <span style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <Btn
            kind="ghost"
            size="sm"
            icon={<Icon.link size={12} />}
            data-testid="add-relation"
            onClick={() => setAdding(adding ? null : { choice: null })}
            title="Link another issue"
          >
            Add relation
          </Btn>
          {adding && (
            <>
              <div onClick={() => setAdding(null)} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
              <div
                ref={adderRef}
                tabIndex={-1}
                data-testid="relation-adder"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(null) } }}
                style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 80, width: 340, background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 6, boxShadow: '0 16px 40px rgba(0,0,0,.5)', outline: 'none' }}
              >
                {adding.choice === null ? (
                  <>
                    <div className="t-caption" style={{ padding: '4px 8px 6px' }}>Relation type</div>
                    {CHOICES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        data-testid={`relation-type-${c.id}`}
                        onClick={() => setAdding({ choice: c.id })}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-2)', textAlign: 'left' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surf-1)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: toneFor(c.id === 'blocked_by' ? 'blocks' : c.id), flexShrink: 0 }} />
                        <span style={{ fontSize: 12, fontWeight: 800, color: '#fff', width: 92, flexShrink: 0 }}>{c.label}</span>
                        <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>{c.hint}</span>
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px 4px' }}>
                      <button type="button" onClick={() => setAdding({ choice: null })} title="Change relation type"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-mute)', fontSize: 10.5, fontWeight: 800, padding: 0 }}>
                        <Icon.chevL size={11} /> {CHOICES.find((c) => c.id === adding.choice)?.label}
                      </button>
                      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)' }}>· pick the other issue</span>
                    </div>
                    <IssuePicker
                      engine={engine}
                      excludeIds={[issueId, ...linkedIds]}
                      onPick={onPick}
                      onClose={() => setAdding(null)}
                    />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {visibleRows.length > 0 ? (
        <div style={{ padding: '10px 14px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {visibleRows.map((r) => (
            <span
              key={r.key}
              data-relation-id={r.relationId}
              data-relation-type={r.stored.type}
              data-related-issue-id={r.otherId}
              role="link"
              tabIndex={0}
              onClick={() => open(r.otherId)}
              onKeyDown={(e) => { if (e.key === 'Enter') open(r.otherId) }}
              {...issuePrefetchProps(qc, r.otherId)}
              title={`${r.other!.team_key}-${r.other!.number} · ${r.other!.title}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 9px', borderRadius: 7,
                background: 'var(--surf-1)', border: '1px solid var(--bord)', color: 'var(--text-2)',
                fontSize: 10.5, fontWeight: 700, cursor: 'pointer', maxWidth: 320, opacity: r.pending ? 0.7 : 1,
              }}
            >
              <span style={{ color: toneFor(r.stored.type), flexShrink: 0 }}>{verbFor(r.stored.type, r.forward)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: '#fff', flexShrink: 0 }}>
                {r.other!.team_key}-{r.other!.number}
              </span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: r.other!.closed ? 'line-through' : 'none', opacity: r.other!.closed ? 0.6 : 1 }}>
                {r.other!.title}
              </span>
              <button
                type="button"
                aria-label={`Remove relation to ${r.other!.team_key}-${r.other!.number}`}
                data-testid="remove-relation"
                onClick={(e) => { e.stopPropagation(); unrelate(r) }}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 4, background: 'transparent', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0, flexShrink: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--coral)' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)' }}
              >
                <Icon.x size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="t-mute" style={{ padding: '2px 14px 10px', fontSize: 11 }}>
          No relations yet — link blockers, duplicates or related work.
        </div>
      )}

      <ConfirmDialog
        open={confirmDup !== null}
        onClose={() => setConfirmDup(null)}
        title="Mark as duplicate"
        body={
          confirmDup
            ? `“${issueKey} · ${issueTitle}” will be closed as a Duplicate of ${confirmDup.team_key}-${confirmDup.number} · ${confirmDup.title}. The other issue stays open.`
            : undefined
        }
        confirmLabel="Mark duplicate"
        onConfirm={() => {
          if (confirmDup) applyChoice('duplicate_of', confirmDup)
          setConfirmDup(null)
        }}
      />
    </div>
  )
})
