'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Modal, Toggle } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { DiamondGlyph, PriorityGlyph, StateGlyph, PM_PRIORITY_LABEL } from '@/components/pm/glyphs'
import { PmAv } from '@/components/pm/projects'
import { PillOption, PropertyPill } from '@/components/pm/PropertyPill'
import { RichEditor } from '@/components/pm/editor'
import { AttachButton, AttachmentList, DropZone } from '@/components/pm/attachments'
import { toast } from '@/components/ui/use-toast'
import { api } from '@/lib/api/client'
import { uploadPmFiles, useAttachmentsEnabled } from '@/lib/api/queries/use-pm-files'
import type { FileUrlMap, PmFile, PmFileKind } from '@/lib/pm/files'
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
//
// Round L item 6 — the description is the Linear-style RichEditor (paste or
// drop an image → inline), with Attach / drop-zone chips. Every upload is a
// DRAFT keyed by a per-open draftId and travels with the create as
// `attachment_ids` (the API binds them to the new issue). With the
// pm_attachments flag off it is the plain textarea it always was.
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
  /** Round E — the pre-linked project's display name, so the Project pill can
   *  label itself before the projects list has loaded (the select used to
   *  show "No project" in that window, which read as "not linked"). */
  projectName?: string | null
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
  projectName,
  milestoneId,
  stateId,
  onCreated,
}: IssueComposerProps) {
  const qc = useQueryClient()
  const titleRef = useRef<HTMLInputElement>(null)
  const { rich, attachments } = useAttachmentsEnabled()

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

  // ── attachments (Round L item 6): drafts under a per-open id ──
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  const [pendingFiles, setPendingFiles] = useState<PmFile[]>([])
  const [localUrls, setLocalUrls] = useState<FileUrlMap>({})
  const inlineIdsRef = useRef<string[]>([])
  const [progress, setProgress] = useState<number | null>(null)
  const resetFiles = () => {
    setDraftId(crypto.randomUUID())
    setPendingFiles([])
    setLocalUrls({})
    inlineIdsRef.current = []
  }

  // Re-arm presets when the composer OPENS (the parent's context may have
  // changed — a different board column, another project). Round E: only on
  // the closed→open transition — this effect used to re-fire on every preset
  // prop identity change WHILE open (e.g. teamId resolving undefined→id once
  // teams loaded), silently snapping the user's own project/milestone/state
  // picks back to the presets. That was the founder's "issue not getting
  // assigned to the project" in disguise.
  const prevOpen = useRef(false)
  useEffect(() => {
    if (open && !prevOpen.current) {
      setTeam(teamId ?? '')
      setState(stateId ?? '')
      setProject(projectId ?? '')
      setMilestone(milestoneId ?? '')
      resetFiles()
    }
    prevOpen.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, teamId, stateId, projectId, milestoneId])

  const effectiveTeam = team || teams[0]?.id || ''

  const states: PmStateRow[] = engine
    ? engine.store.statesForTeam(effectiveTeam)
    : (teamsQ.data?.data.states ?? []).filter((s) => s.team_id === effectiveTeam)
  const users = (engine ? [...engine.store.users.values()] : usersQ.data?.data ?? [])
    .map((u) => ({ id: u.id, name: u.name ?? '—', avatar_url: u.avatar_url ?? null }))
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

  // ── uploads: drafts under draftId, bound by the create ──
  const upload = (files: File[], kind: PmFileKind, onProgress?: (pct: number) => void) =>
    uploadPmFiles({ objectType: 'draft', objectId: draftId, kind, files, onProgress })
  const attach = async (files: File[]) => {
    setProgress(0)
    try {
      const out = await upload(files, 'attachment', setProgress)
      setPendingFiles((prev) => [...prev, ...out])
    } catch (err) {
      toast({ title: 'Upload failed', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
    } finally {
      setProgress(null)
    }
  }
  const uploadInline = async (file: File) => {
    const [f] = await upload([file], 'inline')
    if (!f) return null
    inlineIdsRef.current.push(f.id)
    if (f.url) setLocalUrls((m) => ({ ...m, [f.id.toLowerCase()]: f.url! }))
    return { id: f.id, url: f.url }
  }
  const dropPending = (f: PmFile) => setPendingFiles((prev) => prev.filter((p) => p.id !== f.id))

  const [saving, setSaving] = useState(false)
  const submit = async () => {
    const t = title.trim()
    if (!t || !effectiveTeam || saving) return
    const attachmentIds = [...new Set([...pendingFiles.map((f) => f.id), ...inlineIdsRef.current])]
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
        attachment_ids: attachmentIds,
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
          ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
        })
        void qc.invalidateQueries({ queryKey: ['pm'] })
        onCreated?.()
      } catch (err) {
        setSaving(false)
        toast({ title: 'Couldn’t create the issue', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
        return // keep the form intact so nothing typed is lost
      }
      setSaving(false)
    }
    // "Create more" keeps the property picks (Linear behavior) and clears
    // only what identifies the issue — and starts a fresh draft namespace.
    setTitle('')
    setDescription('')
    resetFiles()
    if (!createMore) onClose()
    else titleRef.current?.focus()
  }

  // ── Round E: Linear-replica layout — a clean doc (big borderless title +
  // free-text description) with the properties as compact pills underneath,
  // and the footer in the modal's footer slot. Same data flow as before.
  const teamName = teams.find((t) => t.id === effectiveTeam)?.name ?? 'Team'
  const selState = states.find((s) => s.id === state) ?? null
  const selUser = users.find((u) => u.id === assignee) ?? null
  const selProject = projects.find((p) => p.id === project) ?? null
  const projectLabel = selProject?.name ?? (project ? projectName ?? 'Project…' : 'Project')
  const selMilestone = milestones.find((m) => m.id === milestone) ?? null
  const descPlaceholder = tmpl?.description_md ? 'Add description… (the team template fills in if left empty)' : 'Add description…'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New issue"
      width={640}
      hideHeader
      bodyPadding="16px 20px 14px"
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <Toggle on={createMore} onChange={setCreateMore} />
          <span
            onClick={() => setCreateMore((v) => !v)}
            style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' }}
          >
            Create more
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>⌘↵ create</span>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={!title.trim() || saving} onClick={() => void submit()} data-testid="composer-create">
            {saving ? 'Creating…' : 'Create issue'}
          </Btn>
        </div>
      }
    >
      <DropZone onFiles={attach} disabled={!attachments} label="Drop files to attach to the new issue">
        <div
          data-testid="issue-composer"
          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
          onKeyDown={(e) => {
            // The rich editor submits its own Mod+Enter (RichEditor.onSubmit);
            // handling it here too would create the issue twice.
            const inEditor = !!(e.target as HTMLElement).closest?.('.pm-rich')
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !inEditor) void submit()
            if (e.key === 'Escape') onClose()
          }}
        >
          {/* Breadcrumb: team › New issue, with the close X. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
            {teams.length > 1 ? (
              <PropertyPill
                title="Team"
                active
                label={teamName}
                width={220}
                menu={(close) => (
                  <>
                    {teams.map((t) => (
                      <PillOption
                        key={t.id}
                        label={t.name}
                        selected={t.id === effectiveTeam}
                        onPick={() => { setTeam(t.id); setState(''); setLabelIds([]); close() }}
                      />
                    ))}
                  </>
                )}
              />
            ) : (
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-2)' }}>{teamName}</span>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>›</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)' }}>New issue</span>
            <span style={{ flex: 1 }} />
            <div style={{ margin: '-4px -8px 0 0' }}>
              <Btn kind="ghost" size="sm" icon={<Icon.x size={15} />} onClick={onClose} />
            </div>
          </div>

          <input
            ref={titleRef}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title"
            data-testid="composer-title"
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none',
              fontSize: 17, fontWeight: 700, color: '#fff', padding: '2px 0', letterSpacing: '-0.01em',
            }}
          />
          {rich ? (
            <RichEditor
              value={description}
              onChange={setDescription}
              onSubmit={() => void submit()}
              placeholder={descPlaceholder}
              fileUrls={localUrls}
              onUploadImage={attachments ? uploadInline : undefined}
              minHeight={58}
            />
          ) : (
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = `${Math.min(e.target.scrollHeight, 260)}px`
              }}
              placeholder={descPlaceholder}
              rows={3}
              style={{
                width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none',
                fontSize: 12.5, lineHeight: 1.6, color: 'var(--text)', padding: 0, minHeight: 58,
              }}
            />
          )}
          {pendingFiles.length > 0 && (
            <AttachmentList files={pendingFiles} onRemove={dropPending} style={{ marginTop: 2 }} />
          )}

          {/* Property pills — everything Linear offers at create. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
            <PropertyPill
              title="State"
              active={!!selState}
              icon={<StateGlyph cat={selState?.category ?? 'backlog'} size={12} />}
              label={selState?.name ?? 'State'}
              width={200}
              menu={(close) => (
                <>
                  <PillOption label="Default state" selected={!state} onPick={() => { setState(''); close() }} />
                  {states.map((s) => (
                    <PillOption
                      key={s.id}
                      icon={<StateGlyph cat={s.category} size={12} />}
                      label={s.name}
                      selected={s.id === state}
                      onPick={() => { setState(s.id); close() }}
                    />
                  ))}
                </>
              )}
            />
            <PropertyPill
              title="Priority"
              active={priority !== null && priority !== 0}
              icon={<PriorityGlyph p={priority ?? 0} size={12} />}
              label={priority !== null ? PM_PRIORITY_LABEL[priority] : 'Priority'}
              width={180}
              menu={(close) => (
                <>
                  {[0, 1, 2, 3, 4].map((p) => (
                    <PillOption
                      key={p}
                      icon={<PriorityGlyph p={p} size={12} />}
                      label={PM_PRIORITY_LABEL[p]}
                      selected={priority === p}
                      onPick={() => { setPriority(p); close() }}
                    />
                  ))}
                </>
              )}
            />
            <PropertyPill
              title="Assignee"
              active={!!selUser}
              icon={
                selUser ? (
                  <PmAv name={selUser.name} src={selUser.avatar_url} size={15} />
                ) : (
                  <span style={{ width: 13, height: 13, borderRadius: '50%', border: '1.5px dashed var(--bord-2)', display: 'inline-block', boxSizing: 'border-box' }} />
                )
              }
              label={selUser?.name ?? 'Assignee'}
              width={230}
              menu={(close) => (
                <>
                  <PillOption label="Unassigned" selected={!assignee} onPick={() => { setAssignee(''); close() }} />
                  {users.map((u) => (
                    <PillOption
                      key={u.id}
                      icon={<PmAv name={u.name} src={u.avatar_url} size={15} />}
                      label={u.name}
                      selected={u.id === assignee}
                      onPick={() => { setAssignee(u.id); close() }}
                    />
                  ))}
                </>
              )}
            />
            <PropertyPill
              title="Project"
              active={!!project}
              icon={<span style={{ fontSize: 11 }}>{selProject?.icon ?? '🎯'}</span>}
              label={projectLabel}
              width={240}
              menu={(close) => (
                <>
                  <PillOption label="No project" selected={!project} onPick={() => { setProject(''); setMilestone(''); close() }} />
                  {projects.map((p) => (
                    <PillOption
                      key={p.id}
                      icon={<span style={{ fontSize: 11 }}>{p.icon ?? '🎯'}</span>}
                      label={p.name}
                      selected={p.id === project}
                      onPick={() => { setProject(p.id); setMilestone(''); close() }}
                    />
                  ))}
                </>
              )}
            />
            {!!project && (
              <PropertyPill
                title="Milestone"
                active={!!selMilestone}
                icon={<DiamondGlyph size={11} />}
                label={selMilestone?.name ?? 'Milestone'}
                width={220}
                menu={(close) => (
                  <>
                    <PillOption label="No milestone" selected={!milestone} onPick={() => { setMilestone(''); close() }} />
                    {milestones.map((m) => (
                      <PillOption
                        key={m.id}
                        icon={<DiamondGlyph size={11} />}
                        label={m.name}
                        selected={m.id === milestone}
                        onPick={() => { setMilestone(m.id); close() }}
                      />
                    ))}
                  </>
                )}
              />
            )}
            <input
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              placeholder="Est."
              inputMode="numeric"
              title="Estimate points"
              style={{
                width: 52, height: 26, borderRadius: 7, background: estimate ? 'var(--surf-2)' : 'var(--surf-1)',
                border: '1px solid var(--bord)', color: estimate ? '#fff' : 'var(--text-2)',
                fontSize: 11, fontWeight: 700, textAlign: 'center', outline: 'none',
              }}
            />
            <DateField value={due} onChange={setDue} style={{ height: 26, width: 120, fontSize: 11, borderRadius: 7 }} />
            {labels.length > 0 && (
              <PropertyPill
                title="Labels"
                active={labelIds.length > 0}
                icon={
                  <span style={{ display: 'inline-flex', gap: 2 }}>
                    {(labelIds.length ? labels.filter((l) => labelIds.includes(l.id)).slice(0, 3) : [{ id: '_', color: 'var(--text-faint)' }]).map((l) => (
                      <span key={l.id} style={{ width: 6, height: 6, borderRadius: '50%', background: l.color }} />
                    ))}
                  </span>
                }
                label={labelIds.length ? `${labelIds.length} label${labelIds.length > 1 ? 's' : ''}` : 'Labels'}
                width={220}
                menu={() => (
                  <>
                    {labels.map((l) => (
                      <PillOption
                        key={l.id}
                        icon={<span style={{ width: 7, height: 7, borderRadius: '50%', background: l.color }} />}
                        label={l.name}
                        selected={labelIds.includes(l.id)}
                        onPick={() => toggleLabel(l.id)}
                      />
                    ))}
                  </>
                )}
              />
            )}
            {attachments && <AttachButton onFiles={attach} progress={progress} />}
          </div>
        </div>
      </DropZone>
    </Modal>
  )
}
