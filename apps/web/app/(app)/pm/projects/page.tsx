'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { HealthChip, PmProgressBar } from '@/components/pm/glyphs'
import { PmAv, ProjectCreateModal, TeamKeyChips } from '@/components/pm/projects'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { useAuthStore } from '@/lib/stores/auth.store'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmProjectRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// P11 — Projects list: health chips, stacked progress, team keys, lead.
// Sync mode renders straight off the local graph (progress computed
// client-side with the same formula the server uses); REST fallback below.
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

const SyncProjects = observer(function SyncProjects({ engine }: { engine: PmSyncEngine }) {
  const store = engine.store
  const router = useRouter()
  const { currentUser } = useAuthStore()
  const [tab, setTab] = useState<'all' | 'mine'>('all')
  const [openNew, setOpenNew] = useState(false)

  const me = currentUser?.id ?? ''
  const projects = store.projectList().filter((p) => (tab === 'mine' ? p.lead_user_id === me : true))
  const sorted = [...projects].sort((a, b) => (a.target_date ?? '9999') < (b.target_date ?? '9999') ? -1 : 1)

  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 960, margin: '0 auto' }}>
      <SectionHead
        title="Projects"
        sub="Projects group issues toward an outcome — one lead, a target date, honest health updates."
        right={<Pill tone="blue" dot>sync</Pill>}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8 }}>
          {([['all', 'All projects'], ['mine', 'Led by me']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 10.5, fontWeight: 800 }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <SampleDataButton onAfterChange={() => { void engine.pullDelta() }} />
        <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setOpenNew(true)}>New project</Btn>
      </div>

      {sorted.length === 0 ? (
        <EmptyProjects onCta={() => setOpenNew(true)} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {sorted.map((p) => (
            <ProjectRow key={p.id} p={p}
              progress={store.projectProgress(p.id)}
              teamIds={store.projectTeams.get(p.id) ?? []}
              teams={store.teams as never}
              leadName={p.lead_user_id ? store.users.get(p.lead_user_id)?.name ?? '' : ''}
              onOpen={() => router.push(`/pm/projects/${p.id}`)}
            />
          ))}
        </div>
      )}

      <ProjectCreateModal
        open={openNew}
        onClose={() => setOpenNew(false)}
        teams={store.teamList()}
        users={[...store.users.values()]}
        meId={me}
        onCreate={(input) => {
          const id = engine.createProject(input)
          router.push(`/pm/projects/${id}`)
        }}
      />
    </div>
  )
})

