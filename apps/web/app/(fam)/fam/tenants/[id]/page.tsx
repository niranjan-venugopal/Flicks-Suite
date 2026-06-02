'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import {
  Avatar,
  Btn,
  Icon,
  Kpi,
  Pill,
  SectionHead,
} from '@/components/proto'
import {
  useFamTenant,
  useFamTenantMembers,
  useFamTenantUsage,
  useFamTenantBilling,
  useFamTenantAudit,
  useSuspendTenant,
  useReactivateTenant,
  useExtendTrial,
  useVerifyTenant,
  useStartImpersonation,
  type FamTenantMember,
} from '@/lib/api/queries/use-fam'
import { ImpersonateModal } from '@/components/fam/ImpersonateModal'
import { formatCurrency, formatDate, timeAgo } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

type TabKey = 'overview' | 'members' | 'usage' | 'billing' | 'audit' | 'settings'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'members',  label: 'Members' },
  { key: 'usage',    label: 'Usage' },
  { key: 'billing',  label: 'Billing' },
  { key: 'audit',    label: 'Audit' },
  { key: 'settings', label: 'Settings' },
]

function statusTone(s: string) {
  switch (s) {
    case 'active':    return 'green'
    case 'trialing':  return 'blue'
    case 'past_due':  return 'yellow'
    case 'suspended':
    case 'canceled':  return 'coral'
    default:          return ''
  }
}
function signalTone(s: string | null | undefined) {
  switch (s) {
    case 'healthy':   return 'green'
    case 'expanding': return 'blue'
    case 'new':
    case 'at_risk':   return 'yellow'
    case 'churning':  return 'coral'
    default:          return ''
  }
}
function roleTone(r: string) {
  switch (r) {
    case 'fam':
    case 'super_admin': return 'purple'
    case 'owner':       return 'yellow'
    case 'admin':       return 'blue'
    case 'manager':     return 'green'
    case 'finance':     return 'coral'
    default:            return ''
  }
}
function memberStatusTone(s: string) {
  switch (s) {
    case 'active':   return 'green'
    case 'invited':  return 'yellow'
    case 'inactive': return 'coral'
    default:         return ''
  }
}

