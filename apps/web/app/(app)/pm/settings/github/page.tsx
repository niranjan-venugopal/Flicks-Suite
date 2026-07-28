'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, Toggle } from '@/components/proto'
import { Kbd, StateGlyph } from '@/components/pm/glyphs'
import { api } from '@/lib/api/client'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'
import { FEATURES } from '@/lib/feature-flags'

// ─────────────────────────────────────────────────────────
// P16 — GitHub settings (§12), faithful to scr-settings-pm.jsx ScrGithub:
// connect card → status/health card → repo↔team mapping → status automation
// (FlowStep tiles + magic words / personal automation / bot comment) →
// branch format → webhook health. Owner/Admin manage; everyone can read.
// ─────────────────────────────────────────────────────────

interface GhStatus {
  data: {
    installation: {
      id: string
      installation_id: number
      account_login: string
      branch_format: string
      status: 'active' | 'error'
      failed_deliveries: number
      last_delivery_status: number | null
      last_delivery_at: string | null
    } | null
    repos: Array<{ id: string; repo_full_name: string; team_id: string; team_key: string; autolink: boolean }>
    app_slug: string | null
  }
}

interface TeamsResponse {
  data: {
    teams: Array<{
      id: string
      key: string
      name: string
      gh_auto_branch: boolean
      gh_auto_pr_open: boolean
      gh_auto_pr_merge: boolean
      gh_auto_pr_close: boolean
      gh_magic_words: boolean
      gh_bot_comment: boolean
    }>
  }
}

const PERSONAL_AUTO_KEY = 'pm-gh-personal-auto'

function SettingsTabs({ active }: { active: 'github' | 'notifications' }) {
  const tab = (href: string, label: string, on: boolean) => (
    <Link
      href={href}
      style={{
        padding: '5px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 800, textDecoration: 'none',
        color: on ? '#fff' : 'var(--text-mute)', background: on ? 'var(--surf-2)' : 'transparent',
        border: on ? '1px solid var(--bord-2)' : '1px solid transparent',
      }}
    >{label}</Link>
  )
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
      {FEATURES.pm_github && tab('/pm/settings/github', 'GitHub', active === 'github')}
      {tab('/pm/settings/notifications', 'Notifications', active === 'notifications')}
      {tab('/pm/settings/import', 'Import', false)}
      {tab('/pm/settings/workspace', 'Workspace', false)}
    </div>
  )
}

/** FlowStep tile (prototype 240-249): label + from→to glyphs + toggle. */
function FlowStep({
  label, from, to, on, disabled, onChange,
}: { label: string; from: string; to: string; on: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', borderRadius: 9,
      background: 'var(--surf-1)', border: '1px solid var(--bord)',
    }}>
      <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700 }}>{label}</span>
      <StateGlyph cat={from} size={13} />
      <Icon.arrow size={11} style={{ color: 'var(--text-faint)' }} />
      <StateGlyph cat={to} size={13} />
      <Toggle on={on} onChange={disabled ? () => undefined : onChange} />
    </div>
  )
}

/**
 * Coming-soon state while GitHub is parked (FEATURES.pm_github).
 * The full P16 console below is untouched — flipping the flag restores it.
 */
