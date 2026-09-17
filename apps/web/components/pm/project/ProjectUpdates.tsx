'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import { useQuery } from '@tanstack/react-query'
import { diffProjectUpdate, isUpdateSnapshot, type PmUpdateDiff, type PmUpdateSnapshot } from '@flicks/shared/pm'
import { Btn, Icon, SectionHead } from '@/components/proto'
import { DiamondGlyph, HealthChip, PM_PRIORITY_LABEL, PM_PROJECT_STATUS_LABEL, PendingDot } from '@/components/pm/glyphs'
import { PmAv } from '@/components/pm/projects'
import { RichView } from '@/components/pm/editor'
import { ProjectUpdateComposer } from '@/components/pm/project/ProjectUpdateComposer'
import { api } from '@/lib/api/client'
import { useAttachmentsEnabled } from '@/lib/api/queries/use-pm-files'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmStore } from '@/lib/pm/store'
import type { PmProjectRow, PmUpdateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// Round M — the "Latest update" card (main column, under the header), after
// Linear's project update: health chip, author, the post body, and the grey
// block of what changed since the previous update — priority, lead, dates,
// status, milestone progress and issues completed. The block is a DIFF of
// two stored snapshots (packages/shared/src/pm/update-diff.ts), computed
// here from the page's merged list so REST rows and live engine rows read
// the same way; an optimistic row (snapshot: null) shows no block until the
// ack replaces it. Earlier updates fold under "Show N earlier updates".
// ─────────────────────────────────────────────────────────

type Health = PmUpdateRow['health']
type UserLike = { id: string; name: string | null; avatar_url: string | null }
/**
 * The engine's optimistic row (engine.ts postProjectUpdate sets `_pending`)
 * until the ack replaces it under the same id. Keyed on that client-only
 * flag, NOT on a null snapshot: rows posted before migration 0064 have
 * snapshot null for good and must read as ordinary (final) updates.
 */
const isPending = (u: PmUpdateRow): boolean => (u as { _pending?: boolean })._pending === true

export interface ProjectUpdatesProps {
  projectId: string
  engine: PmSyncEngine | null
  /** Live engine row overlaid on the REST detail (the page merges them). */
  project: Pick<PmProjectRow, 'name' | 'status' | 'health' | 'created_at'>
  /** REST detail merged with the live engine rows, newest first (the page computes this). */
  updates: PmUpdateRow[]
  users: PmStore['users'] | null
  /** Whole days since the newest update; null when there is none (the page computes this). */
  staleDays: number | null
  /** Refetches the lazy REST detail (REST mode; sync mode refetches on ack). */
  invalidate: () => void
  /** The composer is page state so the header/empty state can open it. */
  composerOpen: boolean
  onOpenComposer: () => void
  onCloseComposer: () => void
}

// ─── formatting ──────────────────────────────────────────────────────────────

const ordinal = (d: number) => {
  const m100 = d % 100
  if (m100 >= 11 && m100 <= 13) return `${d}th`
  const m10 = d % 10
  return `${d}${m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th'}`
}
/** 'YYYY-MM-DD' parses as a LOCAL date (a timezone shift must not move the day). */
const parseDate = (v: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v)
}
const MONTH = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
/** Linear style: `Apr 30th` this year, `Sep 18th, 2025` otherwise. */
export function fmtOrdinalDate(v: string | null | undefined): string {
  if (!v) return '—'
  const d = parseDate(v)
  if (Number.isNaN(d.getTime())) return v
  const base = `${MONTH(d)} ${ordinal(d.getDate())}`
  return d.getFullYear() === new Date().getFullYear() ? base : `${base}, ${d.getFullYear()}`
}
/** `May 18, 2025` — the "Progress since" anchor. Built like fmtOrdinalDate
 *  (month first, always with the year) so one block never mixes `Apr 30th`
 *  with a locale-ordered `18 May 2025`. */
