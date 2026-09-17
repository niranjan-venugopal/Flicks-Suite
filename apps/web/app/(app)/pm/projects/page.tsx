'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { PmPage } from '@/components/pm/PmPage'
import { ProjectCreateModal } from '@/components/pm/projects'
import {
  EMPTY_MILESTONES,
  EMPTY_PROGRESS,
  PROJECT_SORTS,
  ProjectListRow,
  projectMilestoneSummaryAll,
  sortProjects,
  type MilestoneSummary,
  type ProjectProgress,
  type ProjectSort,
} from '@/components/pm/project/ProjectListRow'
import { progressPct } from '@/components/pm/project/ProgressRing'
import { GuestWorkspaceNudge } from '@/components/pm/GuestWorkspaceNudge'
import { FirstRunChecklist } from '@/components/pm/FirstRunChecklist'
import { api } from '@/lib/api/client'
import { uploadProjectLogoBlob } from '@/lib/api/queries/use-media'
import { usePm } from '@/lib/pm/PmProvider'
import { useAuthStore } from '@/lib/stores/auth.store'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmProjectRow, PmTeamRow } from '@/lib/pm/types'

/**
 * Who gets the delete affordance, mirroring the server bar in
 * projects.service.ts `assertMayDeleteProject`: manager and above, or the
 * project's own lead. Web roles are UPPERCASE, the API's are lowercase — the
 * comparison has to happen on the right side of that split.
 */
function canDeleteProject(role: string | undefined, leadUserId: string | null, meId: string): boolean {
  if (!role || role === 'GUEST' || role === 'AUDITOR') return false
  if (['OWNER', 'HR_ADMIN', 'MANAGER', 'FINANCE'].includes(role)) return true
  return !!leadUserId && leadUserId === meId
}

/** Shared confirm copy — the same words on the list row and the detail page. */
function deleteBody(name: string, issueCount: number | null): string {
  const issues =
    issueCount === null
      ? ' Its issues are deleted with it.'
      : issueCount === 1
        ? ' Its 1 issue is deleted with it.'
        : issueCount > 1
          ? ` Its ${issueCount} issues are deleted with it.`
          : ''
  return `“${name}” will be removed from Projects.${issues} You can put it back for 30 days from Settings → Workspace → Recently deleted; after that it is gone for good.`
}

// ─────────────────────────────────────────────────────────
// P11 — Projects list. Round M: one ProjectListRow for both transports
// (progress ring + %, priority glyph, milestones done/total, sort), inside
// the shared PmPage container. Sync mode renders straight off the local
// graph (progress + the milestone rollup computed client-side with the same
// formulas the server uses); REST fallback below reads them from the list
// payload.
// ─────────────────────────────────────────────────────────

export default function PmProjectsPage() {
  const { mode, engine } = usePm()
  if (mode === 'loading') {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }
  if (mode === 'rest' || !engine) return <RestProjects />
  return <SyncProjects engine={engine} />
}

/** Native select (house dropdown) — Target date is the list's long-standing default order. */
function SortSelect({ value, onChange }: { value: ProjectSort; onChange: (v: ProjectSort) => void }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 800, color: 'var(--text-mute)' }}>
      Sort
      <select
        className="input"
        data-testid="projects-sort"
        aria-label="Sort projects"
        value={value}
        onChange={(e) => onChange(e.target.value as ProjectSort)}
        style={{ height: 30, padding: '0 8px', fontSize: 11, width: 'auto' }}
      >
        {PROJECT_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  )
}

