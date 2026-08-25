'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, avBg, initials } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { Kbd, PendingDot, PriorityGlyph, StateGlyph, PrChip, PM_PRIORITY_LABEL, type GitLink } from '@/components/pm/glyphs'
import { useAuthStore } from '@/lib/stores/auth.store'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { useHotkeys } from '@/lib/pm/hotkeys'
import type { PmIssueRow } from '@/lib/pm/types'
import { FEATURES } from '@/lib/feature-flags'

// ─────────────────────────────────────────────────────────
// P7 Issue detail — two-pane: doc (title + description + activity/comments)
// + properties rail (state/priority/assignee/estimate/due), sub-issues,
// relations, sync-pending badge. Description/comments/history are LAZY
// (fetched here, cached by react-query) — never shipped in bootstrap.
// ─────────────────────────────────────────────────────────

interface DetailResponse {
  data: {
    issue: PmIssueRow & { description: string | null }
    comments: Array<{ id: string; body: string; author_user_id: string | null; parent_comment_id: string | null; created_at: string }>
    history: Array<{ id: string; field: string; from_value: string | null; to_value: string | null; actor_user_id: string | null; created_at: string }>
    sub_issues: Array<{ id: string; number: number; title: string; state_id: string; priority: number; completed_at: string | null }>
    relations: Array<{ id: string; issue_id: string; related_issue_id: string; type: string }>
    subscriber_ids: string[]
    git_links: Array<{ id: string; kind: 'branch' | 'pr' | 'commit'; ref: string; label: string; state: 'open' | 'merged' | 'closed'; url: string | null }>
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

export default function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <IssueDetail id={id} />
}

const IssueDetail = observer(function IssueDetail({ id }: { id: string }) {
  const { mode, engine } = usePm()
  const router = useRouter()
  const qc = useQueryClient()

  const detail = useQuery({
    queryKey: ['pm', 'issue-detail', id],
    queryFn: () => api.get<DetailResponse>(`/api/v1/pm/issues/${id}/detail`),
  })
  const d = detail.data?.data

  // Live row from the engine graph when syncing (instant property updates).
  const liveRow = mode === 'sync' && engine ? engine.store.issues.get(id) : null
  const issue = liveRow ?? d?.issue ?? null
  const store = engine?.store

  const [editingDesc, setEditingDesc] = useState(false)
  const [desc, setDesc] = useState('')
  const [comment, setComment] = useState('')
  // @-mentions (round 7): tokens picked from the dropdown; on submit only the
  // ones still present in the text are sent as mentioned_user_ids.
  const [mentioned, setMentioned] = useState<Array<{ id: string; name: string }>>([])
  const [mentionIdx, setMentionIdx] = useState(0)
  const [menu, setMenu] = useState<'state' | 'assignee' | 'priority' | 'project' | null>(null)

  useEffect(() => {
    if (d?.issue.description != null && !editingDesc) setDesc(d.issue.description)
  }, [d?.issue.description, editingDesc])

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm'] }),
  })
  const postComment = useMutation({
    mutationFn: (payload: { body: string; mentioned_user_ids: string[] }) =>
      api.post(`/api/v1/pm/issues/${id}/comments`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pm', 'issue-detail', id] })
      setComment('')
      setMentioned([])
    },
  })
  // Kill-switch (no engine) fallback for avatars + the @-mention picker —
  // also fixes the previously-empty assignee menu in REST mode.
  const usersQ = useQuery({
    queryKey: ['pm', 'users'],
    queryFn: () => api.get<Array<{ id: string; name: string | null; avatar_url: string | null }>>('/api/v1/pm/users'),
    staleTime: 300_000,
    enabled: !engine,
  })