export default function FamTenantDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id ?? null
  const tenant = useFamTenant(id)
  const [tab, setTab] = useState<TabKey>('overview')

  if (tenant.isLoading) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)' }}>
        <Loader2 className="w-5 h-5 animate-spin" style={{ display: 'inline-block' }} />
      </div>
    )
  }
  if (!tenant.data) {
    return (
      <div style={{ padding: '28px 32px', maxWidth: 720, margin: '0 auto' }}>
        <SectionHead title="Tenant not found" sub="It may have been deleted, or the ID is wrong." />
        <Link href="/fam/tenants" style={{ textDecoration: 'none' }}>
          <Btn kind="secondary" size="sm" icon={<Icon.arrowL size={12} />}>
            Back to tenants
          </Btn>
        </Link>
      </div>
    )
  }

  const t = tenant.data

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        {/* Header card — gradient banner + embedded tab strip (prototype style) */}
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 18 }}>
          <div
            style={{
              padding: '20px 22px',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              flexWrap: 'wrap',
              background: 'linear-gradient(135deg, rgba(62,123,250,.08), rgba(155,123,250,.04))',
            }}
          >
            <Link
              href="/fam/tenants"
              style={{
                width: 32, height: 32, borderRadius: 8, background: 'var(--surf-1)',
                border: '1px solid var(--bord)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', color: 'var(--text-2)',
              }}
              aria-label="Back to tenants"
            >
              <Icon.chevL size={14} />
            </Link>
            <Avatar name={t.name} size="lg" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }}>
                  {t.name}
                </h1>
                <Pill tone={statusTone(t.status)} dot>{t.status.replace('_', ' ')}</Pill>
                {t.subscription?.planCode && <Pill tone="purple">{t.subscription.planCode}</Pill>}
                {t.verifiedAt ? (
                  <Pill tone="green" dot>Verified</Pill>
                ) : (
                  <Pill tone="yellow" dot>Unverified</Pill>
                )}
              </div>
              <div
                style={{
                  marginTop: 5, fontSize: 12, fontWeight: 600, color: 'var(--text-mute)',
                  display: 'flex', gap: 12, flexWrap: 'wrap', fontFamily: 'var(--font-mono)',
                }}
              >
                <span>{t.slug}.flickssuite.com</span>
                <span>·</span>
                <span>{t.gstin ? `GSTIN ${t.gstin}` : 'no GSTIN'}</span>
                <span>·</span>
                <span>Joined {timeAgo(t.createdAt)}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />} onClick={() => setTab('settings')}>
                Extend trial
              </Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.shield size={13} />} onClick={() => setTab('settings')}>
                {t.status === 'suspended' ? 'Reactivate' : 'Suspend'}
              </Btn>
              <Btn kind="primary" size="sm" icon={<Icon.zap size={13} />} onClick={() => setTab('members')}>
                Impersonate
              </Btn>
            </div>
          </div>

          {/* Tab strip embedded in the header card */}
          <div
            style={{
              display: 'flex',
              padding: '0 22px',
              borderTop: '1px solid var(--bord)',
              background: 'rgba(0,0,0,.2)',
              overflowX: 'auto',
            }}
          >
            {TABS.map((x) => {
              const active = tab === x.key
              return (
                <button
                  key={x.key}
                  type="button"
                  onClick={() => setTab(x.key)}
                  style={{
                    background: 'transparent',
                    border: 0,
                    padding: '13px 14px',
                    fontSize: 12.5,
                    fontWeight: active ? 800 : 700,
                    color: active ? '#fff' : 'var(--text-mute)',
                    borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
                    marginBottom: -1,
                    cursor: 'pointer',
                    letterSpacing: '-0.01em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {x.label}
                </button>
              )
            })}
          </div>
        </div>

        {tab === 'overview' && <OverviewTab tenant={t} setTab={setTab} />}
        {tab === 'members'  && id && <MembersTab tenantId={id} />}
        {tab === 'usage'    && id && <UsageTab tenantId={id} currency={t.currency} />}
        {tab === 'billing'  && id && <BillingTab tenantId={id} currency={t.currency} />}
        {tab === 'audit'    && id && <AuditTab tenantId={id} />}
        {tab === 'settings' && id && (
          <SettingsTab tenantId={id} tenant={t} />
        )}
      </div>
    </div>
  )
}

// ─── Overview tab ───────────────────────────────────────────────────────────

