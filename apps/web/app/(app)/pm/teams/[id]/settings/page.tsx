'use client'

import { use, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, Toggle, avBg, initials } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { StateGlyph, PM_CAT_COLOR } from '@/components/pm/glyphs'
import { api } from '@/lib/api/client'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'

// ─────────────────────────────────────────────────────────
// P15 — Team settings (§4.2–4.5), faithful to scr-settings-pm.jsx
// ScrTeamSettings: tabs General · Members · Workflow states · Labels ·
// Templates · Cycles · Estimates · Danger zone (default = Workflow states).
// Owner/Admin/lead edit; auditor read-only.
// ─────────────────────────────────────────────────────────

const TABS = ['General', 'Members', 'Workflow states', 'Labels', 'Templates', 'Cycles', 'Estimates', 'Danger zone'] as const
type Tab = (typeof TABS)[number]
const CATS = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'] as const
const SWATCHES = ['#A8B0C2', '#3E7BFA', '#FED800', '#27D280', '#9B7BFA', '#F8786B']
const SCALES: Array<[string, string, string]> = [
  ['count', 'Count', 'field hidden — issues count as 1'],
  ['linear', 'Linear', '1 · 2 · 3 · 4 · 5'],
  ['fibonacci', 'Fibonacci', '1 · 2 · 3 · 5 · 8'],
  ['exponential', 'Exponential', '1 · 2 · 4 · 8 · 16'],
  ['tshirt', 'T-shirt', 'XS · S · M · L · XL → 1,2,3,5,8'],
]

interface TeamsResp {
  data: {
    teams: Array<Record<string, unknown> & {
      id: string; key: string; name: string; color: string | null; is_private: boolean; timezone: string | null
      cycles_enabled: boolean; cycle_length_weeks: number; cooldown_days: number; cycle_start_dow: number
      cycle_auto_add_started: boolean; upcoming_cycles: number; estimate_scale: string
    }>
    memberships_all: Array<{ team_id: string; user_id: string; is_lead: boolean }>
    states: Array<{ id: string; team_id: string; name: string; color: string; category: string; position: number; is_default_for_category: boolean }>
    labels: Array<{ id: string; team_id: string | null; name: string; color: string }>
  }
}
interface UsersResp { data: Array<{ id: string; name: string }> }
interface TemplatesResp { data: Array<{ id: string; name: string; title_pattern: string | null; description_md: string | null; default_priority: number | null; is_team_default: boolean }> }

