'use client'

import { use, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Modal } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { IssueComposer } from '@/components/pm/IssueComposer'
import { DateField } from '@/components/ui/date-picker'
import { DiamondGlyph, HealthChip, Kbd, PmProgressBar, PriorityGlyph, StateGlyph, PM_HEALTH, PM_PROJECT_STATUS_LABEL, PendingDot } from '@/components/pm/glyphs'
import { PmAv, PROJECT_ICONS, ProjectLogo } from '@/components/pm/projects'
import { useUploadProjectLogo, useRemoveProjectLogo } from '@/lib/api/queries/use-media'
// react-easy-crop is modal-only weight — load it when the modal first opens.
const MediaCropModal = dynamic(
  () => import('@/components/media/MediaCropModal').then((m) => m.MediaCropModal),
  { ssr: false },
)
import { ProjectGuestsCard } from '@/components/pm/ProjectGuestsCard'
import { ProjectMembersCard } from '@/components/pm/ProjectMembersCard'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { useAuthStore } from '@/lib/stores/auth.store'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmIssueRow, PmMilestoneRow, PmProjectRow, PmUpdateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// P11 — Project page: header (status/health/lead/dates/progress), milestones
// with progress bars (overdue amber), embedded issues, health-updates rail
// with the staleness chip. Live engine rows overlay the lazy REST detail;
// mutations go through the engine (sync) or REST (kill-switch).
// ─────────────────────────────────────────────────────────

interface DetailResponse {
  data: {
    project: PmProjectRow & { description_md: string | null; summary: string | null }
    milestones: PmMilestoneRow[]
    updates: PmUpdateRow[]
    team_ids: string[]
    member_ids: string[]
    issues: Array<{
      id: string; team_id: string; number: number; title: string; state_id: string
      priority: number; milestone_id: string | null; completed_at: string | null
    }>
    progress: { scope: number; started: number; done: number }
  }
}

// Union of the lazy REST payload and the live engine rows, keyed by id, live
// winning per row. Rows only REST knows survive (bootstrap subsets, history
// past the store's window); rows only the store knows survive (created
// optimistically moments ago); rows the store tombstoned this session are
// dropped even if a stale REST payload still carries them. The previous pick
// — whichever whole ARRAY was longer — flipped sources wholesale, so rows
// present only on the shorter side silently vanished (founder round A).
function mergeById<T extends { id: string }>(
  rest: T[],
  live: T[] | null,
  tombstoned: { has(id: string): boolean } | undefined,
  sort: (a: T, b: T) => number,
): T[] {
  if (!live) return rest
  const byId = new Map<string, T>()
  for (const row of rest) if (!tombstoned?.has(row.id)) byId.set(row.id, row)
  for (const row of live) byId.set(row.id, row)
  return [...byId.values()].sort(sort)
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { mode, engine } = usePm()
  const router = useRouter()
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: ['pm', 'project-detail', id],
    queryFn: () => api.get<DetailResponse>(`/api/v1/pm/projects/${id}/detail`),
  })
  // Round E — the refetch is immediate now: in sync mode the engine's flush
  // ack (onFlushed, below) drives the authoritative one, and in REST mode the
  // mutation has already committed by the time onSuccess runs. The old 700ms
  // guess-timer was the reason fresh milestones/updates blinked in late.
  const invalidate = () => qc.invalidateQueries({ queryKey: ['pm', 'project-detail', id] })

  // Round E — render instantly off the engine graph: the header, milestones,
  // issues and updates all come from the store, so only a REST-mode first
  // visit still needs to wait for the detail fetch.
  const liveProject = mode === 'sync' && engine ? engine.store.projects.get(id) : null
  if (detail.isLoading && !liveProject) {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }
  const d: DetailResponse['data'] | undefined =
    detail.data?.data ??
    (liveProject && engine
      ? {
          project: { ...liveProject, description_md: null },
          milestones: [],
          updates: [],
          team_ids: engine.store.projectTeams.get(id) ?? [],
          member_ids: [],
          issues: [],
          progress: { scope: 0, started: 0, done: 0 },
        }
      : undefined)
  if (!d) {
    return <div className="t-mute" style={{ padding: 60, textAlign: 'center', fontSize: 12.5 }}>Project not found — it may be deleted or private.</div>
  }
  return <ProjectBody id={id} d={d} engine={mode === 'sync' ? engine : null} onBack={() => router.push('/pm/projects')} invalidate={invalidate} />
}

