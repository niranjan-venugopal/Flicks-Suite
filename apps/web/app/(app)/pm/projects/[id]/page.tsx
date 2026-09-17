'use client'

import { use, useEffect, useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { IssueComposer } from '@/components/pm/IssueComposer'
import { PmPage } from '@/components/pm/PmPage'
import { useUploadProjectLogo, useRemoveProjectLogo } from '@/lib/api/queries/use-media'
// react-easy-crop is modal-only weight — load it when the modal first opens.
const MediaCropModal = dynamic(
  () => import('@/components/media/MediaCropModal').then((m) => m.MediaCropModal),
  { ssr: false },
)
import { ProjectHeader } from '@/components/pm/project/ProjectHeader'
import { ProjectMilestones } from '@/components/pm/project/ProjectMilestones'
import { ProjectIssues } from '@/components/pm/project/ProjectIssues'
import { ProjectUpdates } from '@/components/pm/project/ProjectUpdates'
import { ProjectMembers } from '@/components/pm/project/ProjectMembers'
import { ProjectDescription } from '@/components/pm/project/ProjectDescription'
import { ProjectInsightsCard } from '@/components/pm/project/ProjectInsightsCard'
import { ProjectProgressGraph } from '@/components/pm/project/ProjectProgressGraph'
import type { ProjectDetail, ProjectIssueLite } from '@/components/pm/project/types'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { useAuthStore } from '@/lib/stores/auth.store'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmProjectRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// P11 — Project page: header (status/health/lead/dates/progress), milestones
// with progress bars (overdue amber), embedded issues, health-updates rail
// with the staleness chip. Live engine rows overlay the lazy REST detail;
// mutations go through the engine (sync) or REST (kill-switch).
//
// Round M — the cards live in components/pm/project/*; this file keeps the
// data loading (REST detail merged with the engine graph), the derived
// state, the page-level modals and the composition.
// ─────────────────────────────────────────────────────────

interface DetailResponse {
  data: ProjectDetail
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
  const issues: ProjectIssueLite[] = engine
    ? [...engine.store.issues.values()].filter((i) => i.project_id === id && !i.deleted_at).sort((a, b) => a.number - b.number)
    : d.issues

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

  const lastUpdateAt = updates[0]?.created_at
  const staleDays = lastUpdateAt ? Math.floor((Date.now() - new Date(lastUpdateAt).getTime()) / 86_400_000) : null

  // ── Agent C ── Round M: the Latest update card + its composer. Page state so
  // the card's Update button and its empty state (and anything later) share
  // one dialog; the composer seeds health from the live project row on open.
  const [updateComposer, setUpdateComposer] = useState(false)

  // ── Agent B ── Round M: the rail's Insights card + Progress graph. "Set
  // default for everyone" follows the delete bar (manager and above, or the
  // project lead) — the server enforces the same rule.
  const canSetInsightsDefault =
    mayDelete || (!!project.lead_user_id && project.lead_user_id === currentUser?.id)
  // ── /Agent B ──

  return (
    <PmPage>
      <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 800, marginBottom: 12 }}>
        <Icon.chevL size={13} /> Projects
      </button>

      {/* Header — full width, above the two-column grid (Agent A owns the
          layout; the slots below sit where the main column starts). */}
      <ProjectHeader
        project={project}
        summary={d.project.summary}
        progress={progress}
        logoUrl={logoUrl}
        leadName={leadName}
        users={users}
        mayDelete={mayDelete}
        patchProject={patchProject}
        onOpenLogo={() => setLogoModal(true)}
        onDelete={() => setConfirmDelete(true)}
      />
      {/* Round M — Latest update (Agent C): health + body + what changed since the previous update. */}
      <ProjectUpdates
        projectId={id}
        engine={engine}
        project={project}
        updates={updates}
        users={users}
        staleDays={staleDays}
        invalidate={invalidate}
        composerOpen={updateComposer}
        onOpenComposer={() => setUpdateComposer(true)}
        onCloseComposer={() => setUpdateComposer(false)}
      />
      {/* Round M — the project description (Round L editor + attachments on
          object type 'project'). Same edit bar as the header's fields, the
          milestones card and the API's project PATCH (assertNotGuestTx +
          the `pm edit` grant): any non-guest, non-auditor member. Viewers
          see it only when there is something to read. */}
      <ProjectDescription
        projectId={id}
        engine={engine}
        value={d.project.description_md ?? ''}
        canEdit={!!role && role !== 'GUEST' && role !== 'AUDITOR'}
        invalidate={invalidate}
      />

      <div className="pm-split" style={{ '--pm-rail': '360px' } as CSSProperties}>
        <div style={{ minWidth: 0 }}>
          <ProjectMilestones
            projectId={id}
            engine={engine}
            milestones={milestones}
            restIssues={d.issues}
            invalidate={invalidate}
          />
          <ProjectIssues
            projectId={id}
            engine={engine}
            issues={issues}
            onNewIssue={() => setNewIssue(true)}
            newIssueDisabled={allTeams.length === 0 && !teamsQ.isLoading}
          />
        </div>

        {/* Right rail (Round M): Insights → Progress → Members → Guests. One
            wrapper div, because a third auto-placed grid child lands in row 2
            column 1 (full width), which is where the Guests card had been
            rendering (founder round A). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <ProjectInsightsCard
            projectId={id}
            engine={engine}
            insightsDefault={project.insights_default}
            canSetDefault={canSetInsightsDefault}
          />
          <ProjectProgressGraph
            projectId={id}
            engine={engine}
            targetDate={project.target_date}
          />
          <ProjectMembers
            projectId={id}
            leadUserId={project.lead_user_id}
            isPrivate={project.is_private ?? false}
            engine={engine}
          />
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
    </PmPage>
  )
})