function OverviewTab({
  tenant,
  setTab,
}: {
  tenant: NonNullable<ReturnType<typeof useFamTenant>['data']>
  setTab: (t: TabKey) => void
}) {
  const t = tenant
  const usersForKpi = t.subscription?.userCount ?? t.employeeCount
  const { toast } = useToast()
  const verifyMut = useVerifyTenant()
  const extendMut = useExtendTrial()
  const suspendMut = useSuspendTenant()
  const reactivateMut = useReactivateTenant()
  const busy =
    verifyMut.isPending || extendMut.isPending || suspendMut.isPending || reactivateMut.isPending

  const runVerify = () => {
    if (!window.confirm(`Mark ${t.name} as verified? This cannot be undone here.`)) return
    verifyMut.mutate(t.id, {
      onSuccess: () => toast({ title: 'Tenant verified' }),
      onError: (e) =>
        toast({ title: 'Verify failed', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' }),
    })
  }
  const runExtend = () => {
    extendMut.mutate(
      { id: t.id, days: 14 },
      {
        onSuccess: (r) => toast({ title: 'Trial extended by 14 days', description: `New end: ${formatDate(r.trialEndsAt)}` }),
        onError: (e) =>
          toast({ title: 'Extend failed', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' }),
      },
    )
  }
  const runReactivate = () => {
    reactivateMut.mutate(t.id, {
      onSuccess: () => toast({ title: 'Tenant reactivated' }),
      onError: (e) =>
        toast({ title: 'Reactivate failed', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' }),
    })
  }
  const runSuspend = () => {
    const reason = window.prompt(`Suspend ${t.name}? This blocks all logins. Reason (required):`)
    if (!reason || !reason.trim()) return
    suspendMut.mutate(
      { id: t.id, reason: reason.trim() },
      {
        onSuccess: () => toast({ title: 'Tenant suspended' }),
        onError: (e) =>
          toast({ title: 'Suspend failed', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' }),
      },
    )
  }

  const quickActions: Array<{ label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }> = [
    ...(t.verifiedAt
      ? []
      : [{ label: 'Mark verified', icon: <Icon.shield size={13} />, onClick: runVerify }]),
    ...(t.status === 'trialing'
      ? [{ label: 'Extend trial · 14 days', icon: <Icon.cal size={13} />, onClick: runExtend }]
      : []),
    t.status === 'suspended'
      ? { label: 'Reactivate tenant', icon: <Icon.check size={13} />, onClick: runReactivate }
      : { label: 'Suspend tenant', icon: <Icon.shield size={13} />, onClick: runSuspend, danger: true },
    { label: 'Billing & invoices', icon: <Icon.chart size={13} />, onClick: () => setTab('billing') },
    { label: 'View members', icon: <Icon.people size={13} />, onClick: () => setTab('members') },
    { label: 'Audit trail', icon: <Icon.clock size={13} />, onClick: () => setTab('audit') },
  ]
  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 14,
          marginBottom: 18,
        }}
      >
        <Kpi
          label="Members"
          value={String(t.memberCount)}
          delta={`${t.employeeCount} employees`}
          icon={<Icon.people size={14} />}
          accent="blue"
        />
        <Kpi
          label="MRR"
          value={
            t.subscription
              ? formatCurrency(t.subscription.mrr, t.currency)
              : '—'
          }
          delta={t.subscription ? `${t.subscription.planCode} · ${usersForKpi} users` : 'No subscription'}
          icon={<Icon.chart size={14} />}
          accent="green"
        />
        <Kpi
          label="Health score"
          value={t.health?.score != null ? String(Math.round(t.health.score)) : '—'}
          delta={t.health?.signal ? t.health.signal.replace('_', ' ') : 'No snapshot'}
          icon={<Icon.shield size={14} />}
          accent="purple"
        />
        <Kpi
          label="Active users · 7d"
          value={t.health ? String(t.health.activeUsers7d) : '—'}
          delta={t.health ? `${t.health.activeUsers30d} in 30d` : '—'}
          icon={<Icon.spark size={14} />}
          accent="yellow"
        />
      </div>

      {t.health && (() => {
        const score = t.health.score != null ? Math.round(t.health.score) : null
        const ringHex =
          signalTone(t.health.signal) === 'green' ? '#27D280'
          : signalTone(t.health.signal) === 'blue' ? '#3E7BFA'
          : signalTone(t.health.signal) === 'coral' ? '#F8786B'
          : signalTone(t.health.signal) === 'yellow' ? '#FED800'
          : '#3E7BFA'
        const pct = (n: number | null) =>
          n == null ? null : Math.max(0, Math.min(100, Math.round(n)))
        const rate = (active: number) =>
          t.memberCount > 0 ? Math.min(100, Math.round((active / t.memberCount) * 100)) : null
        const metrics: Array<[string, number | null]> = [
          ['Weekly active rate', rate(t.health.activeUsers7d)],
          ['Monthly active rate', rate(t.health.activeUsers30d)],
          ['Attendance compliance', pct(t.health.attendanceCompliance)],
          ['Feature adoption', pct(t.health.featureAdoptionScore)],
        ]
        const barColor = (v: number) =>
          v >= 80 ? 'var(--green)' : v >= 60 ? 'var(--yellow)' : 'var(--coral)'
        return (
          <div className="card" style={{ marginBottom: 14 }}>
            <SectionHead
              title="Health score"
              sub={`${score != null ? `${score}/100` : 'No score'} · refreshed ${timeAgo(t.health.snapshotDate)}`}
              right={
                t.health.signal ? (
                  <Pill tone={signalTone(t.health.signal)} dot>
                    {t.health.signal.replace('_', ' ')}
                  </Pill>
                ) : undefined
              }
            />
            <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
              <div style={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
                <svg viewBox="0 0 120 120" style={{ width: '100%', height: '100%' }}>
                  <circle cx="60" cy="60" r="50" fill="none" stroke="var(--surf-2)" strokeWidth="10" />
                  <circle
                    cx="60" cy="60" r="50" fill="none" stroke={ringHex} strokeWidth="10"
                    strokeDasharray={`${(score ?? 0) * 3.14} 314`}
                    strokeLinecap="round" transform="rotate(-90 60 60)"
                  />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                  <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.03em' }}>{score ?? '—'}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)', letterSpacing: '.06em' }}>HEALTH</div>
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {metrics.filter(([, v]) => v != null).map(([label, v]) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, fontSize: 11.5, fontWeight: 700 }}>{label}</div>
                    <div style={{ width: 160, height: 6, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
                      <div style={{ width: `${v}%`, height: '100%', background: barColor(v as number), borderRadius: 99 }} />
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 11.5, width: 32, textAlign: 'right' }}>{v}</div>
                  </div>
                ))}
                {metrics.every(([, v]) => v == null) && (
                  <div className="t-mute" style={{ fontSize: 12 }}>No sub-metrics in the latest snapshot.</div>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
            Workspace details
          </div>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 10, columnGap: 14, fontSize: 12.5 }}>
            <DetailRow k="Legal name" v={t.legalName ?? '—'} />
            <DetailRow
              k="GSTIN"
              v={
                t.gstin ? (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{t.gstin}</span>
                ) : (
                  '—'
                )
              }
            />
            <DetailRow
              k="PAN"
              v={
                t.pan ? (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{t.pan}</span>
                ) : (
                  '—'
                )
              }
            />
            <DetailRow k="Industry"   v={t.industry ?? '—'} />
            <DetailRow k="Size band"  v={t.sizeBand ?? '—'} />
            <DetailRow k="Location"   v={[t.city, t.stateCode, t.country].filter(Boolean).join(', ') || '—'} />
            <DetailRow k="Timezone"   v={t.timezone} />
            <DetailRow k="Currency"   v={t.currency} />
            <DetailRow k="Created"    v={formatDate(t.createdAt)} />
            <DetailRow k="Trial ends" v={t.trialEndsAt ? formatDate(t.trialEndsAt) : '—'} />
            <DetailRow k="Verified"   v={t.verifiedAt ? formatDate(t.verifiedAt) : 'Pending'} />
          </dl>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
            Subscription
          </div>
          {t.subscription ? (
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '130px 1fr', rowGap: 10, columnGap: 14, fontSize: 12.5 }}>
              <DetailRow k="Plan"          v={<span style={{ textTransform: 'capitalize', fontWeight: 800 }}>{t.subscription.planCode}</span>} />
              <DetailRow k="Status"        v={<Pill tone={statusTone(t.subscription.status)} dot>{t.subscription.status.replace('_', ' ')}</Pill>} />
              <DetailRow k="Billing cycle" v={t.subscription.billingCycle} />
              <DetailRow k="Per user"      v={formatCurrency(t.subscription.perUserPrice, t.currency)} />
              <DetailRow k="Users"         v={String(t.subscription.userCount)} />
              <DetailRow k="MRR"           v={<strong style={{ fontFamily: 'var(--font-mono)' }}>{formatCurrency(t.subscription.mrr, t.currency)}</strong>} />
              <DetailRow
                k="Current period"
                v={
                  t.subscription.currentPeriodStart && t.subscription.currentPeriodEnd
                    ? `${formatDate(t.subscription.currentPeriodStart)} → ${formatDate(t.subscription.currentPeriodEnd)}`
                    : '—'
                }
              />
              {t.subscription.cancelAtPeriodEnd && (
                <DetailRow k="" v={<span style={{ color: 'var(--coral)', fontWeight: 700 }}>Will cancel at period end</span>} />
              )}
            </dl>
          ) : (
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-mute)' }}>
              No subscription on file yet.
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
            Quick actions
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {quickActions.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                disabled={busy}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 8,
                  background: 'transparent', border: '1px solid var(--bord)',
                  color: a.danger ? 'var(--coral)' : 'var(--text-2)',
                  cursor: busy ? 'default' : 'pointer', fontSize: 12, fontWeight: 700, textAlign: 'left',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {a.icon}
                <span style={{ flex: 1 }}>{a.label}</span>
                <Icon.arrow size={11} style={{ color: 'var(--text-mute)' }} />
              </button>
            ))}
          </div>
        </div>
        </div>
      </div>
    </>
  )
}

function DetailRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--text-mute)', fontWeight: 700 }}>{k}</dt>
      <dd style={{ margin: 0, fontWeight: 700, color: 'var(--text)' }}>{v}</dd>
    </>
  )
}