export default function TeamSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = use(params)
  const router = useRouter()
  const role = useAuthStore((s) => s.currentUser?.role)
  const meId = useAuthStore((s) => s.currentUser?.id)
  const isAdmin = role === 'OWNER' || role === 'HR_ADMIN'
  const { toast } = useToast()
  const qc = useQueryClient()

  const [tab, setTab] = useState<Tab>('Workflow states')
  const [privateConfirm, setPrivateConfirm] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [newState, setNewState] = useState<{ cat: string; name: string } | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [tmplSel, setTmplSel] = useState<string | null>(null)

  const teamsQ = useQuery({ queryKey: ['pm', 'teams', 'index'], queryFn: () => api.get<TeamsResp>('/api/v1/pm/teams') })
  const usersQ = useQuery({ queryKey: ['pm', 'users'], queryFn: () => api.get<UsersResp>('/api/v1/pm/users') })
  const templatesQ = useQuery({
    queryKey: ['pm', 'templates', teamId],
    queryFn: () => api.get<TemplatesResp>(`/api/v1/pm/teams/${teamId}/templates`),
  })

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['pm', 'teams'] }); void qc.invalidateQueries({ queryKey: ['pm', 'templates', teamId] }) }
  const fail = (e: unknown) => toast({ title: 'Could not save', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/v1/pm/teams/${teamId}`, body),
    onSuccess: invalidate, onError: fail,
  })
  const upsertState = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/api/v1/pm/teams/${teamId}/states`, body),
    onSuccess: invalidate, onError: fail,
  })
  const upsertLabel = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/api/v1/pm/labels', body),
    onSuccess: invalidate, onError: fail,
  })
  const addMember = useMutation({
    mutationFn: (userId: string) => api.post(`/api/v1/pm/teams/${teamId}/members`, { user_id: userId }),
    onSuccess: () => { setAddOpen(false); invalidate() }, onError: fail,
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.post(`/api/v1/pm/teams/${teamId}/members/${userId}/remove`, {}),
    onSuccess: invalidate, onError: fail,
  })
  const saveTemplate = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/api/v1/pm/teams/${teamId}/templates`, body),
    onSuccess: invalidate, onError: fail,
  })
  const deleteTemplate = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/pm/teams/${teamId}/templates/${id}/delete`, {}),
    onSuccess: () => { setTmplSel(null); invalidate() }, onError: fail,
  })
  const deleteTeam = useMutation({
    mutationFn: () => api.post(`/api/v1/pm/teams/${teamId}/delete`, {}),
    onSuccess: () => router.push('/pm/teams'), onError: fail,
  })

  const d = teamsQ.data?.data
  const team = d?.teams.find((t) => t.id === teamId)
  const members = (d?.memberships_all ?? []).filter((m) => m.team_id === teamId)
  const isLead = members.some((m) => m.user_id === meId && m.is_lead)
  const canCfg = isAdmin || isLead || role === 'MANAGER'
  const states = (d?.states ?? []).filter((s) => s.team_id === teamId)
  const teamLabels = (d?.labels ?? []).filter((l) => l.team_id === teamId)
  const userName = (id: string) => usersQ.data?.data.find((u) => u.id === id)?.name ?? '—'
  const templates = templatesQ.data?.data ?? []
  const tmpl = templates.find((t) => t.id === tmplSel) ?? templates[0] ?? null

  if (teamsQ.isLoading || !team) {
    return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  }

  const rowCard = { display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 14px', borderBottom: '1px solid var(--bord)' } as const

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '18px 20px' }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Btn kind="ghost" size="sm" icon={<Icon.chevL size={13} />} onClick={() => router.push('/pm/teams')}>Teams</Btn>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: team.color ?? '#3E7BFA', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>{team.key[0]}</span>
        <span style={{ fontSize: 14, fontWeight: 800 }}>{team.name}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{team.key} · {members.length} members</span>
        {team.is_private && <Pill tone="coral"><Icon.lock size={9} /> Private</Pill>}
      </div>

      {!canCfg && (
        <div className="card" style={{ padding: '8px 14px', marginBottom: 12, fontSize: 11, fontWeight: 700, color: 'var(--text-mute)' }}>
          Team settings need Owner/Admin or the team lead — shown read-only.
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 3, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '5px 11px', borderRadius: 8, fontSize: 11, fontWeight: 800, cursor: 'pointer',
            color: tab === t ? (t === 'Danger zone' ? 'var(--coral)' : '#fff') : 'var(--text-mute)',
            background: tab === t ? 'var(--surf-2)' : 'transparent',
            border: tab === t ? '1px solid var(--bord-2)' : '1px solid transparent',
          }}>{t}</button>
        ))}
      </div>

      {tab === 'General' && (
        <div className="card">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <div className="t-caption" style={{ marginBottom: 5 }}>Team name</div>
              <input className="input" defaultValue={team.name} disabled={!canCfg}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== team.name) patch.mutate({ name: e.target.value.trim() }) }}
                style={{ width: '100%', height: 34, fontSize: 12.5, fontWeight: 700 }} />
            </div>
            <div>
              <div className="t-caption" style={{ marginBottom: 5 }}>Key · {team.key}-123</div>
              <input className="input" value={team.key} disabled style={{ width: '100%', height: 34, fontSize: 12.5, fontFamily: 'var(--font-mono)' }} />
            </div>
            <div>
              <div className="t-caption" style={{ marginBottom: 5 }}>Timezone · cycle boundaries</div>
              <select className="input" value={team.timezone ?? 'Asia/Kolkata'} disabled={!canCfg}
                onChange={(e) => patch.mutate({ timezone: e.target.value })}
                style={{ width: '100%', height: 34, fontSize: 12, fontWeight: 700 }}>
                {['Asia/Kolkata', 'Europe/Berlin', 'America/New_York'].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
            <div>
              <div className="t-caption" style={{ marginBottom: 5 }}>Color</div>
              <div style={{ display: 'flex', gap: 6, paddingTop: 6 }}>
                {SWATCHES.map((c) => (
                  <button key={c} disabled={!canCfg} onClick={() => patch.mutate({ color: c })}
                    style={{ width: 22, height: 22, borderRadius: 6, background: c, border: team.color === c ? '2px solid #fff' : '1px solid var(--bord)', cursor: 'pointer' }} />
                ))}
              </div>
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--bord)', paddingTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 800 }}>Private team</div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                Content visible to members only — enforced in every query, bootstrap and delta. Included in v1.
              </div>
            </div>
            <Toggle on={team.is_private} onChange={(v) => { if (!canCfg) return; if (v) setPrivateConfirm(true); else patch.mutate({ is_private: false }) }} />
          </div>
        </div>
      )}

      {tab === 'Members' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {members.map((m) => (
            <div key={m.user_id} style={rowCard}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', background: avBg(userName(m.user_id)), color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 8.5, fontWeight: 800 }}>{initials(userName(m.user_id))}</span>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>{userName(m.user_id)}</span>
              {m.is_lead && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--yellow)' }}>★ Lead</span>}
              {canCfg && (
                <button onClick={() => removeMember.mutate(m.user_id)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>Remove</button>
              )}
            </div>
          ))}
          {canCfg && (
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
              {addOpen ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <select className="input" defaultValue="" onChange={(e) => { if (e.target.value) addMember.mutate(e.target.value) }} style={{ flex: 1, height: 32, fontSize: 12, fontWeight: 700 }}>
                    <option value="">Pick from the workspace directory…</option>
                    {(usersQ.data?.data ?? []).filter((u) => !members.some((m) => m.user_id === u.id)).map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                  <Btn kind="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Btn>
                </div>
              ) : (
                <Btn kind="secondary" size="sm" icon={<Icon.userPlus size={12} />} onClick={() => setAddOpen(true)}>Add member</Btn>
              )}
            </div>
          )}
          <div style={{ padding: '9px 14px', fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>
            Members come from the workspace directory · guests are invited per project from a project page · Owner/Admin self-adds to private teams are audit-logged
          </div>
        </div>
      )}

      {tab === 'Workflow states' && (
        <div className="card">
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginBottom: 12 }}>
            Rename, re-color and add within categories — categories drive automations, filters and metrics. Glyph preview is live.
          </div>
          {CATS.map((cat) => {
            const catStates = states.filter((s) => s.category === cat).sort((a, b) => a.position - b.position)
            return (
              <div key={cat} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                  <StateGlyph cat={cat} size={12} />
                  <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{cat}</span>
                  <span style={{ flex: 1, height: 1, background: 'var(--bord)' }} />
                  {canCfg && (
                    <button onClick={() => setNewState({ cat, name: '' })} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>+ Add state</button>
                  )}
                </div>
                {catStates.map((s) => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 9, height: 34, padding: '0 6px' }}>
                    <span style={{ color: 'var(--text-faint)', fontSize: 11, cursor: canCfg ? 'grab' : 'default' }}>⋮⋮</span>
                    <StateGlyph cat={s.category} size={13} color={s.color} />
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{s.name}</span>
                    {s.is_default_for_category && (
                      <span style={{ fontSize: 8.5, fontWeight: 800, color: 'var(--blue)', border: '1px solid rgba(62,123,250,.4)', borderRadius: 6, padding: '1px 6px' }}>default for new issues</span>
                    )}
                    {canCfg && SWATCHES.map((c) => (
                      <button key={c} onClick={() => upsertState.mutate({ id: s.id, name: s.name, color: c })}
                        style={{ width: 12, height: 12, borderRadius: 4, background: c, border: s.color === c ? '1.5px solid #fff' : '1px solid var(--bord)', cursor: 'pointer', padding: 0 }} />
                    ))}
                    {canCfg && (
                      <button title="Rename" onClick={() => { const name = window.prompt('Rename state', s.name); if (name?.trim() && name !== s.name) upsertState.mutate({ id: s.id, name: name.trim(), color: s.color }) }}
                        style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2 }}><Icon.edit size={11} /></button>
                    )}
                  </div>
                ))}
                {newState?.cat === cat && (
                  <div style={{ display: 'flex', gap: 8, padding: '4px 6px' }}>
                    <input className="input" autoFocus placeholder="State name…" value={newState.name}
                      onChange={(e) => setNewState({ cat, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newState.name.trim()) { upsertState.mutate({ name: newState.name.trim(), color: PM_CAT_COLOR[cat] ?? '#A8B0C2', category: cat }); setNewState(null) }
                        if (e.key === 'Escape') setNewState(null)
                      }}
                      style={{ flex: 1, height: 28, fontSize: 11.5 }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'Labels' && (
        <div className="card" style={{ maxWidth: 520 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {teamLabels.map((l) => (
              <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 99, background: 'var(--surf-1)', border: '1px solid var(--bord)', fontSize: 11, fontWeight: 700 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.color }} />
                {l.name}
              </span>
            ))}
            {teamLabels.length === 0 && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)' }}>No team labels yet.</span>}
          </div>
          {canCfg && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input className="input" placeholder="New label…" value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newLabel.trim()) { upsertLabel.mutate({ team_id: teamId, name: newLabel.trim(), color: '#3E7BFA' }); setNewLabel('') } }}
                style={{ flex: 1, height: 32, fontSize: 12 }} />
              <Btn kind="secondary" size="sm" disabled={!newLabel.trim()} onClick={() => { upsertLabel.mutate({ team_id: teamId, name: newLabel.trim(), color: '#3E7BFA' }); setNewLabel('') }}>Add</Btn>
            </div>
          )}
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>
            Labels shared across every team are managed in Workspace settings.
          </div>
        </div>
      )}

      {tab === 'Templates' && (
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12 }}>
          <div className="card" style={{ padding: 8 }}>
            {templates.map((t) => (
              <button key={t.id} onClick={() => setTmplSel(t.id)} style={{
                width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                background: (tmpl?.id === t.id) ? 'var(--surf-2)' : 'transparent', border: '1px solid transparent',
                color: '#fff', fontSize: 11.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ flex: 1 }}>{t.name}</span>
                {t.is_team_default && <span style={{ fontSize: 8.5, fontWeight: 800, color: 'var(--blue)' }}>default</span>}
              </button>
            ))}
            {canCfg && (
              <button onClick={() => { const name = window.prompt('Template name'); if (name?.trim()) saveTemplate.mutate({ name: name.trim() }) }}
                style={{ width: '100%', textAlign: 'left', padding: '7px 10px', background: 'none', border: 'none', color: 'var(--blue)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>+ New template</button>
            )}
          </div>
          <div className="card">
            {tmpl ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800, flex: 1 }}>{tmpl.name}</span>
                  {canCfg && !tmpl.is_team_default && (
                    <Btn kind="secondary" size="sm" onClick={() => saveTemplate.mutate({ id: tmpl.id, name: tmpl.name, is_team_default: true })}>Make default</Btn>
                  )}
                  {canCfg && (
                    <Btn kind="ghost" size="sm" onClick={() => deleteTemplate.mutate(tmpl.id)}><span style={{ color: 'var(--coral)' }}>Delete</span></Btn>
                  )}
                </div>
                <div className="t-caption" style={{ marginBottom: 5 }}>Title pattern</div>
                <input className="input" defaultValue={tmpl.title_pattern ?? ''} disabled={!canCfg} placeholder="[Bug] …"
                  onBlur={(e) => { if (e.target.value !== (tmpl.title_pattern ?? '')) saveTemplate.mutate({ id: tmpl.id, name: tmpl.name, title_pattern: e.target.value || null }) }}
                  style={{ width: '100%', height: 32, fontSize: 12, marginBottom: 10 }} />
                <div className="t-caption" style={{ marginBottom: 5 }}>Default priority</div>
                <select className="input" value={tmpl.default_priority ?? ''} disabled={!canCfg}
                  onChange={(e) => saveTemplate.mutate({ id: tmpl.id, name: tmpl.name, default_priority: e.target.value === '' ? null : Number(e.target.value) })}
                  style={{ width: 160, height: 32, fontSize: 12, fontWeight: 700, marginBottom: 10 }}>
                  <option value="">None</option><option value="1">Urgent</option><option value="2">High</option><option value="3">Medium</option><option value="4">Low</option>
                </select>
                <div className="t-caption" style={{ marginBottom: 5 }}>Description markdown</div>
                <textarea className="input" defaultValue={tmpl.description_md ?? ''} disabled={!canCfg} rows={6}
                  onBlur={(e) => { if (e.target.value !== (tmpl.description_md ?? '')) saveTemplate.mutate({ id: tmpl.id, name: tmpl.name, description_md: e.target.value || null }) }}
                  style={{ width: '100%', fontSize: 12, fontFamily: 'var(--font-mono)', padding: 10 }} />
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', marginTop: 8 }}>
                  New issues start from the default template · project templates also carry a starter set of issues.
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>No templates yet — create one to prefill the C composer.</div>
            )}
          </div>
        </div>
      )}

      {tab === 'Cycles' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 800 }}>Cycles enabled</div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>Scheduler is team-timezone aware ({team.timezone ?? 'Asia/Kolkata'})</div>
            </div>
            <Toggle on={team.cycles_enabled} onChange={(v) => canCfg && patch.mutate({ cycles_enabled: v })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            {[
              ['Length', 'cycle_length_weeks', [1, 2, 3, 4, 5, 6].map((n) => [n, `${n} week${n > 1 ? 's' : ''}`])],
              ['Cooldown', 'cooldown_days', [0, 1, 2, 3, 7].map((n) => [n, `${n} day${n === 1 ? '' : 's'}`])],
              ['Start day', 'cycle_start_dow', [[1, 'Monday'], [0, 'Sunday']]],
              ['Upcoming cycles', 'upcoming_cycles', [1, 2, 3].map((n) => [n, String(n)])],
            ].map(([label, field, opts]) => (
              <div key={label as string}>
                <div className="t-caption" style={{ marginBottom: 5 }}>{label as string}</div>
                <select className="input" value={String(team[field as string])} disabled={!canCfg}
                  onChange={(e) => patch.mutate({ [field as string]: Number(e.target.value) })}
                  style={{ width: '100%', height: 32, fontSize: 12, fontWeight: 700 }}>
                  {(opts as Array<[number, string]>).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--bord)', paddingTop: 12 }}>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>Auto-add started issues to the active cycle</span>
            <Toggle on={team.cycle_auto_add_started} onChange={(v) => canCfg && patch.mutate({ cycle_auto_add_started: v })} />
          </div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', marginTop: 10 }}>
            Autopilot on cycle end: urgent/high → next cycle · medium/low → Backlog + Cycle Review digest
          </div>
        </div>
      )}

      {tab === 'Estimates' && (
        <div className="card" style={{ maxWidth: 520 }}>
          {SCALES.map(([value, label, preview]) => (
            <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 6px', borderBottom: '1px solid var(--bord)', cursor: canCfg ? 'pointer' : 'default' }}>
              <input type="radio" name="scale" checked={team.estimate_scale === value} disabled={!canCfg} onChange={() => patch.mutate({ estimate_scale: value })} />
              <span style={{ width: 110, fontSize: 12.5, fontWeight: 800 }}>{label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{preview}</span>
            </label>
          ))}
        </div>
      )}

      {tab === 'Danger zone' && (
        <div className="card" style={{ border: '1px solid rgba(248,120,107,.4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800 }}>Delete team</div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                Soft-delete — issues restorable for 30 days from Recently deleted. Owner/Admin only, audit-logged.
              </div>
            </div>
            <Btn kind="danger" size="sm" disabled={!isAdmin || deleteTeam.isPending}
              onClick={() => setDeleteConfirm(true)}>
              Delete {team.key}…
            </Btn>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteConfirm}
        onClose={() => setDeleteConfirm(false)}
        title="Delete team"
        danger
        body={`Delete ${team.key}? Issues stay restorable for 30 days.`}
        confirmLabel={`Delete ${team.key}`}
        loading={deleteTeam.isPending}
        loadingLabel="Deleting…"
        onConfirm={() => deleteTeam.mutate()}
      />

      {/* Make-private confirm (§4.4 — audited) */}
      {privateConfirm && (
        <div onClick={() => setPrivateConfirm(false)} style={{ position: 'fixed', inset: 0, zIndex: 1150, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 420, borderRadius: 15, padding: '22px 24px' }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Make {team.name} private?</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', marginBottom: 12 }}>Visibility change — audit-logged</div>
            <ul style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.7, paddingLeft: 18, marginBottom: 16 }}>
              <li>Issues, cycles and views disappear for non-members immediately.</li>
              <li>Sync engines drop the team's rows on the next delta (tombstones).</li>
              <li>Owner/Admin can still self-add — that self-add is audit-logged and visible in the team feed.</li>
            </ul>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn kind="ghost" size="sm" onClick={() => setPrivateConfirm(false)}>Cancel</Btn>
              <Btn kind="primary" size="sm" onClick={() => { patch.mutate({ is_private: true }); setPrivateConfirm(false) }}>Make private</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