const ProjectBody = observer(function ProjectBody({ id, d, engine, onBack, invalidate }: {
  id: string
  d: DetailResponse['data']
  engine: PmSyncEngine | null
  onBack: () => void
  invalidate: () => void
}) {
  const qc = useQueryClient()
  const live = engine?.store.projects.get(id)
  const project = { ...d.project, ...(live ?? {}) }

  // Round E — sync mode: refetch the lazy REST detail when OUR writes that
  // touch this project are acked (the project itself, its milestones, its
  // health updates, or an issue inside it) — the same correct-by-construction
  // pattern the issue page uses, replacing this page's 700ms guess-timer.
  useEffect(() => {
    if (!engine) return
    return engine.onFlushed((acked) => {
      const st = engine.store
      const touchesProject = acked.some(
        (a) =>
          a.id === id ||
          st.milestones.get(a.id)?.project_id === id ||
          st.projectUpdates.get(a.id)?.project_id === id ||
          st.issues.get(a.id)?.project_id === id,
      )
      if (touchesProject) void qc.invalidateQueries({ queryKey: ['pm', 'project-detail', id] })
    })
  }, [engine, id, qc])
  const tombstoned = engine?.store.tombstoned
  const milestones = mergeById(
    d.milestones, engine ? engine.store.milestonesForProject(id) : null, tombstoned,
    (a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : 1),
  )
  const updates = mergeById(
    d.updates, engine ? engine.store.updatesForProject(id) : null, tombstoned,
    (a, b) => (a.created_at < b.created_at ? 1 : -1),
  )
  const progress = engine ? engine.store.projectProgress(id) : d.progress
  const issues: Array<Pick<PmIssueRow, 'id' | 'team_id' | 'number' | 'title' | 'state_id' | 'priority'>> = engine
    ? [...engine.store.issues.values()].filter((i) => i.project_id === id && !i.deleted_at).sort((a, b) => a.number - b.number)
    : d.issues

  const [health, setHealth] = useState<'on_track' | 'at_risk' | 'off_track'>(project.health)
  const [upTxt, setUpTxt] = useState('')
  const [addMs, setAddMs] = useState(false)
  const [msName, setMsName] = useState('')
  const [msDate, setMsDate] = useState('')

  const users = engine ? engine.store.users : null
  const leadName = project.lead_user_id ? users?.get(project.lead_user_id)?.name ?? '' : ''

  const restPatch = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/api/v1/pm/projects/${id}`, patch),
    onSuccess: invalidate,
  })
  const patchProject = (patch: Partial<PmProjectRow>) => {
    if (engine) engine.updateProject(id, patch)
    else restPatch.mutate(patch)
  }

  // ── Rename / re-icon in place (founder round C) ───────────────────────────
  // The backend and engine accepted {name, icon} since P11; only the header UI
  // was missing. Blank names are dropped client-side to match the server's
  // non-blank guard; an icon outside the stock list is offered as-is so the
  // select doesn't silently rewrite it.
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const commitName = () => {
    setEditingName(false)
    const next = nameDraft.trim()
    if (next && next !== project.name) patchProject({ name: next })
  }
  const currentIcon = project.icon ?? '🎯'
  const iconOptions = PROJECT_ICONS.includes(currentIcon) ? PROJECT_ICONS : [currentIcon, ...PROJECT_ICONS]

  // ── Project logo (round E) — the tenant-logo pipeline per project. The
  // crop modal is shared with avatars/company logo; upload/remove invalidate
  // the REST payloads and a delta pull refreshes the engine graph (the
  // server publishes a pm_projects sync ref on both).
  const [logoModal, setLogoModal] = useState(false)
  const uploadLogo = useUploadProjectLogo(id)
  const removeLogo = useRemoveProjectLogo(id)
  const logoUrl = (project as { logo_url?: string | null }).logo_url ?? null

  // ── Delete this project (founder round 20) ────────────────────────────────
  // Same engine-or-REST branch as patchProject above. Either way we leave for
  // the list afterwards: this page's own "not found" state would otherwise be
  // the thing the user lands on, which reads like an error rather than success.
  const { currentUser } = useAuthStore()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const restDelete = useMutation({
    mutationFn: () => api.post(`/api/v1/pm/projects/${id}/delete`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pm', 'projects'] })
      void qc.invalidateQueries({ queryKey: ['pm', 'recently-deleted'] })
      onBack()
    },
  })
  const role = currentUser?.role
  const mayDelete =
    !!role &&
    role !== 'GUEST' &&
    role !== 'AUDITOR' &&
    (['OWNER', 'HR_ADMIN', 'MANAGER', 'FINANCE'].includes(role) ||
      (!!project.lead_user_id && project.lead_user_id === currentUser?.id))
  const doDelete = () => {
    if (engine) {
      engine.deleteProject(id)
      setConfirmDelete(false)
      onBack()
    } else {
      restDelete.mutate()
    }
  }

  const postUpdate = () => {
    if (!upTxt.trim()) return
    // Both branches refresh the REST detail: in sync mode the merge above
    // shows the new row instantly from the store, but a stale REST payload
    // would otherwise keep resurrecting rows the server has since replaced.
    if (engine) engine.postProjectUpdate(id, health, upTxt.trim()) // onFlushed refetches on ack
    else void api.post(`/api/v1/pm/projects/${id}/updates`, { health, body_md: upTxt.trim() }).then(invalidate)
    setUpTxt('')
  }

  const addMilestone = () => {
    if (!msName.trim()) return
    if (engine) engine.createMilestone(id, msName.trim(), msDate || null) // onFlushed refetches on ack
    else void api.post('/api/v1/pm/milestones', { project_id: id, name: msName.trim(), target_date: msDate || null }).then(invalidate)
    setMsName(''); setMsDate(''); setAddMs(false)
  }

  // ── New issue (founder round 13): create straight from the project page,
  // pre-linked to this project + an optional milestone. Teams linked to the
  // project are offered first; a project with no linked team falls back to
  // every team the caller can see.
  const [newIssue, setNewIssue] = useState(false)
  const teamsQ = useQuery({
    queryKey: ['pm', 'teams', 'index'],
    queryFn: () => api.get<{ data: { teams: Array<{ id: string; key: string; name: string }> } }>('/api/v1/pm/teams'),
    enabled: !engine,
  })
  const linkedTeamIds = engine ? engine.store.projectTeams.get(id) ?? d.team_ids : d.team_ids
  const allTeams = engine
    ? engine.store.teamList().map((t) => ({ id: t.id, name: t.name }))
    : (teamsQ.data?.data.teams ?? []).map((t) => ({ id: t.id, name: t.name }))
  const teamOptions = linkedTeamIds.length
    ? linkedTeamIds.map((tid) => ({ id: tid, name: allTeams.find((t) => t.id === tid)?.name ?? 'Team' }))
    : allTeams
  // Milestone completion fraction: issues attached to it, weight = estimate ?? 1.
  const msProgress = (msId: string): number => {
    const rows = engine
      ? [...engine.store.issues.values()].filter((i) => i.milestone_id === msId && !i.deleted_at)
      : d.issues.filter((i) => i.milestone_id === msId)
    if (!rows.length) return 0
    let scope = 0
    let done = 0
    for (const r of rows) {
      const w = (r as PmIssueRow).estimate != null ? Number((r as PmIssueRow).estimate) : 1
      scope += w
      const cat = engine ? engine.store.states.get(r.state_id)?.category : undefined
      const isDone = engine ? cat === 'completed' : Boolean((r as { completed_at?: string | null }).completed_at)
      if (isDone) done += w
    }
    return scope ? done / scope : 0
  }

  const lastUpdateAt = updates[0]?.created_at
  const staleDays = lastUpdateAt ? Math.floor((Date.now() - new Date(lastUpdateAt).getTime()) / 86_400_000) : null

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 980, margin: '0 auto' }}>
      <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 800, marginBottom: 12 }}>
        <Icon.chevL size={13} /> Projects
      </button>

      {/* Header */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 9, flexWrap: 'wrap' }}>
          {/* Round E — the project's face: uploaded logo (click to change)
              or the emoji icon picker. */}
          <button
            type="button"
            title={logoUrl ? 'Change or remove the project logo' : 'Upload a project logo'}
            onClick={() => setLogoModal(true)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)', cursor: 'pointer', padding: 0 }}
          >
            {logoUrl ? <ProjectLogo logoUrl={logoUrl} icon={currentIcon} size={30} /> : <Icon.image size={14} style={{ color: 'var(--text-faint)' }} />}
          </button>
          <select
            className="input"
            title="Project icon"
            aria-label="Project icon"
            value={currentIcon}
            onChange={(e) => patchProject({ icon: e.target.value })}
            style={{ height: 30, width: 52, padding: '0 6px', fontSize: 16 }}
          >
            {iconOptions.map((e) => <option key={e}>{e}</option>)}
          </select>
          {editingName ? (
            <input
              autoFocus
              className="input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
                if (e.key === 'Escape') setEditingName(false)
              }}
              style={{ height: 32, width: 280, fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}
            />
          ) : (
            <span
              title="Rename project"
              onClick={() => { setNameDraft(project.name); setEditingName(true) }}
              style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em', cursor: 'text' }}
            >
              {project.name}
            </span>
          )}
          {project.is_private && (
            <span title="Private project — only members, the lead and owners/admins can see it"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-mute)', fontSize: 10, fontWeight: 800 }}>
              <Icon.lock size={12} /> Private
            </span>
          )}
          {project._pending && <PendingDot />}
          <select className="input" value={project.status} onChange={(e) => patchProject({ status: e.target.value as PmProjectRow['status'] })}
            style={{ height: 28, width: 130, fontSize: 11, fontWeight: 800 }}>
            {Object.entries(PM_PROJECT_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <HealthChip h={project.health} />
          <span style={{ flex: 1 }} />
          {leadName && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700 }}>
              <PmAv name={leadName} src={project.lead_user_id ? users?.get(project.lead_user_id)?.avatar_url : null} size={18} />{leadName}
            </span>
          )}
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <DateField value={project.start_date ?? ''} onChange={(iso) => patchProject({ start_date: iso || null })} style={{ height: 26, width: 120, fontSize: 10 }} />
            →
            <DateField value={project.target_date ?? ''} onChange={(iso) => patchProject({ target_date: iso || null })} style={{ height: 26, width: 120, fontSize: 10 }} />
          </span>
          {mayDelete && (
            <button
              type="button"
              title="Delete project"
              aria-label="Delete project"
              onClick={() => setConfirmDelete(true)}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, background: 'var(--surf-1)', border: '1px solid var(--bord)', color: 'var(--text-mute)', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--coral)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-mute)' }}
            >
              <Icon.trash size={14} />
            </button>
          )}
        </div>
        {d.project.summary && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>{d.project.summary}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}><PmProgressBar {...progress} h={7} /></span>
          <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>
            {progress.done} done · {progress.started} started · {progress.scope} scope
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 14, alignItems: 'start' }}>
        <div>
          {/* Milestones */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <DiamondGlyph size={12} color="var(--yellow)" />
              <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Milestones</span>
              <button onClick={() => setAddMs(true)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}>+ Add</button>
            </div>
            {milestones.length === 0 && !addMs && (
              <div className="t-mute" style={{ padding: '16px 14px', fontSize: 11.5 }}>No milestones yet — break the outcome into checkpoints.</div>
            )}
            {milestones.map((m, mi) => {
              const frac = msProgress(m.id)
              const overdue = m.target_date && frac < 1 && new Date(m.target_date) < new Date()
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px', borderBottom: mi < milestones.length - 1 || addMs ? '1px solid var(--bord)' : 'none' }}>
                  <DiamondGlyph size={11} color={frac >= 1 ? 'var(--green)' : overdue ? 'var(--yellow)' : 'var(--text-faint)'} />
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 750, color: frac >= 1 ? 'var(--text-mute)' : '#fff' }}>{m.name}</span>
                  <span style={{ width: 110 }}>
                    <div style={{ height: 5, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
                      <div style={{ width: `${frac * 100}%`, height: '100%', background: frac >= 1 ? 'var(--green)' : 'var(--blue)' }} />
                    </div>
                  </span>
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: overdue ? 'var(--yellow)' : 'var(--text-faint)', width: 52, textAlign: 'right' }}>
                    {m.target_date ? new Date(m.target_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                  </span>
                </div>
              )
            })}
            {addMs && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 14px' }}>
                <DiamondGlyph size={11} />
                <input autoFocus placeholder="Milestone name…" value={msName} onChange={(e) => setMsName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addMilestone(); if (e.key === 'Escape') setAddMs(false) }}
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }} />
                <DateField value={msDate} onChange={setMsDate} style={{ height: 26, width: 130, fontSize: 10.5 }} />
                <Kbd>⏎</Kbd>
              </div>
            )}
          </div>

          {/* Embedded issues */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px 8px 14px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Issues · {issues.length}</span>
              {/* Round E — a real button (the old text link read as decoration),
                  and never dead while teams are still loading: the composer
                  loads its own team list on open, so only a genuinely
                  team-less workspace disables it. */}
              <Btn
                kind="secondary"
                size="sm"
                icon={<Icon.plus size={12} />}
                onClick={() => setNewIssue(true)}
                disabled={allTeams.length === 0 && !teamsQ.isLoading}
              >
                New issue
              </Btn>
            </div>
            {issues.length === 0 && <div className="t-mute" style={{ padding: '16px 14px', fontSize: 11.5 }}>No issues attached — set a project on issues from the list or detail page.</div>}
            {issues.map((i) => {
              const st = engine?.store.states.get(i.state_id)
              const team = engine?.store.teams.get(i.team_id)
              return (
                <a key={i.id} href={`/pm/issues/${i.id}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, height: 34, padding: '0 12px', borderBottom: '1px solid var(--bord)', textDecoration: 'none' }}>
                  {st && <StateGlyph cat={st.category} size={13} />}
                  <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', width: 58, flexShrink: 0 }}>
                    {team?.key ?? ''}-{i.number}
                  </span>
                  <PriorityGlyph p={i.priority} size={13} />
                  <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.title}</span>
                </a>
              )
            })}
          </div>
        </div>

        {/* Right rail: health updates + guests. One wrapper div, because the
            grid is '1fr 300px' — a third auto-placed child lands in row 2
            column 1 (full width), which is where the Guests card had been
            rendering (founder round A). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Health updates rail */}
        <div className="card" style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Health updates</span>
            {staleDays !== null && staleDays >= 2 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 99, background: 'rgba(254,216,0,.09)', border: '1px solid rgba(254,216,0,.35)', fontSize: 9, fontWeight: 800, color: 'var(--yellow)' }}>
                no update in {staleDays} days
              </span>
            )}
          </div>
          <div style={{ padding: '9px 11px', borderRadius: 10, background: 'var(--surf-1)', border: '1px solid var(--bord)', marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 7 }}>
              {(Object.keys(PM_HEALTH) as Array<'on_track' | 'at_risk' | 'off_track'>).map((k) => {
                const s = PM_HEALTH[k]!
                const active = health === k
                return (
                  <button key={k} onClick={() => setHealth(k)}
                    style={{ flex: 1, padding: '5px 0', borderRadius: 7, fontSize: 10, fontWeight: 800, cursor: 'pointer', background: active ? s.bg : 'transparent', border: `1px solid ${active ? s.border : 'var(--bord)'}`, color: active ? s.color : 'var(--text-2)' }}>
                    {s.label}
                  </button>
                )
              })}
            </div>
            <input placeholder="What changed this week?" value={upTxt} onChange={(e) => setUpTxt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') postUpdate() }}
              className="input" style={{ height: 30, fontSize: 11.5, marginBottom: 6, width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Btn kind="primary" size="sm" onClick={postUpdate} disabled={!upTxt.trim()}>Post update</Btn>
            </div>
          </div>
          {updates.map((u, ui) => {
            const author = u.author_user_id ? users?.get(u.author_user_id)?.name ?? 'Member' : 'Member'
            return (
              <div key={u.id} style={{ paddingBottom: 11, marginBottom: 11, borderBottom: ui < updates.length - 1 ? '1px solid var(--bord)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                  <PmAv name={author} src={u.author_user_id ? users?.get(u.author_user_id)?.avatar_url : null} size={16} />
                  <span style={{ fontSize: 10.5, fontWeight: 800 }}>{author}</span>
                  <HealthChip h={u.health} small />
                  <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: 'var(--text-faint)' }}>
                    {new Date(u.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{u.body_md}</div>
              </div>
            )
          })}
          <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)' }}>
            Leads are nudged in the Inbox when stale &gt; 7 days — never auto-generated.
          </div>
        </div>

        {/* Round E — internal members + the Private switch */}
        <ProjectMembersCard
          projectId={id}
          leadUserId={project.lead_user_id}
          isPrivate={project.is_private ?? false}
          engine={engine}
        />

        {/* Round 7 guest seats; round A: lead + manager-and-above */}
        <ProjectGuestsCard projectId={id} leadUserId={project.lead_user_id} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete project"
        body={`“${project.name}” will be removed from Projects.${
          issues.length === 1
            ? ' Its 1 issue is deleted with it.'
            : issues.length > 1
              ? ` Its ${issues.length} issues are deleted with it.`
              : ''
        } You can put it back for 30 days from Settings → Workspace → Recently deleted; after that it is gone for good.`}
        confirmLabel="Delete"
        danger
        loading={restDelete.isPending}
        loadingLabel="Deleting…"
        onConfirm={doDelete}
      />

      {/* New issue — the shared composer (round B), pre-linked to this
          project; the team picker is restricted to the project's teams. */}
      <IssueComposer
        open={newIssue}
        onClose={() => setNewIssue(false)}
        engine={engine}
        teamId={teamOptions[0]?.id}
        teamOptions={teamOptions}
        projectId={id}
        projectName={project.name}
        onCreated={invalidate}
      />

      {logoModal && (
        <MediaCropModal
          kind="logo"
          hasCurrent={!!logoUrl}
          onClose={() => setLogoModal(false)}
          onUpload={async (blob) => {
            await uploadLogo.mutateAsync(blob)
            if (engine) void engine.pullDelta() // server published the pm_projects ref
          }}
          onRemove={async () => {
            await removeLogo.mutateAsync()
            if (engine) void engine.pullDelta()
          }}
        />
      )}
    </div>
  )
})