function GithubComingSoon() {
  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '18px 20px' }}>
      <SettingsTabs active="github" />
      <div className="card" style={{ position: 'relative', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--surf-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)' }}>
            <Icon.gitPr size={17} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>GitHub integration</div>
            <div className="t-mute" style={{ fontSize: 11.5 }}>
              Branch → PR → merge moves the issue, with git chips on the issue page
            </div>
          </div>
          <Pill tone="yellow">Coming soon</Pill>
        </div>
        <div style={{ marginTop: 10, lineHeight: 1.6, fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
          We&apos;re switching the connection from an org-wide GitHub App install to
          signing in with your own GitHub account (OAuth) — so the link is tied to
          you, scopes stay minimal, and access follows your GitHub permissions.
          The automations are built and tested; they turn on with the new connect flow.
        </div>
      </div>
    </div>
  )
}

export default function PmGithubSettingsPage() {
  if (!FEATURES.pm_github) return <GithubComingSoon />
  return <PmGithubSettingsPageInner />
}

function PmGithubSettingsPageInner() {
  const role = useAuthStore((s) => s.currentUser?.role)
  const canAdmin = role === 'OWNER' || role === 'HR_ADMIN'
  const { toast } = useToast()
  const qc = useQueryClient()

  const status = useQuery({
    queryKey: ['pm', 'github', 'status'],
    queryFn: () => api.get<GhStatus>('/api/v1/pm/github/status'),
    retry: false,
  })
  const teamsQ = useQuery({
    queryKey: ['pm', 'teams', 'gh-settings'],
    queryFn: () => api.get<TeamsResponse>('/api/v1/pm/teams'),
  })

  const [claimOpen, setClaimOpen] = useState(false)
  const [claimId, setClaimId] = useState('')
  const [mapOpen, setMapOpen] = useState(false)
  const [repoName, setRepoName] = useState('')
  const [repoTeam, setRepoTeam] = useState('')
  const [teamId, setTeamId] = useState('')
  const [fmt, setFmt] = useState<string | null>(null)
  const [personalAuto, setPersonalAuto] = useState(
    () => typeof window === 'undefined' || window.localStorage.getItem(PERSONAL_AUTO_KEY) !== '0',
  )

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pm', 'github'] })
  const fail = (e: unknown) =>
    toast({ title: 'Could not save', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })

  // Two-step handshake: the server mints a one-shot state nonce (and the
  // install URL) and only accepts a claim carrying it — an installation id on
  // its own proves nothing, so it can't be used to squat another org's install.
  const claim = useMutation({
    mutationFn: async () => {
      const started = await api.post<{ data: { state: string; url: string | null } }>(
        '/api/v1/pm/github/install-url',
        {},
      )
      return api.post('/api/v1/pm/github/install', {
        installation_id: Number(claimId),
        state: started.data.state,
      })
    },
    onSuccess: () => { setClaimOpen(false); setClaimId(''); invalidate() },
    onError: fail,
  })
  const uninstall = useMutation({
    mutationFn: () => api.post('/api/v1/pm/github/uninstall', {}),
    onSuccess: invalidate,
    onError: fail,
  })
  const mapRepo = useMutation({
    mutationFn: () => api.post('/api/v1/pm/github/repos', { repo_full_name: repoName.trim(), team_id: repoTeam }),
    onSuccess: () => { setMapOpen(false); setRepoName(''); invalidate() },
    onError: fail,
  })
  const unmapRepo = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/pm/github/repos/${id}/delete`, {}),
    onSuccess: invalidate,
    onError: fail,
  })
  const saveFormat = useMutation({
    mutationFn: (format: string) => api.patch('/api/v1/pm/github/branch-format', { format }),
    onSuccess: invalidate,
    onError: fail,
  })
  const redeliver = useMutation({
    mutationFn: () => api.post('/api/v1/pm/github/redeliver', {}),
    onSuccess: (r) => {
      invalidate()
      const d = (r as { data?: { reprocessed?: number } }).data
      toast({ title: 'Redelivered', description: `${d?.reprocessed ?? 0} deliveries re-processed.` })
    },
    onError: fail,
  })
  const patchTeam = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, boolean> }) =>
      api.patch(`/api/v1/pm/teams/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pm', 'teams'] }),
    onError: fail,
  })

  const inst = status.data?.data.installation ?? null
  const repos = status.data?.data.repos ?? []
  const appSlug = status.data?.data.app_slug
  const teams = teamsQ.data?.data.teams ?? []
  const team = teams.find((t) => t.id === teamId) ?? teams[0] ?? null
  const uiState: 'none' | 'installed' | 'error' =
    !inst ? 'none' : inst.status === 'error' || inst.failed_deliveries > 0 ? 'error' : 'installed'
  const format = fmt ?? inst?.branch_format ?? '{user}/{team-key-lower}-{number}-{slug}'
  const preview = format
    .replace('{user}', 'diya')
    .replace('{team-key-lower}', (team?.key ?? 'eng').toLowerCase())
    .replace('{number}', '142')
    .replace('{slug}', 'fix-login')

  const toggleTeam = (key: string) => (v: boolean) => {
    if (!team || !canAdmin) return
    patchTeam.mutate({ id: team.id, patch: { [key]: v } })
  }
  const togglePersonal = (v: boolean) => {
    setPersonalAuto(v)
    if (typeof window !== 'undefined') window.localStorage.setItem(PERSONAL_AUTO_KEY, v ? '1' : '0')
  }

  if (status.isLoading) {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '18px 20px' }}>
      <SettingsTabs active="github" />

      {uiState === 'none' ? (
        <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
          <div style={{
            width: 50, height: 50, borderRadius: 14, background: 'var(--surf-2)', color: 'var(--text-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px',
          }}><Icon.gitBranch size={22} /></div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 7 }}>Connect GitHub</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.6, maxWidth: 400, margin: '0 auto 16px' }}>
            One free GitHub App — branch/PR autolinks, magic words, status automation. Org admin installs; no paid plan required.
          </div>
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', opacity: canAdmin ? 1 : 0.45, pointerEvents: canAdmin ? 'auto' : 'none' }}>
            <Btn
              kind="primary"
              onClick={() => {
                if (appSlug) window.open(`https://github.com/apps/${appSlug}/installations/new`, '_blank')
                setClaimOpen(true)
              }}
            >Install GitHub App</Btn>
          </div>
          {!canAdmin && (
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', marginTop: 8 }}>Owner/Admin only</div>
          )}
          {claimOpen && canAdmin && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
              <input
                className="input"
                placeholder="installation id"
                value={claimId}
                onChange={(e) => setClaimId(e.target.value.replace(/\D/g, ''))}
                style={{ width: 180, height: 32, fontSize: 12, fontFamily: 'var(--font-mono)' }}
              />
              <Btn kind="primary" size="sm" disabled={!claimId} onClick={() => claim.mutate()}>Finish connection</Btn>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Status / health */}
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <span style={{
              width: 38, height: 38, borderRadius: 11, flexShrink: 0,
              background: uiState === 'error' ? 'rgba(248,120,107,.12)' : 'rgba(39,210,128,.12)',
              color: uiState === 'error' ? 'var(--coral)' : 'var(--green)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{uiState === 'error' ? <Icon.warn size={17} /> : <Icon.check size={17} />}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>github.com/{inst!.account_login}</div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                installation {inst!.installation_id} · metadata:read · pull_requests:read/write · contents:read
              </div>
            </div>
            {uiState === 'error'
              ? <Pill tone="coral" dot>{inst!.failed_deliveries} failed deliveries</Pill>
              : <Pill tone="green" dot>Healthy</Pill>}
            {canAdmin && (
              <Btn kind="ghost" size="sm" onClick={() => uninstall.mutate()}>Uninstall</Btn>
            )}
          </div>

          {/* Repo → team mapping */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, flex: 1 }}>Repo → team mapping</span>
              {canAdmin && (
                <Btn kind="ghost" size="sm" icon={<Icon.plus size={12} />} onClick={() => setMapOpen((o) => !o)}>Map repo</Btn>
              )}
            </div>
            {mapOpen && canAdmin && (
              <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
                <input
                  className="input"
                  placeholder="owner/repo"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  style={{ flex: 1, height: 32, fontSize: 12, fontFamily: 'var(--font-mono)' }}
                />
                <select className="input" value={repoTeam} onChange={(e) => setRepoTeam(e.target.value)} style={{ height: 32, fontSize: 12, fontWeight: 700 }}>
                  <option value="">team…</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.key}</option>)}
                </select>
                <Btn kind="primary" size="sm" disabled={!repoName.trim() || !repoTeam} onClick={() => mapRepo.mutate()}>Add</Btn>
              </div>
            )}
            {repos.length === 0 ? (
              <div style={{ padding: '18px 14px', fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                No repos mapped yet — map one so branches and PRs can link issues.
              </div>
            ) : repos.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 14px', borderBottom: '1px solid var(--bord)' }}>
                <Icon.gitBranch size={12} style={{ color: 'var(--text-mute)' }} />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.repo_full_name}</span>
                <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: '#3E7BFA', border: '1px solid rgba(62,123,250,.4)', borderRadius: 6, padding: '1px 7px' }}>{r.team_key}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800, color: 'var(--green)' }}>
                  <Icon.check size={10} /> autolink
                </span>
                {canAdmin && (
                  <button onClick={() => unmapRepo.mutate(r.id)} title="Remove mapping" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2 }}>
                    <Icon.x size={11} />
                  </button>
                )}
              </div>
            ))}
            <div style={{ padding: '9px 14px', fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>
              installation-scoped — a repo in tenant A can never link issues in tenant B
            </div>
          </div>

          {/* Status automation */}
          {team && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 12.5, fontWeight: 800 }}>
                  Status automation · {team.key}
                  <span style={{ color: 'var(--text-faint)', fontWeight: 700 }}> on by default</span>
                </span>
                <span style={{ flex: 1 }} />
                {teams.length > 1 && (
                  <select className="input" value={team.id} onChange={(e) => setTeamId(e.target.value)} style={{ height: 28, fontSize: 11, fontWeight: 700 }}>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.key}</option>)}
                  </select>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                <FlowStep label="branch created" from="backlog" to="started" on={team.gh_auto_branch} disabled={!canAdmin} onChange={toggleTeam('gh_auto_branch')} />
                <FlowStep label="PR opened" from="started" to="started" on={team.gh_auto_pr_open} disabled={!canAdmin} onChange={toggleTeam('gh_auto_pr_open')} />
                <FlowStep label="PR merged" from="started" to="completed" on={team.gh_auto_pr_merge} disabled={!canAdmin} onChange={toggleTeam('gh_auto_pr_merge')} />
                <FlowStep label="PR closed unmerged" from="started" to="unstarted" on={team.gh_auto_pr_close} disabled={!canAdmin} onChange={toggleTeam('gh_auto_pr_close')} />
              </div>
              {[
                { label: 'Magic words', sub: '“fixes ENG-142” closes on merge', on: team.gh_magic_words, onChange: toggleTeam('gh_magic_words') },
                { label: 'Personal automation', sub: 'copy-branch assigns me + moves to started', on: personalAuto, onChange: togglePersonal },
                { label: 'Bot comment on PR', sub: 'one link-back comment', on: team.gh_bot_comment, onChange: toggleTeam('gh_bot_comment') },
              ].map((row) => (
                <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px', borderTop: '1px solid var(--bord)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800 }}>{row.label}</div>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>{row.sub}</div>
                  </div>
                  <Toggle on={row.on} onChange={row.onChange} />
                </div>
              ))}
            </div>
          )}

          {/* Branch format */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9 }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, flex: 1 }}>Branch format</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Kbd>⌘⇧B</Kbd>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)' }}>copy on any issue</span>
              </span>
            </div>
            <input
              className="input"
              value={format}
              disabled={!canAdmin}
              onChange={(e) => setFmt(e.target.value)}
              onBlur={() => { if (fmt && fmt !== inst!.branch_format) saveFormat.mutate(fmt) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && fmt && fmt !== inst!.branch_format) saveFormat.mutate(fmt) }}
              style={{ width: '100%', height: 34, fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 700 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>preview</span>
              <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>{preview}</span>
            </div>
          </div>

          {/* Webhook health */}
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon.zap size={16} style={{ color: uiState === 'error' ? 'var(--coral)' : 'var(--purple)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800 }}>Webhook health</div>
              <div style={{ fontSize: 10.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', marginTop: 2 }}>
                {inst!.last_delivery_at
                  ? `last delivery ${inst!.last_delivery_status ?? '—'} · ${new Date(inst!.last_delivery_at).toLocaleString()} · X-Hub-Signature-256 verified · idempotent by delivery-id`
                  : 'no deliveries yet · X-Hub-Signature-256 verified · idempotent by delivery-id'}
              </div>
            </div>
            {uiState === 'error' && canAdmin && (
              <Btn kind="ghost" size="sm" icon={<Icon.refresh size={12} />} onClick={() => redeliver.mutate()}>Redeliver</Btn>
            )}
          </div>
        </>
      )}
    </div>
  )
}
