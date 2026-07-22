'use client'

import { use, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { observer } from 'mobx-react-lite'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon } from '@/components/proto'
import { DiamondGlyph, HealthChip, Kbd, PmProgressBar, PriorityGlyph, StateGlyph, PM_HEALTH, PM_PROJECT_STATUS_LABEL, PendingDot } from '@/components/pm/glyphs'
import { PmAv } from '@/components/pm/projects'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
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

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { mode, engine } = usePm()
  const router = useRouter()
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: ['pm', 'project-detail', id],
    queryFn: () => api.get<DetailResponse>(`/api/v1/pm/projects/${id}/detail`),
  })
  const invalidate = () => setTimeout(() => qc.invalidateQueries({ queryKey: ['pm', 'project-detail', id] }), 700)

  if (detail.isLoading) {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }
  const d = detail.data?.data
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
  const liveMilestones = engine ? engine.store.milestonesForProject(id) : null
  const milestones = liveMilestones && liveMilestones.length >= d.milestones.length ? liveMilestones : d.milestones
  const liveUpdates = engine ? engine.store.updatesForProject(id) : null
  const updates = liveUpdates && liveUpdates.length >= d.updates.length ? liveUpdates : d.updates
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

  const postUpdate = () => {
    if (!upTxt.trim()) return
    if (engine) engine.postProjectUpdate(id, health, upTxt.trim())
    else void api.post(`/api/v1/pm/projects/${id}/updates`, { health, body_md: upTxt.trim() }).then(invalidate)
    setUpTxt('')
  }

  const addMilestone = () => {
    if (!msName.trim()) return
    if (engine) engine.createMilestone(id, msName.trim(), msDate || null)
    else void api.post('/api/v1/pm/milestones', { project_id: id, name: msName.trim(), target_date: msDate || null }).then(invalidate)
    setMsName(''); setMsDate(''); setAddMs(false)
  }

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
          <span style={{ fontSize: 20 }}>{project.icon ?? '🎯'}</span>
          <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em' }}>{project.name}</span>
          {project._pending && <PendingDot />}
          <select className="input" value={project.status} onChange={(e) => patchProject({ status: e.target.value as PmProjectRow['status'] })}
            style={{ height: 28, width: 130, fontSize: 11, fontWeight: 800 }}>
            {Object.entries(PM_PROJECT_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <HealthChip h={project.health} />
          <span style={{ flex: 1 }} />
          {leadName && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700 }}>
              <PmAv name={leadName} size={18} />{leadName}
            </span>
          )}
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <input type="date" className="input" value={project.start_date ?? ''} onChange={(e) => patchProject({ start_date: e.target.value || null })} style={{ height: 26, width: 120, fontSize: 10 }} />
            →
            <input type="date" className="input" value={project.target_date ?? ''} onChange={(e) => patchProject({ target_date: e.target.value || null })} style={{ height: 26, width: 120, fontSize: 10 }} />
          </span>
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
                <input type="date" className="input" value={msDate} onChange={(e) => setMsDate(e.target.value)} style={{ height: 26, width: 130, fontSize: 10.5 }} />
                <Kbd>⏎</Kbd>
              </div>
            )}
          </div>

          {/* Embedded issues */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Issues · {issues.length}</span>
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
                  <PmAv name={author} size={16} />
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
      </div>
    </div>
  )
})