const SyncProjects = observer(function SyncProjects({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const router = useRouter()
  const { currentUser } = useAuthStore()
  const [tab, setTab] = useState<'all' | 'mine'>('all')
  const [sort, setSort] = useState<ProjectSort>('target')
  const [openNew, setOpenNew] = useState(false)

  const me = currentUser?.id ?? ''
  const isGuest = currentUser?.role === 'GUEST'
  const [deleting, setDeleting] = useState<PmProjectRow | null>(null)
  const projects = store.projectList().filter((p) => (tab === 'mine' ? p.lead_user_id === me : true))
  // Round E — one pass over the issue graph for every row's progress (this
  // render body used to scan all issues once PER project); Round M adds the
  // milestone rollup in one more pass.
  const progressAll = store.projectProgressAll()
  const milestonesAll = projectMilestoneSummaryAll(store)
  const pctOf = (id: string) => progressPct(progressAll.get(id) ?? EMPTY_PROGRESS)
  const sorted = sortProjects(projects, sort, pctOf)
  // Sync mode: the engine applies the delete optimistically and flushes it —
  // no await, no spinner. The row is gone the moment the dialog closes.
  const confirmDelete = () => {
    if (!deleting) return
    engine.deleteProject(deleting.id)
    setDeleting(null)
  }

  return (
    <PmPage>
      {/* Round 7: guest-only users get the "create your own workspace" strip */}
      <GuestWorkspaceNudge />
      <SectionHead
        title="Projects"
        sub="Projects group issues toward an outcome — one lead, a target date, honest health updates."
        right={<Pill tone="blue" dot>sync</Pill>}
      />
      {/* Round 12: the first-run tour lives on the module's main page and
          starts with "Create a project" — its chip opens the modal below. */}
      <FirstRunChecklist onCreateProject={() => setOpenNew(true)} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8 }}>
          {(isGuest
            ? ([['all', 'All projects']] as const)
            : ([['all', 'All projects'], ['mine', 'Led by me']] as const)
          ).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800 }}>
              {l}
            </button>
          ))}
        </div>
        <SortSelect value={sort} onChange={setSort} />
        <div style={{ flex: 1 }} />
        {/* Guests are project-scoped: creating projects / seeding sample data
            is a server-side 403 for them, so never offer the button. */}
        {!isGuest && (
          <>
            <SampleDataButton onAfterChange={() => { void engine.pullDelta() }} />
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setOpenNew(true)}>New project</Btn>
          </>
        )}
      </div>

      {sorted.length === 0 ? (
        <EmptyProjects onCta={() => setOpenNew(true)} hideCta={isGuest} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {sorted.map((p) => (
            <ProjectListRow key={p.id} p={p}
              progress={progressAll.get(p.id) ?? EMPTY_PROGRESS}
              milestones={milestonesAll.get(p.id) ?? EMPTY_MILESTONES}
              teamIds={store.projectTeams.get(p.id) ?? []}
              teams={store.teams as unknown as Map<string, PmTeamRow>}
              leadName={p.lead_user_id ? store.users.get(p.lead_user_id)?.name ?? '' : ''}
              leadAvatarUrl={p.lead_user_id ? store.users.get(p.lead_user_id)?.avatar_url ?? null : null}
              onOpen={() => router.push(`/pm/projects/${p.id}`)}
              onDelete={
                canDeleteProject(currentUser?.role, p.lead_user_id, me)
                  ? () => setDeleting(p)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete project"
        // Count the issues, not the progress bar's estimate points — the copy
        // promises to delete issues, so it has to say how many issues.
        body={
          deleting
            ? deleteBody(
                deleting.name,
                [...store.issues.values()].filter(
                  (i) => i.project_id === deleting.id && !i.deleted_at,
                ).length,
              )
            : ''
        }
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
      />

      <ProjectCreateModal
        open={openNew}
        onClose={() => setOpenNew(false)}
        teams={store.teamList()}
        users={[...store.users.values()]}
        meId={me}
        onCreate={(input, logoFile) => {
          // Round M — `priority` (when the modal sets it) rides the create op.
          const id = engine.createProject({ ...input, priority: input.priority })
          if (logoFile) {
            // The optimistic id isn't on the server yet — upload once the
            // create op is ACKED (round E; onFlushed is the same hook the
            // issue page uses), then pull the delta for the signed logo_url.
            const off = engine.onFlushed((acked) => {
              if (!acked.some((a) => a.id === id)) return
              off()
              void uploadProjectLogoBlob(id, logoFile)
                .then(() => engine.pullDelta())
                .catch(() => undefined) // logo is optional — the project stands
            })
          }
          router.push(`/pm/projects/${id}`)
        }}
      />
    </PmPage>
  )
})

function EmptyProjects({ onCta, hideCta = false }: { onCta: () => void; hideCta?: boolean }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '56px 24px', gap: 12 }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
        <Icon.target size={20} />
      </div>
      <div className="t-mute" style={{ fontSize: 12.5, textAlign: 'center', maxWidth: 380, lineHeight: 1.6 }}>
        Projects group issues toward an outcome — one lead, a target date, honest health updates.
      </div>
      {!hideCta && (
        <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={onCta}>New project</Btn>
      )}
    </div>
  )
}

// ─── REST MODE (kill-switch path) ────────────────────────────────────────────

interface RestProjectsResponse {
  data: {
    projects: PmProjectRow[]
    teams: Record<string, string[]>
    progress: Record<string, ProjectProgress>
    /** Round M — milestones done/total per project (the server's rollup). */
    milestones?: Record<string, MilestoneSummary>
  }
}

function RestProjects() {
  const router = useRouter()
  const qc = useQueryClient()
  const { currentUser } = useAuthStore()
  const isGuest = currentUser?.role === 'GUEST'
  const [openNew, setOpenNew] = useState(false)
  const [sort, setSort] = useState<ProjectSort>('target')
  const projectsQ = useQuery({
    queryKey: ['pm', 'projects'],
    queryFn: () => api.get<RestProjectsResponse>('/api/v1/pm/projects'),
  })
  const teamsQ = useQuery({
    queryKey: ['pm', 'teams'],
    queryFn: () => api.get<{ data: { teams: Array<{ id: string; key: string; name: string; color: string | null }>; } }>('/api/v1/pm/teams'),
  })
  const usersQ = useQuery({
    queryKey: ['pm', 'users'],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string | null; avatar_url: string | null }> }>('/api/v1/pm/users'),
  })
  const teamMap = useMemo(
    () => new Map((teamsQ.data?.data.teams ?? []).map((t) => [t.id, t])) as unknown as Map<string, PmTeamRow>,
    [teamsQ.data],
  )
  const usersById = useMemo(
    () => new Map((usersQ.data?.data ?? []).map((u) => [u.id, u])),
    [usersQ.data],
  )
  const d = projectsQ.data?.data
  const sorted = useMemo(
    () => (d ? sortProjects(d.projects, sort, (id) => progressPct(d.progress[id] ?? EMPTY_PROGRESS)) : []),
    [d, sort],
  )
  // REST mode has no local graph, so this is a real round-trip with a spinner.
  const [deleting, setDeleting] = useState<PmProjectRow | null>(null)
  const del = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/pm/projects/${id}/delete`, {}),
    onSuccess: () => {
      setDeleting(null)
      void qc.invalidateQueries({ queryKey: ['pm', 'projects'] })
      // The deleted project shows up under Settings → Workspace → Recently
      // deleted, so that list is stale the moment this succeeds.
      void qc.invalidateQueries({ queryKey: ['pm', 'recently-deleted'] })
    },
  })
  return (
    <PmPage>
      <GuestWorkspaceNudge />
      <SectionHead title="Projects" sub="One lead, a target date, honest health updates." right={<Pill tone="yellow" dot>rest</Pill>} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <SortSelect value={sort} onChange={setSort} />
        <div style={{ flex: 1 }} />
        {!isGuest && (
          <>
            <SampleDataButton />
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setOpenNew(true)}>New project</Btn>
          </>
        )}
      </div>
      {!d || d.projects.length === 0 ? (
        <EmptyProjects onCta={() => setOpenNew(true)} hideCta={isGuest} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {sorted.map((p) => (
            <ProjectListRow key={p.id} p={p}
              progress={d.progress[p.id] ?? EMPTY_PROGRESS}
              milestones={d.milestones?.[p.id] ?? EMPTY_MILESTONES}
              teamIds={d.teams[p.id] ?? []}
              teams={teamMap}
              leadName={p.lead_user_id ? usersById.get(p.lead_user_id)?.name ?? '' : ''}
              leadAvatarUrl={p.lead_user_id ? usersById.get(p.lead_user_id)?.avatar_url ?? null : null}
              onOpen={() => router.push(`/pm/projects/${p.id}`)}
              onDelete={
                canDeleteProject(currentUser?.role, p.lead_user_id, currentUser?.id ?? '')
                  ? () => setDeleting(p)
                  : undefined
              }
            />
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete project"
        // No local issue graph in REST mode — the copy stays truthful without
        // claiming a count it cannot know.
        body={deleting ? deleteBody(deleting.name, null) : ''}
        confirmLabel="Delete"
        danger
        loading={del.isPending}
        loadingLabel="Deleting…"
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
      <ProjectCreateModal
        open={openNew}
        onClose={() => setOpenNew(false)}
        teams={(teamsQ.data?.data.teams ?? []) as never}
        users={(usersQ.data?.data ?? []) as never}
        meId={currentUser?.id ?? ''}
        onCreate={(input, logoFile) => {
          // Round M — `priority` (when the modal sets it) rides the POST body.
          const body = { ...input, ...(input.priority !== undefined ? { priority: input.priority } : {}) }
          void api.post<{ data: { id: string } }>('/api/v1/pm/projects', body).then(async (res) => {
            if (logoFile) await uploadProjectLogoBlob(res.data.id, logoFile).catch(() => undefined)
            void qc.invalidateQueries({ queryKey: ['pm', 'projects'] })
            router.push(`/pm/projects/${res.data.id}`)
          })
        }}
      />
    </PmPage>
  )
}


// ─── Appendix B sample data (one-click, removable) ───────────────────────────

interface SampleStatus {
  data: {
    loaded: boolean
    sample_issues?: number
    sample_projects?: number
    own_issues_in_sample_projects?: number
    own_issues_in_sample_cycles?: number
    own_issues_with_sample_labels?: number
  }
}

function SampleDataButton({ onAfterChange }: { onAfterChange?: () => void }) {
  const qc = useQueryClient()
  // Removal destroys data, so it gets a ConfirmDialog like every other delete
  // in the app (founder round A: this was a one-click toggle sitting next to
  // "New project", and a second click after seeding wiped the pack with no
  // warning). Loading stays one click — it only adds.
  const [confirmRemove, setConfirmRemove] = useState(false)
  const status = useQuery({
    queryKey: ['pm', 'sample-data'],
    queryFn: () => api.get<SampleStatus>('/api/v1/pm/sample-data'),
  })
  const toggle = useMutation({
    mutationFn: () =>
      status.data?.data.loaded
        ? api.post('/api/v1/pm/sample-data/remove', {})
        : api.post('/api/v1/pm/sample-data', {}),
    onSuccess: () => {
      setConfirmRemove(false)
      void qc.invalidateQueries({ queryKey: ['pm'] })
      onAfterChange?.()
    },
  })
  const s = status.data?.data
  const loaded = s?.loaded ?? false
  const ownTouched =
    (s?.own_issues_in_sample_projects ?? 0) +
    (s?.own_issues_in_sample_cycles ?? 0) +
    (s?.own_issues_with_sample_labels ?? 0)
  return (
    <>
      <Btn kind="secondary" size="sm"
        icon={loaded ? <Icon.trash size={13} /> : <Icon.spark size={13} />}
        disabled={toggle.isPending || status.isLoading}
        onClick={() => (loaded ? setConfirmRemove(true) : toggle.mutate())}>
        {toggle.isPending ? 'Working…' : loaded ? 'Remove sample data' : 'Load sample data'}
      </Btn>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove sample data"
        body={
          `The ${s?.sample_issues ?? 0} sample issues, ${s?.sample_projects ?? 0} sample projects and their labels, cycles and initiatives will be removed for good.` +
          (ownTouched > 0
            ? ` ${ownTouched === 1 ? '1 issue of your own touches' : `${ownTouched} issues of your own touch`} the sample data — ${ownTouched === 1 ? 'it' : 'they'} will be kept, but moved out of sample projects and cycles and untagged from sample labels.`
            : ' None of your own work is attached to it.')
        }
        confirmLabel="Remove"
        danger
        loading={toggle.isPending}
        loadingLabel="Removing…"
        onConfirm={() => toggle.mutate()}
      />
    </>
  )
}