function ProjectRow({ p, progress, teamIds, teams, leadName, onOpen }: {
  p: PmProjectRow
  progress: { scope: number; started: number; done: number }
  teamIds: string[]
  teams: Map<string, never>
  leadName: string
  onOpen: () => void
}) {
  const overdue = p.target_date && p.status === 'in_progress' && new Date(p.target_date) < new Date()
  return (
    <div onClick={onOpen}
      style={{ display: 'flex', alignItems: 'center', gap: 11, height: 44, padding: '0 14px', borderBottom: '1px solid var(--bord)', cursor: 'pointer', transition: 'background .12s ease-out' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surf-1)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
      <span style={{ fontSize: 14 }}>{p.icon ?? '🎯'}</span>
      <span style={{ fontSize: 12.5, fontWeight: 800, minWidth: 150, color: '#fff' }}>{p.name}</span>
      <HealthChip h={p.health} small />
      {p.deal_id && (
        <span title="Created from a CRM deal" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 7px', height: 16, borderRadius: 99, background: 'rgba(39,210,128,.1)', border: '1px solid rgba(39,210,128,.35)', fontSize: 9, fontWeight: 800, color: 'var(--green)' }}>
          <Icon.funnel size={9} />deal
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ width: 130 }}><PmProgressBar {...progress} /></span>
      <span style={{ fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', width: 62 }}>
        {progress.done}/{progress.scope} pts
      </span>
      <TeamKeyChips teamIds={teamIds} teams={teams as never} />
      <span style={{ fontSize: 10, fontWeight: 700, color: overdue ? 'var(--yellow)' : 'var(--text-faint)', width: 62, textAlign: 'right' }}>
        {p.target_date ? new Date(p.target_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
      </span>
      {leadName && <PmAv name={leadName} size={18} />}
    </div>
  )
}

function EmptyProjects({ onCta }: { onCta: () => void }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '56px 24px', gap: 12 }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
        <Icon.target size={20} />
      </div>
      <div className="t-mute" style={{ fontSize: 12.5, textAlign: 'center', maxWidth: 380, lineHeight: 1.6 }}>
        Projects group issues toward an outcome — one lead, a target date, honest health updates.
      </div>
      <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={onCta}>New project</Btn>
    </div>
  )
}

// ─── REST MODE (kill-switch path) ────────────────────────────────────────────

interface RestProjectsResponse {
  data: {
    projects: PmProjectRow[]
    teams: Record<string, string[]>
    progress: Record<string, { scope: number; started: number; done: number }>
  }
}

function RestProjects() {
  const router = useRouter()
  const qc = useQueryClient()
  const { currentUser } = useAuthStore()
  const [openNew, setOpenNew] = useState(false)
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
    () => new Map((teamsQ.data?.data.teams ?? []).map((t) => [t.id, t])),
    [teamsQ.data],
  )
  const d = projectsQ.data?.data
  return (
    <div style={{ padding: '22px 26px 64px', maxWidth: 960, margin: '0 auto' }}>
      <SectionHead title="Projects" sub="One lead, a target date, honest health updates." right={<Pill tone="yellow" dot>rest</Pill>} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1 }} />
        <SampleDataButton />
        <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setOpenNew(true)}>New project</Btn>
      </div>
      {!d || d.projects.length === 0 ? (
        <EmptyProjects onCta={() => setOpenNew(true)} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {d.projects.map((p) => (
            <ProjectRow key={p.id} p={p}
              progress={d.progress[p.id] ?? { scope: 0, started: 0, done: 0 }}
              teamIds={d.teams[p.id] ?? []}
              teams={teamMap as never}
              leadName=""
              onOpen={() => router.push(`/pm/projects/${p.id}`)}
            />
          ))}
        </div>
      )}
      <ProjectCreateModal
        open={openNew}
        onClose={() => setOpenNew(false)}
        teams={(teamsQ.data?.data.teams ?? []) as never}
        users={(usersQ.data?.data ?? []) as never}
        meId={currentUser?.id ?? ''}
        onCreate={(input) => {
          void api.post<{ data: { id: string } }>('/api/v1/pm/projects', input).then((res) => {
            void qc.invalidateQueries({ queryKey: ['pm', 'projects'] })
            router.push(`/pm/projects/${res.data.id}`)
          })
        }}
      />
    </div>
  )
}


// ─── Appendix B sample data (one-click, removable) ───────────────────────────

export function SampleDataButton({ onAfterChange }: { onAfterChange?: () => void }) {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['pm', 'sample-data'],
    queryFn: () => api.get<{ data: { loaded: boolean } }>('/api/v1/pm/sample-data'),
  })
  const toggle = useMutation({
    mutationFn: () =>
      status.data?.data.loaded
        ? api.post('/api/v1/pm/sample-data/remove', {})
        : api.post('/api/v1/pm/sample-data', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pm'] })
      onAfterChange?.()
    },
  })
  const loaded = status.data?.data.loaded ?? false
  return (
    <Btn kind="secondary" size="sm"
      icon={loaded ? <Icon.trash size={13} /> : <Icon.spark size={13} />}
      disabled={toggle.isPending || status.isLoading}
      onClick={() => toggle.mutate()}>
      {toggle.isPending ? 'Working…' : loaded ? 'Remove sample data' : 'Load sample data'}
    </Btn>
  )
}
