'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Toggle } from '@/components/proto'
import { api } from '@/lib/api/client'
import { usePm } from '@/lib/pm/PmProvider'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'

// ─────────────────────────────────────────────────────────
// P18 — Workspace settings (§15.4), faithful to scr-settings-pm.jsx
// ScrPmWorkspace: module row → workspace labels → branch format default →
// Recently deleted (30-day restore, per-row Purge) → sync status + Reset
// local data. Owner/Admin manage; others read.
// ─────────────────────────────────────────────────────────

interface DeletedResponse {
  data: {
    issues: Array<{ id: string; key: string; title: string; deleted_at: string }>
    projects: Array<{ id: string; name: string; deleted_at: string }>
  }
}

function SettingsTabs({ active }: { active: string }) {
  const tabs = [
    ['/pm/settings/github', 'GitHub'],
    ['/pm/settings/notifications', 'Notifications'],
    ['/pm/settings/import', 'Import'],
    ['/pm/settings/workspace', 'Workspace'],
  ] as const
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
      {tabs.map(([href, label]) => (
        <Link key={href} href={href} style={{
          padding: '5px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 800, textDecoration: 'none',
          color: href.includes(active) ? '#fff' : 'var(--text-mute)',
          background: href.includes(active) ? 'var(--surf-2)' : 'transparent',
          border: href.includes(active) ? '1px solid var(--bord-2)' : '1px solid transparent',
        }}>{label}</Link>
      ))}
    </div>
  )
}

function daysAgo(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return d === 0 ? 'today' : `${d}d ago`
}

