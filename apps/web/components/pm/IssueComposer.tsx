'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Modal, Toggle } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { PriorityGlyph, PM_PRIORITY_LABEL } from '@/components/pm/glyphs'
import { api } from '@/lib/api/client'
import type { PmSyncEngine } from '@/lib/pm/engine'
import type { PmLabelRow, PmStateRow } from '@/lib/pm/types'

// ─────────────────────────────────────────────────────────
// Round B — the ONE issue composer (founder: "I want the thing to be exactly
// like linear... the Issue title and Description to be added when adding an
// issue... the options to assign and other stuff should be there").
//
// Before this, the four create paths were four different forms: the project
// modal had title/team/milestone, the issues list had title/priority, the
// board column and the REST fallback had title only. This modal carries
// title + description + state + priority + assignee + estimate + labels +
// project + milestone + due date, works in BOTH modes (engine or REST
// kill-switch), honors the team's default template, and keeps "Create more".
// ─────────────────────────────────────────────────────────

interface TeamOption {
  id: string
  name: string
}

interface IssueComposerProps {
  open: boolean
  onClose: () => void
  engine: PmSyncEngine | null
  /** Preselected team; defaults to the first visible team. */
  teamId?: string
  /** Restrict the team picker (the project page passes its linked teams). */
  teamOptions?: TeamOption[]
  /** Pre-link the issue to a project (project page). */
  projectId?: string | null
  /** Pre-link a milestone (implies projectId). */
  milestoneId?: string | null
  /** Pre-pick a state (board column's + button). */
  stateId?: string
  /** REST mode: called after a successful create (invalidate + refetch). */
  onCreated?: () => void
}

interface TeamsIndex {
  teams: Array<{ id: string; key: string; name: string; default_state_id: string | null }>
  states: PmStateRow[]
  labels: PmLabelRow[]
}