// ─── Members tab ─────────────────────────────────────────────────────────────

function MembersTab({ tenantId }: { tenantId: string }) {
  const router = useRouter()
  const { toast } = useToast()
  const members = useFamTenantMembers(tenantId)
  const startImpMut = useStartImpersonation()
  const [target, setTarget] = useState<FamTenantMember | null>(null)
  const rows: FamTenantMember[] = members.data?.data ?? []

  const handleImpersonate = async (payload: { reason: string; ticket?: string }) => {
    if (!target) return
    try {
      // Send membershipId (PK of the row we clicked) — server resolves
      // user_id from that row, immune to any stale-userId projection bugs.
      await startImpMut.mutateAsync({
        membershipId: target.membershipId,
        reason: payload.ticket
          ? `${payload.reason} · ticket=${payload.ticket}`
          : payload.reason,
      })
      toast({
        title: 'Impersonating',
        description: `${target.email ?? target.fullName}. Banner shows on every page until you exit.`,
      })
      setTarget(null)
      router.replace('/dashboard')
    } catch (e) {
      toast({
        title: 'Could not start impersonation',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  if (members.isLoading) {
    return (
      <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
        <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} /> Loading members…
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)' }}>
        <Icon.people size={22} style={{ opacity: 0.5 }} />
        <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8 }}>No members yet.</div>
      </div>
    )
  }
  return (
    <>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Status</th>
              <th>Invited</th>
              <th>Accepted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              // Owners are the only role we let FAM impersonate by default
              // (clean read of "the customer view"). Employees / managers
              // are reachable too — useful for reproducing a reported bug.
              // membershipId is the row's PK so we don't need a userId
              // sanity check here anymore — the server resolves user_id
              // from the membership row.
              const canImpersonate = m.status === 'active' && m.role !== 'fam'
              return (
                <tr key={m.membershipId}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <Avatar name={m.fullName ?? m.email ?? '?'} size="sm" />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 800 }}>
                          {m.fullName ?? '—'}
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                          {m.email ?? '—'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Pill tone={roleTone(m.role)} dot>
                      {m.role.replace('_', ' ')}
                    </Pill>
                  </td>
                  <td>
                    <Pill tone={memberStatusTone(m.status)} dot>
                      {m.status}
                    </Pill>
                  </td>
                  <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                    {m.invitedAt ? timeAgo(m.invitedAt) : '—'}
                  </td>
                  <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                    {m.acceptedAt ? timeAgo(m.acceptedAt) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Btn
                      kind="ghost"
                      size="sm"
                      icon={<Icon.shield size={12} />}
                      disabled={!canImpersonate}
                      onClick={() => setTarget(m)}
                    >
                      Impersonate
                    </Btn>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ImpersonateModal
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        targetEmail={target?.email ?? target?.fullName ?? ''}
        onConfirm={handleImpersonate}
        isPending={startImpMut.isPending}
      />
    </>
  )
}

// ─── Usage tab ───────────────────────────────────────────────────────────────

function UsageTab({ tenantId, currency }: { tenantId: string; currency: string }) {
  void currency
  const usage = useFamTenantUsage(tenantId)
  const u = usage.data

  if (usage.isLoading) {
    return <CenteredSpinner label="Loading usage…" />
  }
  if (!u) {
    return <EmptyCard icon={<Icon.warn size={22} />} message="No usage data yet." />
  }

  const compliance =
    u.attendanceCompliance != null ? `${Math.round(u.attendanceCompliance * 100)}%` : '—'
  const adoption =
    u.featureAdoptionScore != null ? `${Math.round(u.featureAdoptionScore)}` : '—'

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 14,
          marginBottom: 18,
        }}
      >
        <Kpi
          label={`Attendance punches · ${u.windowDays}d`}
          value={String(u.attendancePunches)}
          icon={<Icon.fingerprint size={14} />}
          accent="blue"
        />
        <Kpi
          label={`Leave requests · ${u.windowDays}d`}
          value={String(u.leaveRequests)}
          icon={<Icon.cal size={14} />}
          accent="yellow"
        />
        <Kpi
          label={`Timesheets submitted · ${u.windowDays}d`}
          value={String(u.timesheetsSubmitted)}
          icon={<Icon.sheet size={14} />}
          accent="green"
        />
        <Kpi
          label="Active employees"
          value={String(u.activeEmployees)}
          delta={`${u.activeUsers7d} active in 7d`}
          icon={<Icon.people size={14} />}
          accent="purple"
        />
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
          Adoption signals
        </div>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 10, columnGap: 14, fontSize: 12.5 }}>
          <DetailRow k="Attendance compliance"  v={compliance} />
          <DetailRow k="Feature adoption score" v={`${adoption} / 100`} />
          <DetailRow
            k="Health score"
            v={u.healthScore != null ? String(Math.round(u.healthScore)) : '—'}
          />
          <DetailRow k="Active users · 7d"  v={String(u.activeUsers7d)} />
          <DetailRow k="Active users · 30d" v={String(u.activeUsers30d)} />
        </dl>
      </div>
    </>
  )
}