export default function PmWorkspacePage() {
  const role = useAuthStore((s) => s.currentUser?.role)
  const canWs = role === 'OWNER' || role === 'HR_ADMIN'
  const { engine } = usePm()
  const qc = useQueryClient()
  const { toast } = useToast()
  const [newLabel, setNewLabel] = useState('')
  const [resetOpen, setResetOpen] = useState(false)

  const teamsQ = useQuery({
    queryKey: ['pm', 'teams', 'workspace'],
    queryFn: () => api.get<{ data: { labels: Array<{ id: string; name: string; color: string; team_id: string | null }> } }>('/api/v1/pm/teams'),
  })
  const ghQ = useQuery({
    queryKey: ['pm', 'github', 'status'],
    queryFn: () => api.get<{ data: { installation: { branch_format: string } | null } }>('/api/v1/pm/github/status'),
    retry: false,
  })
  const deletedQ = useQuery({
    queryKey: ['pm', 'recently-deleted'],
    queryFn: () => api.get<DeletedResponse>('/api/v1/pm/recently-deleted'),
  })

  const addLabel = useMutation({
    mutationFn: () => api.post('/api/v1/pm/labels', { name: newLabel.trim(), color: '#5C6477' }),
    onSuccess: () => { setNewLabel(''); void qc.invalidateQueries({ queryKey: ['pm', 'teams'] }) },
    onError: (e) => toast({ title: 'Could not add label', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }),
  })
  const restoreIssue = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/pm/issues/${id}/restore`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['pm', 'recently-deleted'] }); void engine?.pullDelta() },
  })
  const restoreProject = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/pm/projects/${id}/restore`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['pm', 'recently-deleted'] }); void engine?.pullDelta() },
  })
  const purge = useMutation({
    mutationFn: ({ kind, id }: { kind: 'issue' | 'project'; id: string }) =>
      api.post(`/api/v1/pm/recently-deleted/${kind}/${id}/purge`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pm', 'recently-deleted'] }),
    onError: (e) => toast({ title: 'Could not purge', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }),
  })

  const wsLabels = (teamsQ.data?.data.labels ?? []).filter((l) => !l.team_id)
  const deleted = deletedQ.data?.data
  const cursor = engine?.store.cursor ?? 0

  const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 14px', borderBottom: '1px solid var(--bord)' } as const

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 13 }}>
      <SettingsTabs active="workspace" />

      {/* Projects module */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Icon.target size={16} style={{ color: 'var(--blue)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800 }}>Projects module</div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
            Toggle-gated (FAM `pm`) · requires a user pm grant · default ON for new tenants
          </div>
        </div>
        <Toggle on onChange={() => undefined} />
      </div>

      {/* Workspace labels */}
      <div className="card">
        <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 9 }}>Workspace labels</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: canWs ? 10 : 0 }}>
          {wsLabels.map((l) => (
            <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 99, background: 'var(--surf-1)', border: '1px solid var(--bord)', fontSize: 11, fontWeight: 700 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.color }} />
              {l.name}
            </span>
          ))}
          {wsLabels.length === 0 && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)' }}>No workspace labels yet.</span>}
        </div>
        {canWs && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" placeholder="New workspace label…" value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newLabel.trim()) addLabel.mutate() }}
              style={{ flex: 1, height: 32, fontSize: 12 }} />
            <Btn kind="secondary" size="sm" disabled={!newLabel.trim()} onClick={() => addLabel.mutate()}>Add</Btn>
          </div>
        )}
      </div>

      {/* Branch format default */}
      <div className="card">
        <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 9 }}>Branch format default</div>
        <input
          className="input"
          value={ghQ.data?.data.installation?.branch_format ?? '{user}/{team-key-lower}-{number}-{slug}'}
          disabled
          style={{ width: '100%', height: 34, fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 700 }}
        />
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', marginTop: 6 }}>
          Managed under Settings → GitHub once the App is connected.
        </div>
      </div>

      {/* Recently deleted */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
          <span style={{ fontSize: 12.5, fontWeight: 800, flex: 1 }}>Recently deleted</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>30-day restore · then purged</span>
        </div>
        {deleted && deleted.issues.length === 0 && deleted.projects.length === 0 && (
          <div style={{ padding: '16px 14px', fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
            Nothing here — deleted issues and projects appear for 30 days.
          </div>
        )}
        {deleted?.issues.map((i) => (
          <div key={i.id} style={rowStyle}>
            <span style={{ width: 56, fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{i.key}</span>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 700, textDecoration: 'line-through', opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.title}</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>deleted {daysAgo(i.deleted_at)}</span>
            <Btn kind="secondary" size="sm" onClick={() => restoreIssue.mutate(i.id)}>Restore</Btn>
            {canWs && (
              <Btn kind="ghost" size="sm" onClick={() => purge.mutate({ kind: 'issue', id: i.id })}>
                <span style={{ color: 'var(--coral)' }}>Purge</span>
              </Btn>
            )}
          </div>
        ))}
        {deleted?.projects.map((p) => (
          <div key={p.id} style={rowStyle}>
            <span style={{ width: 56, fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)' }}>proj</span>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 700, textDecoration: 'line-through', opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>deleted {daysAgo(p.deleted_at)}</span>
            <Btn kind="secondary" size="sm" onClick={() => restoreProject.mutate(p.id)}>Restore</Btn>
            {canWs && (
              <Btn kind="ghost" size="sm" onClick={() => purge.mutate({ kind: 'project', id: p.id })}>
                <span style={{ color: 'var(--coral)' }}>Purge</span>
              </Btn>
            )}
          </div>
        ))}
      </div>

      {/* Sync status + reset (§3.7 recovery surfaces) */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: engine ? 'var(--green)' : 'var(--text-faint)' }} />
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 800 }}>Sync status</div>
            <div style={{ fontSize: 10.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>
              {engine ? `cursor seq ${cursor.toLocaleString()} · horizon 90d · IndexedDB` : 'REST mode (sync engine off)'}
            </div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--bord)', paddingTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 800 }}>Reset local data</div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
              Wipes this device&apos;s cache and re-bootstraps from the server. Your data is safe — worst case is a refresh, never corruption.
            </div>
          </div>
          <Btn kind="secondary" size="sm" disabled={!engine} onClick={() => setResetOpen(true)}>Reset…</Btn>
        </div>
      </div>

      {resetOpen && (
        <div onClick={() => setResetOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1150, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 400, borderRadius: 15, padding: '22px 24px' }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Reset local data?</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', marginBottom: 10 }}>Re-bootstrap takes ~2s on this workspace</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 16 }}>
              Pending offline mutations are replayed first when possible. The server remains the source of truth — nothing on it is touched.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn kind="ghost" size="sm" onClick={() => setResetOpen(false)}>Cancel</Btn>
              <Btn kind="primary" size="sm" onClick={async () => { setResetOpen(false); await engine?.reset() }}>Reset &amp; re-sync</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
