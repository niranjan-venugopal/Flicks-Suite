'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, avBg, initials } from '@/components/proto'
import { api } from '@/lib/api/client'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'

// ─────────────────────────────────────────────────────────
// P15 — Teams index (§4), faithful to scr-settings-pm.jsx ScrTeamsIndex:
// header + 7-col table (team · key · members · cycles · estimates ·
// visibility · join/chevron) + footer helper. Click → team settings.
// ─────────────────────────────────────────────────────────

interface TeamsResp {
  data: {
    teams: Array<{
      id: string; key: string; name: string; color: string | null; is_private: boolean
      cycles_enabled: boolean; cycle_length_weeks: number; estimate_scale: string; timezone: string | null
    }>
    memberships: Array<{ team_id: string; user_id: string; is_lead: boolean }>
    memberships_all: Array<{ team_id: string; user_id: string; is_lead: boolean }>
  }
}
interface UsersResp { data: Array<{ id: string; name: string }> }

export default function PmTeamsPage() {
  const router = useRouter()
  const role = useAuthStore((s) => s.currentUser?.role)
  const me = useAuthStore((s) => s.currentUser?.id)
  const canCreate = role === 'OWNER' || role === 'HR_ADMIN' || role === 'MANAGER'
  const qc = useQueryClient()
  const { toast } = useToast()

  const teamsQ = useQuery({ queryKey: ['pm', 'teams', 'index'], queryFn: () => api.get<TeamsResp>('/api/v1/pm/teams') })
  const usersQ = useQuery({ queryKey: ['pm', 'users'], queryFn: () => api.get<UsersResp>('/api/v1/pm/users') })
  const join = useMutation({
    mutationFn: (teamId: string) => api.post(`/api/v1/pm/teams/${teamId}/join`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm', 'teams'] }),
    onError: (e) => toast({ title: 'Could not join', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }),
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [cycles, setCycles] = useState(false)
  const create = useMutation({
    mutationFn: () => api.post<{ data: { id: string } }>('/api/v1/pm/teams', { key: key || name.slice(0, 3).toUpperCase(), name, is_private: isPrivate }),
    onSuccess: async (r) => {
      if (cycles) await api.patch(`/api/v1/pm/teams/${r.data.id}`, { cycles_enabled: true }).catch(() => undefined)
      setCreateOpen(false); setName(''); setKey('')
      void qc.invalidateQueries({ queryKey: ['pm', 'teams'] })
    },
    onError: (e) => toast({ title: 'Could not create team', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }),
  })

  const d = teamsQ.data?.data
  const userName = (id: string) => usersQ.data?.data.find((u) => u.id === id)?.name ?? '—'
  const membersOf = (teamId: string) => (d?.memberships_all ?? []).filter((m) => m.team_id === teamId)
  const joined = new Set((d?.memberships ?? []).map((m) => m.team_id))

  if (teamsQ.isLoading || !d) {
    return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  }

  const cols = 'minmax(170px,1.4fr) 44px 104px 70px 88px 84px 62px'

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>Teams · {d.teams.length}</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
            Every issue lives in exactly one team — teams own workflow states, labels, templates, cycles and estimates
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {canCreate ? (
          <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setCreateOpen(true)}>Create team</Btn>
        ) : (
          <Pill><Icon.lock size={10} /> Owner / Admin / Manager can create teams</Pill>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '9px 14px', borderBottom: '1px solid var(--bord)', fontSize: 9.5, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
          <span>Team</span><span>Key</span><span>Members</span><span>Cycles</span><span>Estimates</span><span>Visibility</span><span />
        </div>
        {d.teams.map((t) => {
          const members = membersOf(t.id)
          const lead = members.find((m) => m.is_lead)
          const isJoined = joined.has(t.id)
          return (
            <div
              key={t.id}
              onClick={() => router.push(`/pm/teams/${t.id}/settings`)}
              style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', padding: '9px 14px', borderBottom: '1px solid var(--bord)', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surf-1)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <span style={{ width: 22, height: 22, borderRadius: 6, background: t.color ?? '#3E7BFA', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{t.key[0]}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                    {isJoined && <span style={{ fontSize: 8.5, fontWeight: 800, color: 'var(--green)' }}>Joined</span>}
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>Lead · {lead ? userName(lead.user_id) : '—'}</div>
                </div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{t.key}</span>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {members.slice(0, 3).map((m, i) => (
                  <span key={m.user_id} title={userName(m.user_id)} style={{ width: 19, height: 19, borderRadius: '50%', background: avBg(userName(m.user_id)), color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 7.5, fontWeight: 800, marginLeft: i > 0 ? -6 : 0, boxShadow: '0 0 0 2px var(--bg)' }}>
                    {initials(userName(m.user_id))}
                  </span>
                ))}
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)', marginLeft: 6 }}>{members.length}</span>
              </div>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: t.cycles_enabled ? 'var(--text-2)' : 'var(--text-faint)' }}>
                {t.cycles_enabled ? `${t.cycle_length_weeks}-wk` : 'Off'}
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-2)', textTransform: 'capitalize' }}>{t.estimate_scale}</span>
              {t.is_private
                ? <Pill tone="coral"><Icon.lock size={9} /> Private</Pill>
                : <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)' }}>Public</span>}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                {!isJoined && !t.is_private && (
                  <button onClick={(e) => { e.stopPropagation(); join.mutate(t.id) }} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}>Join</button>
                )}
                <Icon.chevR size={12} style={{ color: 'var(--text-faint)' }} />
              </div>
            </div>
          )
        })}
        <div style={{ padding: '9px 14px', fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>
          Public teams are open to join · private teams are invite-only and hidden from non-members — auditor seats never see them · click a team to open its settings
        </div>
      </div>

      {createOpen && (
        <div onClick={() => setCreateOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1150, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 420, borderRadius: 15, padding: '22px 24px' }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>New team</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', marginBottom: 14 }}>Owner / Admin / Manager · ready to use with zero setup</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input className="input" placeholder="Team name" autoFocus value={name}
                onChange={(e) => { setName(e.target.value); if (!key) setKey(e.target.value.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()) }}
                style={{ flex: 1, height: 34, fontSize: 12.5 }} />
              <input className="input" placeholder="KEY" value={key} onChange={(e) => setKey(e.target.value.toUpperCase().slice(0, 6))} style={{ width: 80, height: 34, fontSize: 12.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, marginBottom: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={cycles} onChange={(e) => setCycles(e.target.checked)} /> Enable cycles
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private team
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn kind="ghost" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Btn>
              <Btn kind="primary" size="sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create team</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
