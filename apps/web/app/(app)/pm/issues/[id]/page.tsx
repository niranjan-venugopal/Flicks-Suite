'use client'

import { Suspense, use, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, avBg, initials } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DateField } from '@/components/ui/date-picker'
import { Kbd, PendingDot, PriorityGlyph, StateGlyph, PrChip, PM_PRIORITY_LABEL, type GitLink } from '@/components/pm/glyphs'
import { IssuePicker, type PickedIssue } from '@/components/pm/IssuePicker'
import { RelationsCard, type DetailRelation } from '@/components/pm/RelationsCard'
import { CommentComposer, CommentThread, IssueDescription } from '@/components/pm/issue'
import { SkeletonRows } from '@/components/states'
import { useAuthStore } from '@/lib/stores/auth.store'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { useHotkeys } from '@/lib/pm/hotkeys'
import { backLabel, defaultOrigin, issueHref, safeFrom } from '@/lib/pm/nav'
import { issueDetailQueryKey, issuePrefetchProps } from '@/lib/pm/prefetch'
import type { PmFile } from '@/lib/api/queries/use-pm-files'
import type { PmIssueRow } from '@/lib/pm/types'
import { FEATURES } from '@/lib/feature-flags'

// ─────────────────────────────────────────────────────────
// P7 Issue detail — two-pane: doc (title + description + activity/comments)
// + properties rail (state/priority/assignee/estimate/due/parent), sub-issues,
// relations, sync-pending badge. Description/comments/history are LAZY
// (fetched here, cached by react-query) — never shipped in bootstrap.
//
// Round L — (7) the header + rail render from the engine row as soon as the
// provider has handed the engine over (a cold deep link still waits for the
// bootstrap — the provider exposes the engine only after start() resolves);
// the fetch gates only the lazy parts; comments arrive newest-50 with a
// "Load earlier" page. (8) Back / Esc / post-delete return to the list the
// person came from (?from=, validated), forwarded across sub-issue and
// relation hops. (5) the Relations card + Parent row. (6) the rich
// description, attachments and the comment composer/thread (agent E's
// components; plain textarea/input when the pm_attachments flag is off).
// ─────────────────────────────────────────────────────────

interface CommentRow {
  id: string
  body: string
  author_user_id: string | null
  parent_comment_id: string | null
  created_at: string
  edited_at?: string | null
}

interface HistoryRef {
  id: string
  key: string
  title: string
}

interface HistoryRow {
  id: string
  field: string
  /** For relation/parent rows the API has already resolved the other issue to KEY-N or `hidden`. */
  from_value: string | null
  to_value: string | null
  from_ref: HistoryRef | null
  to_ref: HistoryRef | null
  actor_user_id: string | null
  created_at: string
}

interface DetailResponse {
  data: {
    issue: PmIssueRow & { description: string | null }
    /** The issue's own team key (REST mode has no store to look it up in). */
    team_key: string
    comments: CommentRow[]
    comments_total: number
    has_earlier: boolean
    history: HistoryRow[]
    sub_issues: Array<{ id: string; number: number; title: string; state_id: string; priority: number; completed_at: string | null; canceled_at: string | null; team_id: string; team_key: string }>
    relations: DetailRelation[]
    subscriber_ids: string[]
    git_links: Array<{ id: string; kind: 'branch' | 'pr' | 'commit'; ref: string; label: string; state: 'open' | 'merged' | 'closed'; url: string | null }>
    parent_issue: { id: string; number: number; title: string; team_id: string; team_key: string } | null
    files: PmFile[]
  }
}

// §12.5 branch-name generator: {user}/{team-key-lower}-{number}-{slug}.
function branchNameFor(format: string, user: string, teamKey: string, number: number, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/g, '')
  return format
    .replace('{user}', user.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'me')
    .replace('{team-key-lower}', teamKey.toLowerCase())
    .replace('{number}', String(number))
    .replace('{slug}', slug || 'issue')
}

const PERSONAL_AUTO_KEY = 'pm-gh-personal-auto' // '0' = off; default on

/** A KEY-N the reader may see, or "a hidden issue" (the API sends `hidden`). */
function refNode(key: string | null | undefined): React.ReactNode {
  if (!key || key === 'hidden') return <span style={{ fontStyle: 'italic' }}>a hidden issue</span>
  return <b style={{ color: 'var(--text-2)' }}>{key}</b>
}