export function fmtLongDate(v: string): string {
  const d = parseDate(v)
  if (Number.isNaN(d.getTime())) return v
  return `${MONTH(d)} ${d.getDate()}, ${d.getFullYear()}`
}
function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`
  const d = new Date(t)
  const base = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.getFullYear() === new Date().getFullYear() ? base : `${base}, ${d.getFullYear()}`
}
// 100% only when every issue is done — 249/250 reads 99%, matching the milestone rows.
const pct = (p: number) => (p >= 1 ? '100%' : `${Math.min(99, Math.round(p * 100))}%`)
/** First line of a markdown body, de-marked enough for a one-line teaser. */
function firstLine(md: string): string {
  const line = md.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
}

// ─── the grey "what changed" block ───────────────────────────────────────────

/** Linear's line order: Priority, Lead, Target date, Start date (status, when it moved, leads). */
const DIFF_LINE_ORDER: Record<PmUpdateDiff['props'][number]['key'], number> = {
  status: 0, priority: 1, lead_user_id: 2, target_date: 3, start_date: 4,
}

function DiffBlock({ diff, nameOf }: { diff: PmUpdateDiff; nameOf: (id: string | null) => string | null }) {
  const lines: ReactNode[] = []
  const props = [...diff.props].sort((a, b) => DIFF_LINE_ORDER[a.key] - DIFF_LINE_ORDER[b.key])
  for (const p of props) {
    const key = p.key
    if (key === 'priority') {
      lines.push(<div key={key}>Priority: {PM_PRIORITY_LABEL[Number(p.from ?? 0)] ?? 'No priority'} → {PM_PRIORITY_LABEL[Number(p.to ?? 0)] ?? 'No priority'}</div>)
    } else if (key === 'status') {
      lines.push(<div key={key}>Status: {PM_PROJECT_STATUS_LABEL[String(p.from)] ?? String(p.from ?? '—')} → {PM_PROJECT_STATUS_LABEL[String(p.to)] ?? String(p.to ?? '—')}</div>)
    } else if (key === 'lead_user_id') {
      const from = p.from ? nameOf(String(p.from)) : null
      const to = p.to ? nameOf(String(p.to)) : null
      if (!p.from && p.to) lines.push(<div key={key}>Lead: {to ? `${to} assigned` : 'assigned'}</div>)
      else if (p.from && !p.to) lines.push(<div key={key}>Lead: {from ? `${from} removed` : 'removed'}</div>)
      else lines.push(<div key={key}>Lead: {from ?? 'Someone'} → {to ?? 'someone else'}</div>)
    } else {
      const label = key === 'target_date' ? 'Target date' : 'Start date'
      if (!p.from && p.to) lines.push(<div key={key}>{label}: set to {fmtOrdinalDate(String(p.to))}</div>)
      else if (p.from && !p.to) lines.push(<div key={key}>{label}: {fmtOrdinalDate(String(p.from))} removed</div>)
      else lines.push(<div key={key}>{label}: {fmtOrdinalDate(String(p.from))} → {fmtOrdinalDate(String(p.to))}</div>)
    }
  }
  const progress = diff.milestones.length > 0 || diff.issues_done_delta > 0
  if (!lines.length && !progress) return null
  return (
    <div
      data-testid="update-diff"
      style={{
        marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'var(--surf-2)', border: '1px solid var(--bord)',
        fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.7, display: 'grid', gap: 2,
      }}
    >
      {lines}
      {progress && (
        <>
          <div style={{ marginTop: lines.length ? 6 : 0 }}>Progress since {fmtLongDate(diff.since)}:</div>
          {diff.milestones.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 4, minWidth: 0 }}>
              <DiamondGlyph size={10} color={m.to_pct >= 1 ? 'var(--green)' : 'var(--yellow)'} />
              {/* The name is the only thing allowed to give up width on a phone. */}
              <span title={m.name} style={{ fontWeight: 700, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
              <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{pct(m.from_pct)} → {pct(m.to_pct)}</span>
              {m.completed_at && <span style={{ color: 'var(--text-mute)', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtLongDate(m.completed_at)}</span>}
            </div>
          ))}
          {diff.issues_done_delta > 0 && (
            <div style={{ paddingLeft: 4 }}>
              {diff.issues_done_delta} {diff.issues_done_delta === 1 ? 'issue' : 'issues'} completed
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── one update (full) ───────────────────────────────────────────────────────

function UpdateBody({ u, diff, rich, userOf, nameOf }: {
  u: PmUpdateRow
  diff: PmUpdateDiff | null
  rich: boolean
  userOf: (id: string | null) => UserLike | null
  nameOf: (id: string | null) => string | null
}) {
  const author = userOf(u.author_user_id)
  const authorName = author?.name ?? 'Member'
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, minWidth: 0 }}>
        <HealthChip h={u.health} />
        <PmAv name={authorName} src={author?.avatar_url ?? null} size={20} />
        <span style={{ fontSize: 12.5, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{authorName}</span>
        <span title={new Date(u.created_at).toLocaleString()} style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
          {timeAgo(u.created_at)}
        </span>
        {/* The kit's pending dot (as on the header) while the optimistic row
            awaits its ack — keyed on `_pending`, never on `snapshot === null`,
            which is also every pre-0064 row. The ack replaces the row under
            the same id, so the change block appears without a flicker. */}
        {isPending(u) && <PendingDot title="Syncing — the change summary appears once the server confirms" />}
      </div>
      {rich ? (
        <RichView value={u.body_md} testId="update-body" />
      ) : (
        <div data-testid="update-body" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{u.body_md}</div>
      )}
      {diff && <DiffBlock diff={diff} nameOf={nameOf} />}
    </div>
  )
}

// ─── the card ────────────────────────────────────────────────────────────────

export const ProjectUpdates = observer(function ProjectUpdates({
  projectId,
  engine,
  project,
  updates,
  users,
  staleDays,
  invalidate,
  composerOpen,
  onOpenComposer,
  onCloseComposer,
}: ProjectUpdatesProps) {
  const { rich } = useAttachmentsEnabled()
  const [showEarlier, setShowEarlier] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  // REST mode has no store roster — one shared query resolves authors + leads.
  const restUsers = useQuery({
    queryKey: ['pm', 'users'],
    queryFn: () => api.get<{ data: UserLike[] }>('/api/v1/pm/users'),
    staleTime: 300_000,
    enabled: !users,
  })
  const restById = useMemo(() => new Map((restUsers.data?.data ?? []).map((u) => [u.id, u])), [restUsers.data])
  const userOf = (id: string | null): UserLike | null => (id ? users?.get(id) ?? restById.get(id) ?? null : null)
  const nameOf = (id: string | null): string | null => userOf(id)?.name ?? null

  // Diff every snapshotted update against the next-older one WITH a
  // snapshot (legacy rows are skipped), or the project baseline for the first.
  const diffs = useMemo(() => {
    const baseline = { created_at: project.created_at }
    const out = new Map<string, PmUpdateDiff>()
    updates.forEach((u, i) => {
      if (!isUpdateSnapshot(u.snapshot)) return
      let prev: PmUpdateSnapshot | null = null
      for (let j = i + 1; j < updates.length; j++) {
        const s = updates[j]!.snapshot
        if (isUpdateSnapshot(s)) { prev = s; break }
      }
      out.set(u.id, diffProjectUpdate(u.snapshot, prev, baseline))
    })
    return out
  }, [updates, project.created_at])

  const latest = updates[0]
  const earlier = updates.slice(1)
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="card" data-testid="project-latest-update" style={{ padding: 16, marginBottom: 14 }}>
      <SectionHead
        title={<span style={{ fontSize: 14, letterSpacing: '-0.02em' }}>Latest update</span>}
        right={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {/* Same rule as the API's staleness sweep (pm.jobs.ts UPDATE_STALE_DAYS,
                in-progress projects only): a paused or completed project is not
                "stale", and with no updates the empty state already says so. */}
            {project.status === 'in_progress' && staleDays !== null && staleDays >= 7 && (
              <span data-testid="update-stale-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 99, background: 'rgba(254,216,0,.09)', border: '1px solid rgba(254,216,0,.35)', fontSize: 10.5, fontWeight: 800, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>
                No update in {staleDays} days
              </span>
            )}
            <Btn kind="primary" size="sm" data-testid="update-open-composer" icon={<Icon.edit size={13} />} onClick={onOpenComposer}>
              Update
            </Btn>
          </span>
        }
      />

      {latest ? (
        <UpdateBody u={latest} diff={diffs.get(latest.id) ?? null} rich={rich} userOf={userOf} nameOf={nameOf} />
      ) : (
        <div style={{ padding: '18px 0 6px', textAlign: 'center' }}>
          <div className="t-mute" style={{ marginBottom: 10 }}>No updates yet</div>
          <Btn kind="secondary" size="sm" data-testid="update-write-first" onClick={onOpenComposer}>
            Write first project update
          </Btn>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-faint)', maxWidth: 420, margin: '10px auto 0' }}>
            Tell the team how the project is going — what moved, what is at risk, what comes next.
            The lead gets an Inbox reminder when a project runs 7 days without an update.
          </div>
        </div>
      )}

      {earlier.length > 0 && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--bord)', paddingTop: 10 }}>
          <button
            type="button"
            data-testid="update-show-earlier"
            aria-expanded={showEarlier}
            onClick={() => setShowEarlier((v) => !v)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11.5, fontWeight: 800, color: 'var(--text-mute)' }}
          >
            {showEarlier ? 'Hide' : 'Show'} {earlier.length} earlier {earlier.length === 1 ? 'update' : 'updates'}
            {showEarlier ? <Icon.chevU size={12} /> : <Icon.chevD size={12} />}
          </button>
          {showEarlier && (
            <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
              {earlier.map((u) => {
                const open = expanded.has(u.id)
                const author = userOf(u.author_user_id)
                const authorName = author?.name ?? 'Member'
                return (
                  <div key={u.id} data-testid="update-earlier-row" style={{ borderRadius: 8, border: '1px solid var(--bord)', background: 'var(--surf-1)', padding: open ? '10px 12px' : '7px 12px' }}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onClick={() => toggle(u.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(u.id) } }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 0 }}
                    >
                      <HealthChip h={u.health} small />
                      <PmAv name={authorName} src={author?.avatar_url ?? null} size={16} />
                      <span style={{ fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>{authorName}</span>
                      <span title={new Date(u.created_at).toLocaleString()} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{timeAgo(u.created_at)}</span>
                      {!open && (
                        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                          {firstLine(u.body_md)}
                        </span>
                      )}
                      {open && <span style={{ flex: 1 }} />}
                      {open ? <Icon.chevU size={12} style={{ color: 'var(--text-faint)', flexShrink: 0 }} /> : <Icon.chevD size={12} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />}
                    </div>
                    {open && (
                      <div style={{ marginTop: 10 }}>
                        {rich ? (
                          <RichView value={u.body_md} />
                        ) : (
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{u.body_md}</div>
                        )}
                        {diffs.get(u.id) && <DiffBlock diff={diffs.get(u.id)!} nameOf={nameOf} />}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {composerOpen && (
        <ProjectUpdateComposer
          open
          onClose={onCloseComposer}
          projectId={projectId}
          projectName={project.name}
          engine={engine}
          currentHealth={project.health as Health}
          invalidate={invalidate}
        />
      )}
    </div>
  )
})