// ─── Billing tab ─────────────────────────────────────────────────────────────

function BillingTab({ tenantId, currency }: { tenantId: string; currency: string }) {
  const billing = useFamTenantBilling(tenantId)
  const data = billing.data

  if (billing.isLoading) return <CenteredSpinner label="Loading billing…" />
  if (!data?.subscription) {
    return (
      <EmptyCard
        icon={<Icon.chart size={22} />}
        message="No subscription on file for this tenant."
      />
    )
  }
  const s = data.subscription

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
      <div className="card" style={{ padding: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
          Subscription
        </div>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '170px 1fr', rowGap: 10, columnGap: 14, fontSize: 12.5 }}>
          <DetailRow k="Plan"          v={<span style={{ textTransform: 'capitalize', fontWeight: 800 }}>{s.planCode}</span>} />
          <DetailRow k="Status"        v={<Pill tone={statusTone(s.status)} dot>{s.status.replace('_', ' ')}</Pill>} />
          <DetailRow k="Billing cycle" v={s.billingCycle} />
          <DetailRow k="Per user"      v={formatCurrency(s.perUserPrice, currency)} />
          <DetailRow k="Users"         v={String(s.userCount)} />
          <DetailRow k="MRR"           v={<strong style={{ fontFamily: 'var(--font-mono)' }}>{formatCurrency(s.mrr, currency)}</strong>} />
          <DetailRow
            k="Current period"
            v={
              s.currentPeriodStart && s.currentPeriodEnd
                ? `${formatDate(s.currentPeriodStart)} → ${formatDate(s.currentPeriodEnd)}`
                : '—'
            }
          />
          <DetailRow k="Trial ends"     v={s.trialEndsAt ? formatDate(s.trialEndsAt) : '—'} />
          <DetailRow k="Razorpay sub"   v={s.razorpaySubscriptionId ?? '—'} />
          {s.cancelAtPeriodEnd && (
            <DetailRow k="" v={<span style={{ color: 'var(--coral)', fontWeight: 700 }}>Will cancel at period end</span>} />
          )}
        </dl>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', fontSize: 12, fontWeight: 800, color: 'var(--text-2)' }}>
          Billing history
        </div>
        {data.events.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--text-mute)' }}>
            No billing events yet.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.events.map((e) => (
              <li
                key={e.id}
                style={{
                  display: 'flex',
                  gap: 11,
                  padding: '12px 18px',
                  borderBottom: '1px solid var(--bord)',
                  alignItems: 'flex-start',
                }}
              >
                <div
                  style={{
                    flex: '0 0 28px',
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: 'var(--surf-2)',
                    border: '1px solid var(--bord)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-2)',
                  }}
                >
                  <Icon.tag size={14} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>{e.eventType}</div>
                  {e.metadata && (
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--text-mute)',
                        fontFamily: 'var(--font-mono)',
                        wordBreak: 'break-word',
                      }}
                    >
                      {JSON.stringify(e.metadata)}
                    </div>
                  )}
                  <div style={{ marginTop: 4, fontSize: 11, fontWeight: 600, color: 'var(--text-faint)' }}>
                    {timeAgo(e.createdAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── Audit tab ───────────────────────────────────────────────────────────────

function AuditTab({ tenantId }: { tenantId: string }) {
  const [page, setPage] = useState(1)
  const limit = 25
  const audit = useFamTenantAudit(tenantId, page, limit)
  const rows = audit.data?.data ?? []
  const total = audit.data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))

  if (audit.isLoading) return <CenteredSpinner label="Loading audit log…" />
  if (rows.length === 0) {
    return <EmptyCard icon={<Icon.info size={22} />} message="No audit events for this tenant yet." />
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <table className="tbl" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Action</th>
            <th>Actor</th>
            <th>Metadata</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Pill tone="purple" dot>
                  {r.action}
                </Pill>
              </td>
              <td>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{r.actor}</div>
                {r.actorEmail && (
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                    {r.actorEmail}
                  </div>
                )}
              </td>
              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', wordBreak: 'break-word', maxWidth: 380 }}>
                {r.metadata ? JSON.stringify(r.metadata) : '—'}
              </td>
              <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                {timeAgo(r.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderTop: '1px solid var(--bord)',
            background: 'var(--surf-0)',
          }}
        >
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
            Page {page} of {totalPages} · {total} events
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn kind="ghost" size="sm" icon={<Icon.chevL size={12} />} disabled={page <= 1 || audit.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Prev
            </Btn>
            <Btn kind="ghost" size="sm" iconRight={<Icon.chevR size={12} />} disabled={page >= totalPages || audit.isFetching} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next
            </Btn>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Settings tab ────────────────────────────────────────────────────────────

function SettingsTab({
  tenantId,
  tenant,
}: {
  tenantId: string
  tenant: NonNullable<ReturnType<typeof useFamTenant>['data']>
}) {
  const { toast } = useToast()
  const suspendMut = useSuspendTenant()
  const reactivateMut = useReactivateTenant()
  const extendMut = useExtendTrial()
  const verifyMut = useVerifyTenant()

  const [suspendOpen, setSuspendOpen] = useState(false)
  const [extendOpen, setExtendOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [days, setDays] = useState(14)
  const [extendReason, setExtendReason] = useState('')

  const isSuspended = tenant.status === 'suspended'

  const submitSuspend = async () => {
    if (!reason.trim()) {
      toast({ title: 'Reason required', variant: 'destructive' })
      return
    }
    try {
      await suspendMut.mutateAsync({ id: tenantId, reason: reason.trim() })
      toast({ title: 'Tenant suspended', description: `${tenant.name} is now suspended.` })
      setSuspendOpen(false)
      setReason('')
    } catch (e) {
      toast({ title: 'Could not suspend', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }
  const submitReactivate = async () => {
    try {
      await reactivateMut.mutateAsync(tenantId)
      toast({ title: 'Tenant reactivated', description: `${tenant.name} is back to active.` })
    } catch (e) {
      toast({ title: 'Could not reactivate', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }
  const submitExtend = async () => {
    if (!days || days < 1 || days > 180) {
      toast({ title: 'Pick 1–180 days', variant: 'destructive' })
      return
    }
    try {
      await extendMut.mutateAsync({ id: tenantId, days, reason: extendReason.trim() || undefined })
      toast({ title: 'Trial extended', description: `${tenant.name} trial extended by ${days} days.` })
      setExtendOpen(false)
      setExtendReason('')
    } catch (e) {
      toast({ title: 'Could not extend trial', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }
  const submitVerify = async () => {
    try {
      await verifyMut.mutateAsync(tenantId)
      toast({ title: 'Verified', description: `${tenant.name} is now verified.` })
    } catch (e) {
      toast({ title: 'Could not verify', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }

  return (
    <>
      <div style={{ display: 'grid', gap: 14 }}>
        <SettingsCard
          title="Trial runway"
          desc={
            tenant.trialEndsAt
              ? `Current trial ends ${formatDate(tenant.trialEndsAt)}.`
              : 'No trial currently active for this tenant.'
          }
          action={
            <Btn kind="primary" size="sm" icon={<Icon.warn size={13} />} onClick={() => setExtendOpen(true)}>
              Extend trial
            </Btn>
          }
        />

        <SettingsCard
          title={isSuspended ? 'Lift suspension' : 'Suspend workspace'}
          desc={
            isSuspended
              ? 'This tenant is currently suspended. Lifting the suspension flips them back to active and unblocks logins.'
              : 'Suspending freezes all customer logins and writes a platform audit entry. Reversible.'
          }
          action={
            isSuspended ? (
              <Btn kind="primary" size="sm" icon={<Icon.check size={13} />} onClick={submitReactivate} disabled={reactivateMut.isPending}>
                {reactivateMut.isPending ? 'Reactivating…' : 'Reactivate'}
              </Btn>
            ) : (
              <Btn kind="danger" size="sm" icon={<Icon.shield size={13} />} onClick={() => setSuspendOpen(true)}>
                Suspend
              </Btn>
            )
          }
        />

        <SettingsCard
          title="Verification"
          desc={
            tenant.verifiedAt
              ? `Verified ${formatDate(tenant.verifiedAt)}. Cannot be undone from this surface.`
              : `GST + PAN not yet verified. ${
                  tenant.gstin || tenant.industry
                    ? 'Onboarding details look complete — review and mark as verified.'
                    : 'Workspace has not submitted onboarding details yet.'
                }`
          }
          action={
            tenant.verifiedAt ? (
              <Link href="/fam/verify" style={{ textDecoration: 'none' }}>
                <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                  Open verification queue
                </Btn>
              </Link>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <Link href="/fam/verify" style={{ textDecoration: 'none' }}>
                  <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                    Queue
                  </Btn>
                </Link>
                <Btn
                  kind="primary"
                  size="sm"
                  icon={<Icon.check size={13} />}
                  onClick={submitVerify}
                  disabled={verifyMut.isPending}
                >
                  {verifyMut.isPending ? 'Verifying…' : 'Verify now'}
                </Btn>
              </div>
            )
          }
        />
      </div>

      <Dialog open={suspendOpen} onOpenChange={setSuspendOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Suspend {tenant.name}</DialogTitle>
          </DialogHeader>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12 }}>
            All logins for this workspace will be blocked. The action is recorded in the platform audit log.
          </p>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>
            Reason <span style={{ color: 'var(--coral)' }}>*</span>
          </label>
          <textarea
            className="input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this tenant being suspended?"
            maxLength={500}
            style={{ width: '100%', padding: 10, fontSize: 12.5 }}
            autoFocus
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Btn kind="ghost" onClick={() => setSuspendOpen(false)} disabled={suspendMut.isPending}>
              Cancel
            </Btn>
            <Btn kind="danger" onClick={submitSuspend} disabled={suspendMut.isPending}>
              {suspendMut.isPending ? 'Suspending…' : 'Suspend tenant'}
            </Btn>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={extendOpen} onOpenChange={setExtendOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Extend trial for {tenant.name}</DialogTitle>
          </DialogHeader>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12 }}>
            Adds N days to the existing trial end date (or starts the trial today if none is set). Both tenants.trial_ends_at and subscriptions.current_period_end slide forward.
          </p>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>
            Days (1–180)
          </label>
          <input
            className="input"
            type="number"
            min={1}
            max={180}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ width: 120, padding: 10, fontSize: 13, marginBottom: 12 }}
          />
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>
            Reason (optional)
          </label>
          <textarea
            className="input"
            rows={3}
            value={extendReason}
            onChange={(e) => setExtendReason(e.target.value)}
            placeholder="e.g. Onboarding goodwill, finalising contract"
            maxLength={500}
            style={{ width: '100%', padding: 10, fontSize: 12.5 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Btn kind="ghost" onClick={() => setExtendOpen(false)} disabled={extendMut.isPending}>
              Cancel
            </Btn>
            <Btn kind="primary" onClick={submitExtend} disabled={extendMut.isPending}>
              {extendMut.isPending ? 'Extending…' : `Extend by ${days} days`}
            </Btn>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function SettingsCard({
  title,
  desc,
  action,
}: {
  title: string
  desc: string
  action: React.ReactNode
}) {
  return (
    <div
      className="card"
      style={{
        padding: 20,
        display: 'flex',
        gap: 16,
        alignItems: 'center',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 800 }}>{title}</div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginTop: 4, lineHeight: 1.5 }}>
          {desc}
        </div>
      </div>
      {action}
    </div>
  )
}

function CenteredSpinner({ label }: { label: string }) {
  return (
    <div
      className="card"
      style={{
        padding: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'var(--text-mute)',
      }}
    >
      <Loader2 className="w-4 h-4 animate-spin" /> {label}
    </div>
  )
}

function EmptyCard({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div
      className="card"
      style={{
        padding: 48,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {icon}
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)' }}>{message}</div>
    </div>
  )
}