/** One activity line — verb-first, plain English (Round L). */
function historyLine(h: HistoryRow): React.ReactNode {
  if (h.field === 'relation') {
    const raw = h.to_value ?? h.from_value ?? ''
    const sep = raw.indexOf(':')
    const type = sep >= 0 ? raw.slice(0, sep) : raw
    const key = sep >= 0 ? raw.slice(sep + 1) : ''
    const target = refNode(key)
    if (!h.to_value) return <>removed the link to {target}</>
    switch (type) {
      case 'blocks': return <>marked as blocking {target}</>
      case 'blocked_by': return <>marked as blocked by {target}</>
      case 'duplicate_of': return <>marked as a duplicate of {target}</>
      case 'duplicated_by': return <>marked {target} as a duplicate</>
      default: return <>linked to {target}</>
    }
  }
  if (h.field === 'parent') {
    return h.to_value
      ? <>set the parent to {refNode(h.to_value)}</>
      : <>removed the parent {refNode(h.from_value)}</>
  }
  return <>set {h.field}: {h.from_value ?? '—'} → <b style={{ color: 'var(--text-2)' }}>{h.to_value ?? '—'}</b></>
}

function Spinner() {
  return (
    <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
      <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
    </div>
  )
}

/** A proto Modal / the relation adder is open — Escape belongs to it, not to "back". */
function overlayOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector('[role="dialog"], [data-overlay-root], [data-testid="relation-adder"]')
}

export default function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  // useSearchParams() (the ?from= origin) needs a Suspense boundary in the
  // app router. Keyed by id so a hop to another issue starts clean (draft
  // description, loaded-earlier comments, menus).
  return (
    <Suspense fallback={<Spinner />}>
      <IssueDetail key={id} id={id} />
    </Suspense>
  )
}