  const restProject = useMutation({
    mutationFn: (projectId: string | null) => api.post(`/api/v1/pm/issues/${id}/project`, { project_id: projectId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm'] }),
  })
  const projectsQ = useQuery({
    queryKey: ['pm', 'projects'],
    queryFn: () => api.get<{ data: { projects: Array<{ id: string; name: string; icon: string | null }> } }>('/api/v1/pm/projects'),
    enabled: !engine,
  })
  const doMove = (stateId: string) => (engine ? engine.moveIssueState(id, stateId) : restMove.mutate(stateId))
  const doAssign = (uid: string | null) => (engine ? engine.assignIssue(id, uid) : restAssign.mutate(uid))
  const doPriority = (p: number) => (engine ? engine.setIssuePriority(id, p) : restPriority.mutate(p))
  const doProject = (pid: string | null) => (engine ? engine.setIssueProject(id, pid) : restProject.mutate(pid))
  const me = useAuthStore((st) => st.currentUser)
  const ghStatus = useQuery({
    queryKey: ['pm', 'github', 'status'],
    queryFn: () => api.get<{ data: { installation: { branch_format: string } | null } }>('/api/v1/pm/github/status'),
    staleTime: 300_000,
    retry: false,
    enabled: FEATURES.pm_github,
  })
  const saveDesc = () => {
    if (engine) engine.updateIssue(id, { description: desc })
    else restUpdate.mutate({ description: desc })
    setEditingDesc(false)
    setTimeout(() => qc.invalidateQueries({ queryKey: ['pm', 'issue-detail', id] }), 600)
  }

  // ⌘⇧B — copy branch name; personal automation assigns me + moves to started
  // (P16 "copy-branch assigns me + moves to started", on unless switched off).
  const copyBranchName = () => {
    const iss = issue
    if (!iss) return
    const t = engine?.store.teams.get(iss.team_id)
    const format = ghStatus.data?.data.installation?.branch_format ?? '{user}/{team-key-lower}-{number}-{slug}'
    const firstName = (me?.name ?? 'me').split(/\s+/)[0] ?? 'me'
    const name = branchNameFor(format, firstName, t?.key ?? 'team', iss.number, iss.title)
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
    escape: () => { if (menu) setMenu(null); else router.push('/pm/issues') },
    'mod+shift+b': (e) => { if (!FEATURES.pm_github) return; e.preventDefault(); copyBranchName() },
    ...Object.fromEntries([0, 1, 2, 3, 4].map((p) => [String(p), () => doPriority(p)])),
  })

  if (detail.isLoading || !issue) {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }

  const team = store?.teams.get(issue.team_id)
  const states = store ? store.statesForTeam(issue.team_id) : []
  const state = states.find((s) => s.id === issue.state_id)
  // Uniform {id, name, avatar_url} regardless of source (engine store or the
  // REST fallback) — the mention picker + avatar lookups need non-null names.
  const users = (store ? [...store.users.values()] : (usersQ.data ?? [])).map((u) => ({
    id: u.id,
    name: u.name ?? '—',
    avatar_url: u.avatar_url ?? null,
  }))
  const assignee = issue.assignee_user_id ? users.find((u) => u.id === issue.assignee_user_id) : null
  const doneChildren = (d?.sub_issues ?? []).filter((s) => s.completed_at).length

  // ── @-mention dropdown state (derived from the composer text) ──
  const mentionMatch = comment.match(/@([\w .-]*)$/)
  const mentionQuery = mentionMatch?.[1]?.toLowerCase() ?? null
  const mentionOptions =
    mentionQuery !== null
      ? users
          .filter((u) => u.id !== me?.id && u.name.toLowerCase().includes(mentionQuery))
          .slice(0, 6)
      : []
  const pickMention = (u: { id: string; name: string }) => {
    setComment(comment.replace(/@([\w .-]*)$/, `@${u.name} `))
    setMentioned((prev) => (prev.some((m) => m.id === u.id) ? prev : [...prev, { id: u.id, name: u.name }]))
    setMentionIdx(0)
  }
  const submitComment = () => {
    const body = comment.trim()
    if (!body || postComment.isPending) return
    const ids = [...new Set(mentioned.filter((m) => body.includes(`@${m.name}`)).map((m) => m.id))]
    postComment.mutate({ body, mentioned_user_ids: ids })
  }

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 1120, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Btn kind="ghost" size="sm" icon={<Icon.chevL size={13} />} onClick={() => router.push('/pm/issues')}>
          {team?.key ?? 'Issues'}
        </Btn>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>
          {team?.key}-{issue.number}
        </span>
        {(issue as PmIssueRow)._pending && <PendingDot />}
        <span style={{ flex: 1 }} />
        <Btn kind="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(`${team?.key}-${issue.number}`) }}>
          Copy ID <Kbd style={{ marginLeft: 5 }}>⌘⇧.</Kbd>
        </Btn>
        {FEATURES.pm_github && (
          <Btn kind="ghost" size="sm" icon={<Icon.gitBranch size={12} />} onClick={copyBranchName} title="Copy branch name">
            Branch <Kbd style={{ marginLeft: 5 }}>⌘⇧B</Kbd>
          </Btn>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, alignItems: 'start' }}>
        {/* ── Doc pane ── */}
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.3, marginBottom: 14 }}>
            {issue.title}
          </h1>

          <div className="card" style={{ padding: 16, marginBottom: 16 }}>
            {editingDesc ? (
              <>
                <textarea
                  autoFocus
                  className="input"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="Describe the task — markdown supported"
                  style={{ width: '100%', minHeight: 140, resize: 'vertical', fontSize: 12.5, lineHeight: 1.6, padding: 10 }}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveDesc() }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                  <Btn kind="ghost" size="sm" onClick={() => { setEditingDesc(false); setDesc(d?.issue.description ?? '') }}>Cancel</Btn>
                  <Btn kind="primary" size="sm" onClick={saveDesc}>Save <Kbd style={{ marginLeft: 5, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>⌘↵</Kbd></Btn>
                </div>
              </>
            ) : (
              <div onClick={() => setEditingDesc(true)} style={{ cursor: 'text', minHeight: 40 }}>
                {desc ? (
                  <div style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{desc}</div>
                ) : (
                  <div className="t-mute" style={{ fontSize: 12 }}>Add a description…</div>
                )}
              </div>
            )}
          </div>

          {/* Sub-issues */}
          {(d?.sub_issues.length ?? 0) > 0 && (
            <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
                <span className="t-caption">Sub-issues</span>
                <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                  {doneChildren}/{d!.sub_issues.length}
                </span>
              </div>
              {d!.sub_issues.map((s, i) => (
                <div key={s.id} onClick={() => router.push(`/pm/issues/${s.id}`)}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, height: 32, padding: '0 14px', cursor: 'pointer', borderBottom: i < d!.sub_issues.length - 1 ? '1px solid var(--bord)' : 'none' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{team?.key}-{s.number}</span>
                  <PriorityGlyph p={s.priority} size={12} />
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 700, textDecoration: s.completed_at ? 'line-through' : 'none', opacity: s.completed_at ? 0.6 : 1 }}>{s.title}</span>
                </div>
              ))}
            </div>
          )}

          {/* Relations */}
          {(d?.relations.length ?? 0) > 0 && (
            <div className="card" style={{ padding: '10px 14px', marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="t-caption">Relations</span>
              {d!.relations.map((r) => {
                const otherId = r.issue_id === id ? r.related_issue_id : r.issue_id
                const other = store?.issues.get(otherId)
                const label = r.issue_id === id ? r.type.replace(/_/g, ' ') : r.type === 'blocks' ? 'blocked by' : r.type.replace(/_/g, ' ')
                return (
                  <button key={r.id} onClick={() => router.push(`/pm/issues/${otherId}`)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 7, background: 'var(--surf-1)', border: '1px solid var(--bord)', color: 'var(--text-2)', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>
                    <span style={{ color: r.type === 'blocks' ? 'var(--coral)' : 'var(--text-faint)' }}>{label}</span>
                    {team?.key}-{other?.number ?? '…'}
                  </button>
                )
              })}
            </div>
          )}

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
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
              <span className="t-caption">Activity</span>
            </div>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {(d?.history ?? []).slice(0, 8).reverse().map((h) => (
                <div key={h.id} style={{ display: 'flex', gap: 8, padding: '7px 14px', fontSize: 11, color: 'var(--text-mute)', borderBottom: '1px solid var(--bord)' }}>
                  <span style={{ fontWeight: 800, color: 'var(--text-2)' }}>{users.find((u) => u.id === h.actor_user_id)?.name ?? '—'}</span>
                  <span>set {h.field}: {h.from_value ?? '—'} → <b style={{ color: 'var(--text-2)' }}>{h.to_value ?? '—'}</b></span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{new Date(h.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              ))}
              {(d?.comments ?? []).map((c) => (
                <div key={c.id} style={{ display: 'flex', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--bord)', marginLeft: c.parent_comment_id ? 26 : 0 }}>
                  <MiniAv name={users.find((u) => u.id === c.author_user_id)?.name ?? '?'} size={22} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 11.5, fontWeight: 800 }}>{users.find((u) => u.id === c.author_user_id)?.name ?? '—'}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{new Date(c.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: 3 }}>{c.body}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 9, padding: 12, position: 'relative' }}>
              {mentionOptions.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% - 4px)',
                    left: 12,
                    width: 240,
                    zIndex: 60,
                    background: 'rgba(18,18,30,.98)',
                    border: '1px solid var(--bord-2)',
                    borderRadius: 10,
                    padding: 4,
                    boxShadow: '0 16px 40px rgba(0,0,0,.55)',
                  }}
                >
                  {mentionOptions.map((u, i) => (
                    <button
                      key={u.id}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); pickMention(u) }}
                      onMouseEnter={() => setMentionIdx(i)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 7,
                        border: 'none',
                        cursor: 'pointer',
                        background: i === mentionIdx ? 'var(--surf-2)' : 'transparent',
                        color: '#fff',
                      }}
                    >
                      <MiniAv name={u.name} size={18} />
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{u.name}</span>
                    </button>
                  ))}
                </div>
              )}
              <input
                className="input"
                value={comment}
                onChange={(e) => { setComment(e.target.value); setMentionIdx(0) }}
                onKeyDown={(e) => {
                  if (mentionOptions.length > 0) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionOptions.length); return }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionOptions.length) % mentionOptions.length); return }
                    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pickMention(mentionOptions[mentionIdx] ?? mentionOptions[0]!); return }
                    if (e.key === 'Escape') { e.preventDefault(); setComment(comment.replace(/@([\w .-]*)$/, '')); return }
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitComment()
                }}
                placeholder="Leave a comment… @ to mention (⌘↵ to send)"
                style={{ flex: 1, height: 36 }}
              />
              <Btn kind="secondary" size="sm" disabled={!comment.trim() || postComment.isPending} onClick={submitComment}>
                Comment
              </Btn>
            </div>
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
            {assignee?.name ? <><MiniAv name={assignee.name} size={16} /> <span>{assignee.name}</span></> : <span className="t-mute">Unassigned</span>}
          </RailRow>
          {menu === 'assignee' && (
            <RailMenu>
              <button onClick={() => { doAssign(null); setMenu(null) }} style={railMenuRow(!issue.assignee_user_id)}>Unassigned</button>
              {users.map((u) => (
                <button key={u.id} onClick={() => { doAssign(u.id); setMenu(null) }} style={railMenuRow(u.id === issue.assignee_user_id)}>
                  <MiniAv name={u.name ?? '?'} size={15} /> {u.name}
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
                <MiniAv key={uid} name={users.find((u) => u.id === uid)?.name ?? '?'} size={18} />
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

function RailRow({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 6px', borderRadius: 8, cursor: onClick ? 'pointer' : 'default', position: 'relative' }}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.background = 'var(--surf-1)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
      <span style={{ width: 74, fontSize: 10.5, fontWeight: 800, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em', flexShrink: 0 }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700 }}>{children}</span>
    </div>
  )
}

function RailMenu({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ margin: '2px 0 6px 80px', background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 5, maxHeight: 220, overflowY: 'auto' }}>
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

function MiniAv({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: avBg(name), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: Math.max(7, size * 0.36), letterSpacing: '-0.02em', flexShrink: 0 }}>
      {initials(name)}
    </span>
  )
}