export function IssueComposer({
  open,
  onClose,
  engine,
  teamId,
  teamOptions,
  projectId,
  milestoneId,
  stateId,
  onCreated,
}: IssueComposerProps) {
  const qc = useQueryClient()
  const titleRef = useRef<HTMLInputElement>(null)

  // ── data sources, mode-agnostic (engine store or REST) ──
  const teamsQ = useQuery({
    queryKey: ['pm', 'teams', 'composer'],
    queryFn: () => api.get<{ data: TeamsIndex }>('/api/v1/pm/teams'),
    enabled: open && !engine,
    staleTime: 120_000,
  })
  const usersQ = useQuery({
    queryKey: ['pm', 'users'],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; name: string | null; avatar_url: string | null }> }>('/api/v1/pm/users'),
    enabled: open && !engine,
    staleTime: 300_000,
  })
  const projectsQ = useQuery({
    queryKey: ['pm', 'projects'],
    queryFn: () => api.get<{ data: { projects: Array<{ id: string; name: string; icon: string | null }> } }>('/api/v1/pm/projects'),
    enabled: open && !engine,
    staleTime: 120_000,
  })

  const allTeams: TeamOption[] = engine
    ? engine.store.teamList().map((t) => ({ id: t.id, name: t.name }))
    : (teamsQ.data?.data.teams ?? []).map((t) => ({ id: t.id, name: t.name }))
  const teams = teamOptions?.length ? teamOptions : allTeams

  // ── form state ──
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [team, setTeam] = useState(teamId ?? '')
  const [state, setState] = useState(stateId ?? '')
  const [priority, setPriority] = useState<number | null>(null)
  const [assignee, setAssignee] = useState('')
  const [estimate, setEstimate] = useState('')
  const [due, setDue] = useState('')
  const [project, setProject] = useState(projectId ?? '')
  const [milestone, setMilestone] = useState(milestoneId ?? '')
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [createMore, setCreateMore] = useState(false)

  // Re-arm presets each time the composer opens (the parent's context may
  // have changed — a different board column, another project).
  useEffect(() => {
    if (!open) return
    setTeam(teamId ?? '')
    setState(stateId ?? '')
    setProject(projectId ?? '')
    setMilestone(milestoneId ?? '')
  }, [open, teamId, stateId, projectId, milestoneId])

  const effectiveTeam = team || teams[0]?.id || ''

  const states: PmStateRow[] = engine
    ? engine.store.statesForTeam(effectiveTeam)
    : (teamsQ.data?.data.states ?? []).filter((s) => s.team_id === effectiveTeam)
  const users = (engine ? [...engine.store.users.values()] : usersQ.data?.data ?? [])
    .map((u) => ({ id: u.id, name: u.name ?? '—' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const projects = engine
    ? engine.store.projectList().map((p) => ({ id: p.id, name: p.name, icon: p.icon }))
    : projectsQ.data?.data.projects ?? []
  const labels: PmLabelRow[] = (engine
    ? [...engine.store.labels.values()]
    : teamsQ.data?.data.labels ?? []
  ).filter((l) => !l.team_id || l.team_id === effectiveTeam)

  const milestonesQ = useQuery({
    queryKey: ['pm', 'project-detail', project || 'none'],
    queryFn: () =>
      api.get<{ data: { milestones: Array<{ id: string; name: string }> } }>(`/api/v1/pm/projects/${project}/detail`),
    enabled: open && !engine && !!project,
  })
  const milestones = project
    ? engine
      ? engine.store.milestonesForProject(project)
      : milestonesQ.data?.data.milestones ?? []
    : []

  // §15.5 — the team's default template prefills description/priority/
  // estimate; an explicit pick always wins over the template.
  const tmplQ = useQuery({
    queryKey: ['pm', 'templates', effectiveTeam],
    queryFn: () =>
      api.get<{ data: Array<{ is_team_default: boolean; description_md: string | null; default_priority: number | null; default_estimate: string | null }> }>(
        `/api/v1/pm/teams/${effectiveTeam}/templates`,
      ),
    enabled: open && !!effectiveTeam,
    staleTime: 120_000,
    retry: false,
  })
  const tmpl = useMemo(
    () => (tmplQ.data?.data ?? []).find((t) => t.is_team_default) ?? null,
    [tmplQ.data],
  )

  const toggleLabel = (id: string) =>
    setLabelIds((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]))

  const [saving, setSaving] = useState(false)
  const submit = async () => {
    const t = title.trim()
    if (!t || !effectiveTeam || saving) return
    const body = {
      team_id: effectiveTeam,
      title: t,
      description: description.trim() || tmpl?.description_md || undefined,
      state_id: state || undefined,
      priority: priority ?? tmpl?.default_priority ?? 0,
      assignee_user_id: assignee || undefined,
      estimate: estimate.trim() || tmpl?.default_estimate || undefined,
      project_id: project || undefined,
      milestone_id: (project && milestone) || undefined,
      due_date: due || undefined,
    }
    if (engine) {
      const id = engine.createIssue({
        ...body,
        assignee_user_id: assignee || null,
        description: body.description ?? null,
        project_id: project || null,
        milestone_id: (project && milestone) || null,
        due_date: due || null,
      })
      // Labels ride a chained set_labels — the create op has no label field
      // in the sync protocol, and the executor replays both idempotently.
      if (labelIds.length) engine.setIssueLabels(id, labelIds)
    } else {
      setSaving(true)
      try {
        await api.post('/api/v1/pm/issues', {
          ...body,
          ...(labelIds.length ? { label_ids: labelIds } : {}),
        })
        void qc.invalidateQueries({ queryKey: ['pm'] })
        onCreated?.()
      } catch {
        setSaving(false)
        return // keep the form intact so nothing typed is lost
      }
      setSaving(false)
    }
    // "Create more" keeps the property picks (Linear behavior) and clears
    // only what identifies the issue.
    setTitle('')
    setDescription('')
    if (!createMore) onClose()
    else titleRef.current?.focus()
  }

  return (
    <Modal open={open} onClose={onClose} title="New issue" width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {teams.length > 1 && (
          <select
            className="input"
            value={effectiveTeam}
            onChange={(e) => { setTeam(e.target.value); setState(''); setLabelIds([]) }}
            style={{ width: 220, height: 30, fontSize: 11.5 }}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <input
          ref={titleRef}
          autoFocus
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="Issue title"
          style={{ height: 38, fontSize: 14, fontWeight: 700 }}
        />
        <textarea
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit() }}
          placeholder={tmpl?.description_md ? 'Description — the team template fills in if left empty' : 'Add a description…'}
          rows={4}
          style={{ width: '100%', resize: 'vertical', paddingTop: 8, fontSize: 12.5, lineHeight: 1.55 }}
        />

        {/* Property row — everything Linear offers at create. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="input"
            value={state}
            onChange={(e) => setState(e.target.value)}
            style={{ width: 140, height: 30, fontSize: 11.5 }}
          >
            <option value="">State: default</option>
            {states.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 3 }} title="Priority">
            {[0, 1, 2, 3, 4].map((p) => (
              <button
                key={p}
                onClick={() => setPriority(priority === p ? null : p)}
                title={PM_PRIORITY_LABEL[p]}
                style={{
                  width: 26, height: 26, borderRadius: 6,
                  border: `1px solid ${priority === p ? 'var(--bord-2)' : 'var(--bord)'}`,
                  background: priority === p ? 'var(--surf-3)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                }}
              >
                <PriorityGlyph p={p} size={12} />
              </button>
            ))}
          </div>
          <select
            className="input"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            style={{ width: 160, height: 30, fontSize: 11.5 }}
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
          <input
            className="input"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            placeholder="Est."
            inputMode="numeric"
            style={{ width: 56, height: 30, fontSize: 11.5 }}
            title="Estimate points"
          />
          <DateField value={due} onChange={setDue} style={{ height: 30, width: 130, fontSize: 11.5 }} />
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="input"
            value={project}
            onChange={(e) => { setProject(e.target.value); setMilestone('') }}
            style={{ width: 200, height: 30, fontSize: 11.5 }}
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.icon ?? '🎯'} {p.name}</option>
            ))}
          </select>
          {!!project && (
            <select
              className="input"
              value={milestone}
              onChange={(e) => setMilestone(e.target.value)}
              style={{ width: 180, height: 30, fontSize: 11.5 }}
            >
              <option value="">No milestone</option>
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}
        </div>

        {labels.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {labels.map((l) => {
              const on = labelIds.includes(l.id)
              return (
                <button
                  key={l.id}
                  onClick={() => toggleLabel(l.id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
                    borderRadius: 99, cursor: 'pointer', fontSize: 10.5, fontWeight: 800,
                    background: on ? `${l.color}26` : 'transparent',
                    border: `1px solid ${on ? `${l.color}70` : 'var(--bord)'}`,
                    color: on ? l.color : 'var(--text-2)',
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: l.color }} />
                  {l.name}
                </button>
              )
            })}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <Toggle on={createMore} onChange={setCreateMore} />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>Create more</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>⌘↵ create</span>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={!title.trim() || saving} onClick={() => void submit()}>
            {saving ? 'Creating…' : 'Create issue'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