const IssueDetail = observer(function IssueDetail({ id }: { id: string }) {
  const { engine } = usePm()
  const router = useRouter()
  const qc = useQueryClient()
  const searchParams = useSearchParams()
  // Round L (8) — where Back goes. Validated: internal /pm list paths only;
  // anything else (https://evil, /settings, an issue page) falls back.
  const from = safeFrom(searchParams.get('from'))

  const detail = useQuery({
    queryKey: issueDetailQueryKey(id),
    queryFn: () => api.get<DetailResponse>(`/api/v1/pm/issues/${id}/detail`),
  })
  const d = detail.data?.data

  // The engine row is the instant source whenever the provider has handed
  // the engine over; REST mode waits on the fetch for the row itself.
  const liveRow = engine ? engine.store.issues.get(id) : null
  const issue = liveRow ?? d?.issue ?? null
  const store = engine?.store
  const teamKey = (issue ? store?.teams.get(issue.team_id)?.key : undefined) ?? d?.team_key ?? ''

  // Back: an in-app origin means we got here by a push, so the browser's own
  // history has the list one step back — use it, and the browser Back button
  // agrees. No origin (a deep link) → the issue's own team list. Post-delete
  // always pushes (the current entry is gone).
  const originOf = () => from ?? defaultOrigin(issue?.team_id)
  const goBack = () => {
    if (from && typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push(originOf())
  }
  // Hops (sub-issue, relation, parent) REPLACE the entry so Back — ours or
  // the browser's — returns to the original list, never the previous issue
  // (founder default 12).
  const hop = (otherId: string) => router.replace(issueHref(otherId, from))

  const me = useAuthStore((st) => st.currentUser)
  const canEdit = me?.role !== 'AUDITOR'
  const [menu, setMenu] = useState<'state' | 'assignee' | 'priority' | 'project' | 'milestone' | 'parent' | null>(null)
  // Round L — a parent picked from the server search isn't in the store;
  // keep its label until the detail refetch carries parent_issue.
  const [pickedParent, setPickedParent] = useState<PickedIssue | null>(null)

  // ── Description: the saved text stays on screen until the server echoes
  // it (or the ack-driven refetch lands). Round C — a stale refetch that
  // was already in flight when Save happened must not revert the text.
  const [pendingDesc, setPendingDesc] = useState<{ text: string; at: number } | null>(null)
  const ackedAtRef = useRef(0)
  useEffect(() => {
    if (!pendingDesc) return
    const server = d?.issue.description ?? ''
    const echoed = server.trim() === pendingDesc.text.trim()
    const refetchedAfterAck = ackedAtRef.current > pendingDesc.at && detail.dataUpdatedAt > ackedAtRef.current
    if (echoed || refetchedAfterAck) setPendingDesc(null)
  }, [d?.issue.description, detail.dataUpdatedAt, pendingDesc])
  const descValue = pendingDesc?.text ?? d?.issue.description ?? ''

  // Sync mode: refetch the lazy detail (description, comments, history) when
  // OUR write for this issue is acked — correct-by-construction, not timed.
  // Round L — a "blocked by" link is stored on the OTHER issue, so its ack
  // carries that id; any relation ack refreshes this page's relations.
  useEffect(() => {
    if (!engine) return
    return engine.onFlushed((acked) => {
      const mine = acked.some((a) => a.id === id)
      if (mine) ackedAtRef.current = Date.now()
      if (mine || acked.some((a) => a.op === 'issue.relate' || a.op === 'issue.unrelate')) {
        void qc.invalidateQueries({ queryKey: issueDetailQueryKey(id) })
      }
    })
  }, [engine, id, qc])

  const restMove = useMutation({
    mutationFn: (state_id: string) => api.post(`/api/v1/pm/issues/${id}/move-state`, { state_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm'] }),
  })
  const restAssign = useMutation({
    mutationFn: (assignee_user_id: string | null) => api.post(`/api/v1/pm/issues/${id}/assign`, { assignee_user_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm'] }),
  })
  const restPriority = useMutation({
    mutationFn: (priority: number) => api.post(`/api/v1/pm/issues/${id}/priority`, { priority }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm'] }),
  })
  const restUpdate = useMutation({
    mutationFn: (fields: Record<string, unknown>) => api.patch(`/api/v1/pm/issues/${id}`, fields),
    onSuccess: () => {
      ackedAtRef.current = Date.now()
      return qc.invalidateQueries({ queryKey: ['pm'] })
    },
  })
  // Comments: the composer awaits this; a new draft namespace after each post.
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  const postComment = useMutation({
    mutationFn: (payload: { body: string; attachment_ids: string[]; mentioned_user_ids: string[] }) =>
      api.post(`/api/v1/pm/issues/${id}/comments`, payload),
    onSuccess: () => {
      setDraftId(crypto.randomUUID())
      return qc.invalidateQueries({ queryKey: issueDetailQueryKey(id) })
    },
  })
  // Kill-switch (no engine) fallback for avatars + the @-mention picker —
  // also fixes the previously-empty assignee menu in REST mode. The endpoint
  // wraps the roster in { data } — typing it as a bare array crashed the page
  // whenever this resolved before the sync engine finished bootstrapping.
  const usersQ = useQuery({
    queryKey: ['pm', 'users'],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; name: string | null; avatar_url: string | null }> }>('/api/v1/pm/users'),
    staleTime: 300_000,
    enabled: !engine,
  })

  const restProject = useMutation({
    mutationFn: (input: { project_id: string | null; milestone_id?: string | null }) =>
      api.post(`/api/v1/pm/issues/${id}/project`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm'] }),
  })

  // ── Delete (round C): the machinery shipped in round 20 — softDelete,
  //    Recently deleted, restore — but nothing in the UI ever called it. ──
  const [confirmDelete, setConfirmDelete] = useState(false)
  const restDelete = useMutation({
    mutationFn: () => api.post(`/api/v1/pm/issues/${id}/delete`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pm'] })
      router.push(originOf())
    },
  })
  const doDelete = () => {
    if (engine) {
      const origin = originOf()
      engine.deleteIssue(id)
      setConfirmDelete(false)
      router.push(origin)
    } else {
      restDelete.mutate()
    }
  }
  const projectsQ = useQuery({
    queryKey: ['pm', 'projects'],
    queryFn: () => api.get<{ data: { projects: Array<{ id: string; name: string; icon: string | null }> } }>('/api/v1/pm/projects'),
    enabled: !engine,
  })
  // Milestones of the issue's project (kill-switch path — the engine store
  // already has them all).
  const milestonesQ = useQuery({
    queryKey: ['pm', 'project-detail', issue?.project_id ?? 'none'],
    queryFn: () =>
      api.get<{ data: { milestones: Array<{ id: string; name: string }> } }>(
        `/api/v1/pm/projects/${issue!.project_id}/detail`,
      ),
    enabled: !engine && !!issue?.project_id,
  })
  const doMove = (stateId: string) => (engine ? engine.moveIssueState(id, stateId) : restMove.mutate(stateId))
  const doAssign = (uid: string | null) => (engine ? engine.assignIssue(id, uid) : restAssign.mutate(uid))
  const doPriority = (p: number) => (engine ? engine.setIssuePriority(id, p) : restPriority.mutate(p))
  const doProject = (pid: string | null) =>
    engine ? engine.setIssueProject(id, pid) : restProject.mutate({ project_id: pid })
  const doMilestone = (msId: string | null) => {
    const pid = issue?.project_id
    if (!pid) return
    if (engine) engine.setIssueProject(id, pid, msId)
    else restProject.mutate({ project_id: pid, milestone_id: msId })
  }
  // Round L — re-parent (the server validates existence / visibility / cycles).
  const doParent = (picked: PickedIssue | null) => {
    setPickedParent(picked)
    const pid = picked?.id ?? null
    if (engine) engine.updateIssue(id, { parent_issue_id: pid })
    else restUpdate.mutate({ parent_issue_id: pid })
  }
  const ghStatus = useQuery({
    queryKey: ['pm', 'github', 'status'],
    queryFn: () => api.get<{ data: { installation: { branch_format: string } | null } }>('/api/v1/pm/github/status'),
    staleTime: 300_000,
    retry: false,
    enabled: FEATURES.pm_github,
  })
  const saveDesc = async (markdown: string, attachmentIds: string[]) => {
    setPendingDesc({ text: markdown, at: Date.now() })
    const fields = { description: markdown, ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}) }
    if (engine) engine.updateIssue(id, fields)
    else await restUpdate.mutateAsync(fields)
  }

  // ⌘⇧B — copy branch name; personal automation assigns me + moves to started
  // (P16 "copy-branch assigns me + moves to started", on unless switched off).
  const copyBranchName = () => {
    const iss = issue
    if (!iss) return
    const format = ghStatus.data?.data.installation?.branch_format ?? '{user}/{team-key-lower}-{number}-{slug}'
    const firstName = (me?.name ?? 'me').split(/\s+/)[0] ?? 'me'
    const name = branchNameFor(format, firstName, teamKey || 'team', iss.number, iss.title)
    void navigator.clipboard.writeText(name)
    const auto = typeof window !== 'undefined' && window.localStorage.getItem(PERSONAL_AUTO_KEY) !== '0'
    if (auto && engine && me) {
      if (!iss.assignee_user_id) engine.assignIssue(id, me.id)
      const started = engine.store.statesForTeam(iss.team_id).find((s) => s.category === 'started')
      const cur = engine.store.states.get(iss.state_id)
      if (started && cur && ['triage', 'backlog', 'unstarted'].includes(cur.category)) {
        engine.moveIssueState(id, started.id)
      }
    }
  }

  useHotkeys({
    escape: () => {
      if (menu) { setMenu(null); return }
      // A dialog (delete / duplicate confirm) or the relation adder owns Esc.
      if (confirmDelete || overlayOpen()) return
      goBack()
    },
    'mod+shift+b': (e) => { if (!FEATURES.pm_github) return; e.preventDefault(); copyBranchName() },
    ...Object.fromEntries([0, 1, 2, 3, 4].map((p) => [String(p), () => doPriority(p)])),
  })

  // ── Comments: the detail ships the newest 50; every page seen (the detail's
  //    window as it shifts, plus "Load earlier" pages) accumulates by id, so a
  //    row never leaves once shown (Round L). The oldest accumulated row is
  //    the (created_at ms, id) keyset cursor for the next earlier page.
  const [seenComments, setSeenComments] = useState<Map<string, CommentRow>>(() => new Map())
  useEffect(() => {
    if (!d?.comments) return
    setSeenComments((prev) => {
      const next = new Map(prev)
      for (const c of d.comments) next.set(c.id, c)
      return next
    })
  }, [d?.comments])
  const [earlierHas, setEarlierHas] = useState<boolean | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const comments = useMemo(
    () =>
      [...seenComments.values()].sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
    [seenComments],
  )
  const hasEarlier = earlierHas ?? d?.has_earlier ?? false
  const loadEarlier = async () => {
    const oldest = comments[0]
    if (!oldest || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const r = await api.get<{ data: { comments: CommentRow[]; has_earlier: boolean } }>(
        `/api/v1/pm/issues/${id}/comments?before=${encodeURIComponent(oldest.created_at)}&before_id=${encodeURIComponent(oldest.id)}&limit=50`,
      )
      setSeenComments((prev) => {
        const next = new Map(prev)
        for (const c of r.data.comments) next.set(c.id, c)
        return next
      })
      setEarlierHas(r.data.has_earlier)
    } catch {
      /* the button stays; try again */
    } finally {
      setLoadingEarlier(false)
    }
  }

  // Round E — clicking an issue must feel instant. In sync mode the engine
  // row already carries everything the header + properties rail render, so
  // only the truly-lazy parts (description, comments, history, sub-issues)
  // wait on the detail fetch — as skeletons, not a full-page spinner. REST
  // mode still needs the fetch for the row itself.
  if (!issue) {
    if (detail.isError) {
      return (
        <div style={{ padding: 60, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div className="t-mute" style={{ fontSize: 12.5, textAlign: 'center' }}>Issue not found — it may be deleted or private.</div>
          <Btn kind="secondary" size="sm" icon={<Icon.chevL size={13} />} data-testid="issue-back" onClick={goBack}>
            {backLabel(from, { projectName: (pid) => engine?.store.projects.get(pid)?.name })}
          </Btn>
        </div>
      )
    }
    return <Spinner />
  }

  const team = store?.teams.get(issue.team_id)
  const states = store ? store.statesForTeam(issue.team_id) : []
  const state = states.find((s) => s.id === issue.state_id)
  // Uniform {id, name, avatar_url} regardless of source (engine store or the
  // REST fallback) — the mention picker + avatar lookups need non-null names.
  const users = (store ? [...store.users.values()] : (usersQ.data?.data ?? [])).map((u) => ({
    id: u.id,
    name: u.name ?? '—',
    avatar_url: u.avatar_url ?? null,
  }))
  const assignee = issue.assignee_user_id ? users.find((u) => u.id === issue.assignee_user_id) : null
  const doneChildren = (d?.sub_issues ?? []).filter((s) => s.completed_at).length
  const issueKey = `${teamKey}-${issue.number}`

  const back = backLabel(from, {
    projectName: (pid) =>
      engine?.store.projects.get(pid)?.name ?? projectsQ.data?.data.projects.find((p) => p.id === pid)?.name,
    teamKey,
  })

  // Round L — the parent chip: live store row → detail enrichment → the
  // just-picked issue → a bare placeholder while the first fetch is out.
  const parentInfo = (() => {
    const pid = issue.parent_issue_id
    if (!pid) return null
    const live = store?.issues.get(pid)
    if (live) return { id: pid, number: live.number, title: live.title, key: store?.teams.get(live.team_id)?.key ?? '' }
    if (d?.parent_issue && d.parent_issue.id === pid) return { id: pid, number: d.parent_issue.number, title: d.parent_issue.title, key: d.parent_issue.team_key }
    if (pickedParent && pickedParent.id === pid) return { id: pid, number: pickedParent.number, title: pickedParent.title, key: pickedParent.team_key }
    return { id: pid, number: 0, title: '…', key: '' }
  })()
  const subIssueIds = (d?.sub_issues ?? []).map((s) => s.id)

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 1120, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Btn kind="ghost" size="sm" icon={<Icon.chevL size={13} />} data-testid="issue-back" title={from ? `Back to ${back}` : 'Back to the issue list'} onClick={goBack}>
          {back}
        </Btn>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>
          {issueKey}
        </span>
        {(issue as PmIssueRow)._pending && <PendingDot />}
        <span style={{ flex: 1 }} />
        <Btn kind="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(issueKey) }}>
          Copy ID <Kbd style={{ marginLeft: 5 }}>⌘⇧.</Kbd>
        </Btn>
        {FEATURES.pm_github && (
          <Btn kind="ghost" size="sm" icon={<Icon.gitBranch size={12} />} onClick={copyBranchName} title="Copy branch name">
            Branch <Kbd style={{ marginLeft: 5 }}>⌘⇧B</Kbd>
          </Btn>
        )}
        <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} onClick={() => setConfirmDelete(true)} title="Delete issue">
          Delete
        </Btn>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete issue"
        body={`“${issueKey} · ${issue.title}” moves to Recently deleted — you can put it back for 30 days from Settings → Workspace; after that it is gone for good.`}
        confirmLabel="Delete"
        danger
        loading={restDelete.isPending}
        loadingLabel="Deleting…"
        onConfirm={doDelete}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, alignItems: 'start' }}>
        {/* ── Doc pane ── */}
        <div>
          <h1 data-testid="issue-title" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.3, marginBottom: 14 }}>
            {issue.title}
          </h1>

          {/* Description (Round L item 6 — rich editor + attachments, plain when the flag is off) */}
          <IssueDescription
            issueId={id}
            value={descValue}
            files={d?.files ?? []}
            canEdit={canEdit}
            loading={detail.isLoading}
            onSave={saveDesc}
          />

          {/* Sub-issues */}
          {(d?.sub_issues.length ?? 0) > 0 && (
            <div className="card" data-testid="sub-issues-card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
                <span className="t-caption">Sub-issues</span>
                <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                  {doneChildren}/{d!.sub_issues.length}
                </span>
              </div>
              {d!.sub_issues.map((s, i) => (
                <div
                  key={s.id}
                  data-sub-issue-id={s.id}
                  onClick={() => hop(s.id)}
                  {...issuePrefetchProps(qc, s.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, height: 32, padding: '0 14px', cursor: 'pointer', borderBottom: i < d!.sub_issues.length - 1 ? '1px solid var(--bord)' : 'none' }}
                >
                  <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{s.team_key}-{s.number}</span>
                  <PriorityGlyph p={s.priority} size={12} />
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 700, textDecoration: s.completed_at || s.canceled_at ? 'line-through' : 'none', opacity: s.completed_at || s.canceled_at ? 0.6 : 1 }}>{s.title}</span>
                </div>
              ))}
            </div>
          )}

          {/* Relations (Round L) — always present so a link can be added. */}
          <RelationsCard
            issueId={id}
            issueKey={issueKey}
            issueTitle={issue.title}
            engine={engine}
            relations={d?.relations ?? []}
            from={from}
            onChanged={() => void qc.invalidateQueries({ queryKey: issueDetailQueryKey(id) })}
          />

          {/* Git (§12 — chips attached by the GitHub App; parked behind
              FEATURES.pm_github while the connection moves to OAuth) */}
          {FEATURES.pm_github && (d?.git_links?.length ?? 0) > 0 && (
            <div className="card" style={{ padding: '10px 14px', marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="t-caption">Git</span>
              {d!.git_links.map((g) => (
                <PrChip key={g.id} g={{ t: g.kind, label: g.label, state: g.state, url: g.url } as GitLink} />
              ))}
              <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>
                PR merged → auto-moves to Done (team automation)
              </span>
            </div>
          )}

          {/* Comments + activity */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="t-caption">Activity</span>
              {d && d.comments_total > 0 && (
                <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                  {d.comments_total} comment{d.comments_total === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div style={{ maxHeight: 460, overflowY: 'auto' }}>
              {detail.isLoading && <SkeletonRows rows={2} height={34} />}
              {(d?.history ?? []).slice(0, 8).reverse().map((h) => (
                <div key={h.id} data-history-field={h.field} style={{ display: 'flex', gap: 8, padding: '7px 14px', fontSize: 11, color: 'var(--text-mute)', borderBottom: '1px solid var(--bord)' }}>
                  <span style={{ fontWeight: 800, color: 'var(--text-2)' }}>{users.find((u) => u.id === h.actor_user_id)?.name ?? '—'}</span>
                  <span>{historyLine(h)}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{new Date(h.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              ))}
              <CommentThread
                comments={comments}
                files={d?.files ?? []}
                users={users}
                issueId={id}
                hasEarlier={hasEarlier}
                onLoadEarlier={() => void loadEarlier()}
                loadingEarlier={loadingEarlier}
              />
            </div>
            {canEdit && (
              <CommentComposer
                issueId={id}
                draftId={draftId}
                users={users}
                pending={postComment.isPending}
                onSubmit={async (body, attachment_ids, mentioned_user_ids) => {
                  await postComment.mutateAsync({ body, attachment_ids, mentioned_user_ids })
                }}
              />
            )}
          </div>
        </div>

        {/* ── Properties rail ── */}
        <div className="card" style={{ padding: 12, position: 'sticky', top: 80 }}>
          <RailRow label="State" onClick={() => setMenu(menu === 'state' ? null : 'state')}>
            {state ? <><StateGlyph cat={state.category} size={13} /> <span>{state.name}</span></> : '—'}
          </RailRow>
          {menu === 'state' && (
            <RailMenu>
              {states.map((s) => (
                <button key={s.id} onClick={() => { doMove(s.id); setMenu(null) }} style={railMenuRow(s.id === issue.state_id)}>
                  <StateGlyph cat={s.category} size={12} /> {s.name}
                </button>
              ))}
            </RailMenu>
          )}
          <RailRow label="Priority" onClick={() => setMenu(menu === 'priority' ? null : 'priority')}>
            <PriorityGlyph p={issue.priority} size={13} /> <span>{PM_PRIORITY_LABEL[issue.priority]}</span>
          </RailRow>
          {menu === 'priority' && (
            <RailMenu>
              {[0, 1, 2, 3, 4].map((p) => (
                <button key={p} onClick={() => { doPriority(p); setMenu(null) }} style={railMenuRow(p === issue.priority)}>
                  <PriorityGlyph p={p} size={12} /> {PM_PRIORITY_LABEL[p]}
                </button>
              ))}
            </RailMenu>
          )}
          <RailRow label="Assignee" onClick={() => setMenu(menu === 'assignee' ? null : 'assignee')}>
            {assignee?.name ? <><MiniAv name={assignee.name} src={assignee.avatar_url} size={16} /> <span>{assignee.name}</span></> : <span className="t-mute">Unassigned</span>}
          </RailRow>
          {menu === 'assignee' && (
            <RailMenu>
              <button onClick={() => { doAssign(null); setMenu(null) }} style={railMenuRow(!issue.assignee_user_id)}>Unassigned</button>
              {users.map((u) => (
                <button key={u.id} onClick={() => { doAssign(u.id); setMenu(null) }} style={railMenuRow(u.id === issue.assignee_user_id)}>
                  <MiniAv name={u.name ?? '?'} src={u.avatar_url} size={15} /> {u.name}
                </button>
              ))}
            </RailMenu>
          )}
          <RailRow label="Project" onClick={() => setMenu(menu === 'project' ? null : 'project')}>
            {(() => {
              const proj = engine
                ? (issue.project_id ? engine.store.projects.get(issue.project_id) : null)
                : (projectsQ.data?.data.projects ?? []).find((x) => x.id === issue.project_id) ?? null
              return proj ? <><span style={{ fontSize: 12 }}>{proj.icon ?? '🎯'}</span> <span>{proj.name}</span></> : <span className="t-mute">None</span>
            })()}
          </RailRow>
          {menu === 'project' && (
            <RailMenu>
              <button onClick={() => { doProject(null); setMenu(null) }} style={railMenuRow(!issue.project_id)}>No project</button>
              {(engine ? engine.store.projectList() : projectsQ.data?.data.projects ?? []).map((pr) => (
                <button key={pr.id} onClick={() => { doProject(pr.id); setMenu(null) }} style={railMenuRow(pr.id === issue.project_id)}>
                  <span style={{ fontSize: 12 }}>{pr.icon ?? '🎯'}</span> {pr.name}
                </button>
              ))}
            </RailMenu>
          )}
          <RailRow
            label="Milestone"
            onClick={issue.project_id ? () => setMenu(menu === 'milestone' ? null : 'milestone') : undefined}
          >
            {(() => {
              if (!issue.project_id) return <span className="t-mute">Set a project first</span>
              const options = engine
                ? engine.store.milestonesForProject(issue.project_id)
                : milestonesQ.data?.data.milestones ?? []
              const ms = issue.milestone_id ? options.find((m) => m.id === issue.milestone_id) : null
              return ms ? <span>{ms.name}</span> : <span className="t-mute">None</span>
            })()}
          </RailRow>
          {menu === 'milestone' && issue.project_id && (
            <RailMenu>
              <button onClick={() => { doMilestone(null); setMenu(null) }} style={railMenuRow(!issue.milestone_id)}>No milestone</button>
              {(engine
                ? engine.store.milestonesForProject(issue.project_id)
                : milestonesQ.data?.data.milestones ?? []
              ).map((m) => (
                <button key={m.id} onClick={() => { doMilestone(m.id); setMenu(null) }} style={railMenuRow(m.id === issue.milestone_id)}>
                  {m.name}
                </button>
              ))}
            </RailMenu>
          )}
          {/* Round L — parent (sub-issue of). */}
          <RailRow label="Parent" onClick={() => setMenu(menu === 'parent' ? null : 'parent')} testId="rail-parent">
            {parentInfo ? (
              <>
                <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{parentInfo.key}-{parentInfo.number || '…'}</span>
                <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{parentInfo.title}</span>
              </>
            ) : (
              <span className="t-mute">None</span>
            )}
          </RailRow>
          {menu === 'parent' && (
            <RailMenu wide>
              {parentInfo && (
                <button
                  onClick={() => { setMenu(null); hop(parentInfo.id) }}
                  {...issuePrefetchProps(qc, parentInfo.id)}
                  style={railMenuRow(false)}
                >
                  <Icon.arrow size={12} /> Open {parentInfo.key}-{parentInfo.number || '…'}
                </button>
              )}
              {issue.parent_issue_id && (
                <button data-testid="clear-parent" onClick={() => { doParent(null); setMenu(null) }} style={{ ...railMenuRow(false), color: 'var(--coral)' }}>
                  <Icon.x size={12} /> No parent
                </button>
              )}
              {/* Never offer itself, its current parent or its own sub-issues (a cycle the server would reject). */}
              <IssuePicker
                engine={engine}
                excludeIds={[id, ...(issue.parent_issue_id ? [issue.parent_issue_id] : []), ...subIssueIds]}
                placeholder="Set parent — search issues"
                onPick={(p) => { doParent(p); setMenu(null) }}
                onClose={() => setMenu(null)}
              />
            </RailMenu>
          )}
          <RailRow label="Estimate">
            <input
              className="input"
              defaultValue={issue.estimate ? String(Number(issue.estimate)) : ''}
              placeholder="—"
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (engine) engine.updateIssue(id, { estimate: v || null })
                else restUpdate.mutate({ estimate: v || null })
              }}
              style={{ height: 26, width: 70, fontSize: 11.5 }}
            />
          </RailRow>
          <RailRow label="Due">
            <DateField
              value={issue.due_date ?? ''}
              onChange={(iso) => {
                if (engine) engine.updateIssue(id, { due_date: iso || null })
                else restUpdate.mutate({ due_date: iso || null })
              }}
              style={{ height: 26, width: 130, fontSize: 11.5 }}
            />
          </RailRow>
          <div style={{ borderTop: '1px solid var(--bord)', marginTop: 10, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="t-caption">Subscribers</span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {(d?.subscriber_ids ?? []).map((uid) => (
                <MiniAv key={uid} name={users.find((u) => u.id === uid)?.name ?? '?'} src={users.find((u) => u.id === uid)?.avatar_url} size={18} />
              ))}
            </div>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', fontWeight: 700 }}>
              Created {new Date(issue.created_at).toLocaleDateString()} · updated {new Date(issue.updated_at).toLocaleDateString()}
            </span>
            {issue.source !== 'manual' && <Pill>{issue.source}</Pill>}
          </div>
        </div>
      </div>
    </div>
  )
})

function RailRow({ label, children, onClick, testId }: { label: string; children: React.ReactNode; onClick?: () => void; testId?: string }) {
  return (
    <div data-testid={testId} onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 6px', borderRadius: 8, cursor: onClick ? 'pointer' : 'default', position: 'relative' }}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.background = 'var(--surf-1)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
      <span style={{ width: 74, fontSize: 10.5, fontWeight: 800, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em', flexShrink: 0 }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700, minWidth: 0 }}>{children}</span>
    </div>
  )
}

function RailMenu({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ margin: wide ? '2px 0 6px 0' : '2px 0 6px 80px', background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 5, maxHeight: wide ? 340 : 220, overflowY: 'auto' }}
    >
      {children}
    </div>
  )
}

function railMenuRow(active: boolean): React.CSSProperties {
  return {
    width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    borderRadius: 7, background: active ? 'var(--surf-2)' : 'transparent', border: 'none',
    cursor: 'pointer', color: active ? '#fff' : 'var(--text-2)', fontSize: 11.5, fontWeight: 700, textAlign: 'left',
  }
}

// Signed avatar when the workspace roster has one, initials otherwise.
function MiniAv({ name, src, size = 18 }: { name: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  const box = { width: size, height: size, borderRadius: '50%', flexShrink: 0 } as const
  if (src && !broken) {
    return <img src={src} alt={name} onError={() => setBroken(true)} style={{ ...box, objectFit: 'cover', display: 'inline-block' }} />
  }
  return (
    <span style={{ ...box, background: avBg(name), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: Math.max(7, size * 0.36), letterSpacing: '-0.02em' }}>
      {initials(name)}
    </span>
  )
}
