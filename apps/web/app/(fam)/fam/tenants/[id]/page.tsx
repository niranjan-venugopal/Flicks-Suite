'use client'

import { Fragment, Suspense, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
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
  useGrantFreeMonths,
  useFamTenantActivity,
  downloadTenantActivityCsv,
  useResendMemberInvite,
  useSignOutMember,
  useFamTenantNotes,
  useAddTenantNote,
  useUpdateTenantNote,
  useDeleteTenantNote,
  type FamTenantMember,
  type TenantActivityFilters,
} from '@/lib/api/queries/use-fam'
import { ImpersonateModal } from '@/components/fam/ImpersonateModal'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { formatCurrency, formatDate, timeAgo } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

type TabKey = 'overview' | 'members' | 'support' | 'usage' | 'billing' | 'audit' | 'settings'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'members',  label: 'Members' },
  { key: 'support',  label: 'Support' },
  { key: 'usage',    label: 'Usage' },
  { key: 'billing',  label: 'Billing' },
  { key: 'audit',    label: 'Audit' },
  { key: 'settings', label: 'Settings' },
]
const TAB_KEYS = new Set<string>(TABS.map((t) => t.key))

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
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <FamTenantDetailInner />
    </Suspense>
  )
}

function FamTenantDetailInner() {
  const params = useParams<{ id: string }>()
  const id = params?.id ?? null
  const tenant = useFamTenant(id)
  const router = useRouter()
  const sp = useSearchParams()
  // Round R R2: ?tab= so search results, audit rows and emails can deep-link
  // straight to Support / Billing.
  const wanted = sp.get('tab')
  const [tab, setTabState] = useState<TabKey>(wanted && TAB_KEYS.has(wanted) ? (wanted as TabKey) : 'overview')
  const setTab = (t: TabKey) => {
    setTabState(t)
    router.replace(`/fam/tenants/${id}?tab=${t}`, { scroll: false })
  }

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
            <Avatar name={t.name} size="lg" src={t.logoUrl ?? undefined} />
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
                <span>ID: {t.slug}</span>
                <span>·</span>
                <span>{t.gstin ? `GSTIN ${t.gstin}` : 'no GSTIN'}</span>
                <span>·</span>
                <span>Joined {timeAgo(t.createdAt)}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />} onClick={() => setTab('billing')}>
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
              background: 'var(--bg-2)',
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
                    color: active ? 'var(--text)' : 'var(--text-mute)',
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
        {tab === 'support'  && id && <SupportTab tenantId={id} />}
        {tab === 'usage'    && id && <UsageTab tenantId={id} currency={t.currency} />}
        {tab === 'billing'  && id && <BillingTab tenantId={id} currency={t.currency} tenant={t} />}
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

  const [dialog, setDialog] = useState<'verify' | 'extend' | 'suspend' | 'reactivate' | null>(null)
  const [suspendReason, setSuspendReason] = useState('')
  const close = () => setDialog(null)
  const err = (title: string) => (e: unknown) =>
    toast({ title, description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })

  const doVerify = () =>
    verifyMut.mutate({ id: t.id }, {
      onSuccess: () => { toast({ title: 'Tenant verified' }); close() },
      onError: err('Verify failed'),
    })
  const doExtend = () =>
    extendMut.mutate({ id: t.id, days: 14 }, {
      onSuccess: (r) => { toast({ title: 'Trial extended by 14 days', description: `New end: ${formatDate(r.trialEndsAt)}` }); close() },
      onError: err('Extend failed'),
    })
  const doReactivate = () =>
    reactivateMut.mutate(t.id, {
      onSuccess: () => { toast({ title: 'Tenant reactivated' }); close() },
      onError: err('Reactivate failed'),
    })
  const doSuspend = () => {
    if (!suspendReason.trim()) return
    suspendMut.mutate({ id: t.id, reason: suspendReason.trim() }, {
      onSuccess: () => { toast({ title: 'Tenant suspended' }); close() },
      onError: err('Suspend failed'),
    })
  }

  const quickActions: Array<{ label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }> = [
    ...(t.verifiedAt
      ? []
      : [{ label: 'Mark verified', icon: <Icon.shield size={13} />, onClick: () => setDialog('verify') }]),
    ...(t.status === 'trialing'
      ? [{ label: 'Extend trial · 14 days', icon: <Icon.cal size={13} />, onClick: () => setDialog('extend') }]
      : []),
    t.status === 'suspended'
      ? { label: 'Reactivate tenant', icon: <Icon.check size={13} />, onClick: () => setDialog('reactivate') }
      : { label: 'Suspend tenant', icon: <Icon.shield size={13} />, onClick: () => { setSuspendReason(''); setDialog('suspend') }, danger: true },
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
        const ringColor =
          signalTone(t.health.signal) === 'green' ? 'var(--green)'
          : signalTone(t.health.signal) === 'blue' ? 'var(--blue)'
          : signalTone(t.health.signal) === 'coral' ? 'var(--coral)'
          : signalTone(t.health.signal) === 'yellow' ? 'var(--yellow)'
          : 'var(--blue)'
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
                    cx="60" cy="60" r="50" fill="none" stroke={ringColor} strokeWidth="10"
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

      <Dialog open={dialog === 'suspend'} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Suspend {t.name}</DialogTitle>
          </DialogHeader>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12 }}>
            Everyone is signed out and nobody can sign in until it is lifted; the Owners are emailed the reason. Recorded in the platform audit log with your IP. Reversible.
          </p>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>
            Reason <span style={{ color: 'var(--coral)' }}>*</span>
          </label>
          <textarea
            className="input"
            rows={3}
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
            placeholder="Why is this tenant being suspended?"
            maxLength={500}
            style={{ width: '100%', padding: 10, fontSize: 12.5 }}
            autoFocus
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Btn kind="ghost" onClick={close} disabled={suspendMut.isPending}>Cancel</Btn>
            <Btn kind="danger" onClick={doSuspend} disabled={suspendMut.isPending || !suspendReason.trim()}>
              {suspendMut.isPending ? 'Suspending…' : 'Suspend tenant'}
            </Btn>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === 'verify' || dialog === 'extend' || dialog === 'reactivate'}
        onOpenChange={(o) => !o && close()}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog === 'verify' && `Mark ${t.name} verified`}
              {dialog === 'extend' && `Extend trial for ${t.name}`}
              {dialog === 'reactivate' && `Reactivate ${t.name}`}
            </DialogTitle>
          </DialogHeader>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 16 }}>
            {dialog === 'verify' && 'Records the verification on the platform audit log. This cannot be undone from this surface.'}
            {dialog === 'extend' && 'Adds 14 days from today or the current trial end, whichever is later — an expired trial comes back on. Recorded in the platform audit log.'}
            {dialog === 'reactivate' && 'Restores the status the suspension interrupted (a trial stays a trial) and lets everyone sign in again. Recorded in the platform audit log.'}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Btn kind="ghost" onClick={close} disabled={busy}>Cancel</Btn>
            <Btn
              kind="primary"
              onClick={dialog === 'verify' ? doVerify : dialog === 'extend' ? doExtend : doReactivate}
              disabled={busy}
            >
              {dialog === 'verify' && (verifyMut.isPending ? 'Verifying…' : 'Verify tenant')}
              {dialog === 'extend' && (extendMut.isPending ? 'Extending…' : 'Extend · 14 days')}
              {dialog === 'reactivate' && (reactivateMut.isPending ? 'Reactivating…' : 'Reactivate')}
            </Btn>
          </div>
        </DialogContent>
      </Dialog>
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
  const resendMut = useResendMemberInvite()
  const signOutMut = useSignOutMember()
  const [target, setTarget] = useState<FamTenantMember | null>(null)
  const [signOutTarget, setSignOutTarget] = useState<FamTenantMember | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
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

  // Round R R2 — support actions on a seat.
  const resend = (m: FamTenantMember) => {
    setBusyId(m.membershipId)
    resendMut.mutate(
      { tenantId, membershipId: m.membershipId },
      {
        onSuccess: (r) =>
          toast({
            title: r.data.emailSent ? 'Invite re-sent' : 'Invite recorded (email not sent)',
            description: `${r.data.email} · sent ${r.data.resentCount} time${r.data.resentCount === 1 ? '' : 's'}`,
          }),
        onError: (e) => toast({ title: 'Could not resend', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' }),
        onSettled: () => setBusyId(null),
      },
    )
  }
  const signOut = () => {
    if (!signOutTarget) return
    const m = signOutTarget
    signOutMut.mutate(
      { tenantId, membershipId: m.membershipId },
      {
        onSuccess: (r) => {
          setSignOutTarget(null)
          toast({ title: 'Signed out of this company', description: `${m.email ?? m.fullName} · ${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? '' : 's'} ended.` })
        },
        onError: (e) => toast({ title: 'Could not sign them out', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' }),
      },
    )
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
              <th>Last sign-in</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const canImpersonate = m.status === 'active' && m.role !== 'fam'
              const busy = busyId === m.membershipId
              return (
                <tr key={m.membershipId} data-testid="member-row">
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <Avatar name={m.fullName ?? m.email ?? '?'} size="sm" src={m.avatarUrl ?? undefined} />
                      <div>
                        <Link href={`/fam/users/${m.userId}`} style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', textDecoration: 'none' }}>
                          {m.fullName ?? '—'}
                        </Link>
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
                    {m.lastLoginAt ? timeAgo(m.lastLoginAt) : 'never'}
                  </td>
                  <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                    {m.acceptedAt ? timeAgo(m.acceptedAt) : m.invitedAt ? `invited ${timeAgo(m.invitedAt)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {m.status === 'invited' && m.employeeId && (
                      <Btn kind="ghost" size="sm" icon={<Icon.mail size={12} />} disabled={busy} onClick={() => resend(m)} data-testid="member-resend">
                        {busy ? 'Sending…' : 'Resend invite'}
                      </Btn>
                    )}
                    {m.status === 'active' && m.role !== 'fam' && (
                      <Btn kind="ghost" size="sm" icon={<Icon.out size={12} />} onClick={() => setSignOutTarget(m)} data-testid="member-sign-out">
                        Sign out
                      </Btn>
                    )}
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
      <ConfirmDialog
        open={!!signOutTarget}
        onClose={() => setSignOutTarget(null)}
        title={`Sign ${signOutTarget?.fullName ?? signOutTarget?.email ?? 'this member'} out of this company?`}
        body="Their sessions in this company are ended — a screen they still have open drops within 15 minutes, when its short-lived token expires. Their other companies keep working, and they can sign in again right away."
        confirmLabel="Sign out"
        danger
        loading={signOutMut.isPending}
        loadingLabel="Signing out…"
        onConfirm={signOut}
      />
    </>
  )
}

// ─── Support tab (Round R R2) ────────────────────────────────────────────────

function SupportTab({ tenantId }: { tenantId: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14, alignItems: 'start' }}>
      <ActivityLog tenantId={tenantId} />
      <SupportNotes tenantId={tenantId} />
    </div>
  )
}

const RESOURCE_TYPES = ['', 'employee', 'leave_request', 'attendance_regularization', 'timesheet_period', 'invoice', 'company_policy', 'asset', 'membership', 'user', 'rbac'] as const

function ActivityLog({ tenantId }: { tenantId: string }) {
  const { toast } = useToast()
  const [page, setPage] = useState(1)
  const [action, setAction] = useState('')
  const [resourceType, setResourceType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const limit = 25
  const filters = useMemo<TenantActivityFilters>(() => {
    const f: TenantActivityFilters = {}
    if (action.trim()) f.action = action.trim()
    if (resourceType) f.resourceType = resourceType
    if (from) f.from = new Date(`${from}T00:00:00`).toISOString()
    if (to) f.to = new Date(`${to}T23:59:59`).toISOString()
    return f
  }, [action, resourceType, from, to])
  const log = useFamTenantActivity(tenantId, page, limit, filters)
  const rows = log.data?.data ?? []
  const total = log.data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const exportCsv = async () => {
    setExporting(true)
    try {
      await downloadTenantActivityCsv(tenantId, filters)
    } catch (e) {
      toast({ title: 'Export failed', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }} data-testid="support-activity">
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>Company activity</div>
          <div className="t-mute" style={{ fontSize: 11.5 }}>The company's own audit log — exactly what its Owner sees · {total} entries</div>
        </div>
        <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />} onClick={() => void exportCsv()} disabled={exporting} data-testid="activity-export">
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Btn>
      </div>
      <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--bord)', background: 'var(--bg-2)', display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr', gap: 8 }}>
        <input className="input" placeholder="Action, e.g. employee.terminated" value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }} data-testid="activity-action" />
        <select className="input" value={resourceType} onChange={(e) => { setResourceType(e.target.value); setPage(1) }}>
          {RESOURCE_TYPES.map((r) => <option key={r} value={r}>{r ? r.replace(/_/g, ' ') : 'Any record'}</option>)}
        </select>
        <input className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} aria-label="From" />
        <input className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} aria-label="To" />
      </div>
      {log.isLoading ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-mute)' }}><Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} /></div>
      ) : rows.length === 0 ? (
        <div className="t-mute" style={{ padding: 30, textAlign: 'center', fontSize: 12.5 }}>Nothing matches.</div>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>From</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr data-testid="activity-row">
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mute)', whiteSpace: 'nowrap' }} title={r.createdAt}>{timeAgo(r.createdAt)}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Avatar name={r.actorName ?? r.actorEmail ?? 'System'} size="sm" src={r.avatarUrl ?? undefined} />
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 800 }}>{r.actorName ?? 'System'}</div>
                        {r.actorEmail && <div style={{ fontSize: 10.5, color: 'var(--text-mute)' }}>{r.actorEmail}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 800, color: /deleted|terminated|rejected|revoked|denied/.test(r.action) ? 'var(--coral)' : 'var(--blue)' }}>{r.action}</td>
                  <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)' }}>{r.resourceType.replace(/_/g, ' ')}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-mute)' }} title={r.userAgent ?? undefined}>{r.ipAddress ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {(r.beforeState || r.afterState) && (
                      <Btn kind="ghost" size="sm" icon={<Icon.eye size={12} />} onClick={() => setOpen(open === r.id ? null : r.id)} aria-label="Show changes" />
                    )}
                  </td>
                </tr>
                {open === r.id && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--bg-2)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                        <div><div className="t-caption">Before</div><pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.beforeState ? JSON.stringify(r.beforeState, null, 2) : '—'}</pre></div>
                        <div><div className="t-caption">After</div><pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.afterState ? JSON.stringify(r.afterState, null, 2) : '—'}</pre></div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderTop: '1px solid var(--bord)', background: 'var(--bg-2)' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>Page {page} of {totalPages}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn kind="ghost" size="sm" icon={<Icon.chevL size={12} />} disabled={page <= 1 || log.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Btn>
            <Btn kind="ghost" size="sm" iconRight={<Icon.chevR size={12} />} disabled={page >= totalPages || log.isFetching} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

function SupportNotes({ tenantId }: { tenantId: string }) {
  const { toast } = useToast()
  const notes = useFamTenantNotes(tenantId)
  const add = useAddTenantNote()
  const update = useUpdateTenantNote()
  const del = useDeleteTenantNote()
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const rows = notes.data?.data ?? []
  const fail = (title: string) => (e: unknown) => toast({ title, description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })

  const submit = () => {
    if (!draft.trim()) return
    add.mutate({ tenantId, body: draft.trim() }, { onSuccess: () => setDraft(''), onError: fail('Could not add the note') })
  }

  return (
    <div className="card" style={{ padding: 18 }} data-testid="support-notes">
      <SectionHead title="Support notes" sub="Specflicks-only · never visible to the company" />
      <textarea
        className="input"
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="What did they ask, what did we do, what's pending…"
        maxLength={4000}
        style={{ width: '100%', padding: 10, fontSize: 12.5, marginTop: 10 }}
        data-testid="note-draft"
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={submit} disabled={!draft.trim() || add.isPending} data-testid="note-add">
          {add.isPending ? 'Saving…' : 'Add note'}
        </Btn>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
        {notes.isLoading ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-mute)' }}><Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} /></div>
        ) : rows.length === 0 ? (
          <div className="t-mute" style={{ padding: '14px 0', fontSize: 12.5 }}>No notes yet.</div>
        ) : rows.map((n, i) => (
          <div key={n.id} style={{ padding: '12px 0', borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none' }} data-testid="note-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              {n.pinned && <Pill tone="yellow" dot>pinned</Pill>}
              <span style={{ fontSize: 12, fontWeight: 800 }}>{n.author}</span>
              <span className="t-mute" style={{ fontSize: 11 }} title={n.createdAt}>· {timeAgo(n.createdAt)}</span>
              <div style={{ flex: 1 }} />
              <Btn kind="ghost" size="sm" icon={<Icon.flag size={12} />} aria-label={n.pinned ? 'Unpin' : 'Pin'} title={n.pinned ? 'Unpin' : 'Pin to top'} onClick={() => update.mutate({ tenantId, noteId: n.id, pinned: !n.pinned }, { onError: fail('Could not update') })} />
              <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} aria-label="Delete note" onClick={() => setDeleting(n.id)} />
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{n.body}</div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this note?"
        body="It disappears from the support tab; the deletion is recorded in the platform audit log."
        confirmLabel="Delete note"
        danger
        loading={del.isPending}
        loadingLabel="Deleting…"
        onConfirm={() => deleting && del.mutate({ tenantId, noteId: deleting }, { onSuccess: () => setDeleting(null), onError: fail('Could not delete') })}
      />
    </div>
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

function billingEventSub(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null
  const m = metadata
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : undefined)
  const num = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : undefined)
  const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1)
  const from = str('fromPlan') ?? str('from_plan') ?? str('previousPlan')
  const to = str('toPlan') ?? str('to_plan') ?? str('newPlan') ?? str('planCode') ?? str('plan')
  if (from && to) return `${cap(from)} → ${cap(to)}`
  if (to) return cap(to)
  const seats = num('seats') ?? num('seatsAdded') ?? num('seat_delta')
  if (seats != null) return `${seats > 0 ? '+' : ''}${seats} seats`
  const days = num('days')
  if (days != null) return `Trial · ${days} days`
  return null
}

function billingEventAmount(metadata: Record<string, unknown> | null, currency: string): string | null {
  if (!metadata) return null
  const mrr = typeof metadata.mrr === 'number' ? metadata.mrr : undefined
  return mrr != null ? `${formatCurrency(mrr, currency)} MRR` : null
}

function BillingTab({
  tenantId,
  currency,
  tenant,
}: {
  tenantId: string
  currency: string
  tenant: NonNullable<ReturnType<typeof useFamTenant>['data']>
}) {
  const { toast } = useToast()
  const billing = useFamTenantBilling(tenantId)
  const extendMut = useExtendTrial()
  const grantMut = useGrantFreeMonths()
  const [dialog, setDialog] = useState<'extend' | 'months' | null>(null)
  const [days, setDays] = useState(14)
  const [months, setMonths] = useState(1)
  const [reason, setReason] = useState('')
  const data = billing.data
  const fail = (title: string) => (e: unknown) =>
    toast({ title, description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })

  const submitExtend = () => {
    if (!days || days < 1 || days > 180) return
    extendMut.mutate(
      { id: tenantId, days, reason: reason.trim() || undefined },
      {
        onSuccess: (r) => {
          setDialog(null)
          setReason('')
          toast({ title: `Trial extended by ${days} days`, description: r.trialEndsAt ? `Now ends ${formatDate(r.trialEndsAt)}.` : undefined })
        },
        onError: fail('Could not extend the trial'),
      },
    )
  }
  const submitMonths = () => {
    if (!reason.trim()) return
    grantMut.mutate(
      { id: tenantId, months, reason: reason.trim() },
      {
        onSuccess: (r) => {
          setDialog(null)
          setReason('')
          toast({ title: `${months} free month${months === 1 ? '' : 's'} given`, description: `Coupon ${r.code} applied${r.trialEndsAt ? ` · trial now ends ${formatDate(r.trialEndsAt)}` : ''}. The Owners have been told.` })
        },
        onError: fail('Could not give free months'),
      },
    )
  }

  if (billing.isLoading) return <CenteredSpinner label="Loading billing…" />
  const s = data?.subscription ?? null
  const toolbar = (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
      <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />} onClick={() => { setReason(''); setDialog('extend') }} disabled={!!s?.razorpaySubscriptionId && s.status !== 'canceled'} title={s?.razorpaySubscriptionId && s.status !== 'canceled' ? 'Paying through Razorpay — its dates are decided there' : undefined} data-testid="billing-extend">
        Extend trial
      </Btn>
      <Btn kind="primary" size="sm" icon={<Icon.zap size={13} />} onClick={() => { setReason(''); setDialog('months') }} disabled={!!s?.razorpaySubscriptionId} title={s?.razorpaySubscriptionId ? 'Already paying through Razorpay — credit it there' : undefined} data-testid="billing-free-months">
        Give free months
      </Btn>
    </div>
  )

  return (
    <>
      {toolbar}
      {!s ? (
        <EmptyCard icon={<Icon.chart size={22} />} message="No subscription on file for this tenant — extending the trial creates one." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
          <div className="card" style={{ padding: 20 }} data-testid="billing-panel">
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>Subscription</div>
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '170px 1fr', rowGap: 10, columnGap: 14, fontSize: 12.5 }}>
              <DetailRow k="Plan"          v={<span style={{ textTransform: 'capitalize', fontWeight: 800 }}>{s.planCode}</span>} />
              <DetailRow k="Status"        v={<Pill tone={statusTone(s.status)} dot>{s.status.replace('_', ' ')}</Pill>} />
              <DetailRow k="Billing cycle" v={s.billingCycle} />
              <DetailRow k="Per seat"      v={formatCurrency(s.perUserPrice, currency)} />
              <DetailRow k="Billable seats" v={<span>{String(s.seats ?? s.userCount)}{s.monthlyEstimate != null && <span className="t-mute" style={{ fontWeight: 600 }}> · would be {formatCurrency(s.monthlyEstimate, currency)}/mo</span>}</span>} />
              <DetailRow k="MRR"           v={<span><strong style={{ fontFamily: 'var(--font-mono)' }}>{formatCurrency(s.mrr, currency)}</strong>{s.status !== 'active' && <span className="t-mute" style={{ fontWeight: 600 }}> · counts once paying</span>}</span>} />
              <DetailRow
                k="Current period"
                v={s.currentPeriodStart && s.currentPeriodEnd ? `${formatDate(s.currentPeriodStart)} → ${formatDate(s.currentPeriodEnd)}` : '—'}
              />
              <DetailRow k="Trial ends"     v={s.trialEndsAt ? formatDate(s.trialEndsAt) : '—'} />
              {s.graceEndsAt && <DetailRow k="Grace ends" v={formatDate(s.graceEndsAt)} />}
              <DetailRow k="Coupon"        v={s.coupon ? <span><span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{s.coupon.code}</span> <span className="t-mute" style={{ fontWeight: 600 }}>· {s.coupon.months} month{s.coupon.months === 1 ? '' : 's'} · {s.coupon.campaign} · {formatDate(s.coupon.redeemedAt)}</span></span> : '—'} />
              <DetailRow k="Razorpay sub"   v={s.razorpaySubscriptionId ?? '—'} />
              {s.cancelAtPeriodEnd && (
                <DetailRow k="" v={<span style={{ color: 'var(--coral)', fontWeight: 700 }}>Will cancel at period end</span>} />
              )}
            </dl>
          </div>

          <div className="card" style={{ padding: 20 }}>
            <SectionHead title="Plan history" sub={`${data!.events.length} event${data!.events.length === 1 ? '' : 's'}`} />
            {data!.events.length === 0 ? (
              <div style={{ padding: '20px 0', fontSize: 12, color: 'var(--text-mute)' }}>No subscription events yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {data!.events.map((e, i) => {
                  const sub = billingEventSub(e.metadata)
                  const amount = billingEventAmount(e.metadata, currency)
                  return (
                    <div key={e.id} style={{ display: 'flex', gap: 14, padding: '12px 0', borderBottom: i < data!.events.length - 1 ? '1px solid var(--bord)' : 'none', alignItems: 'flex-start' }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 800, color: 'var(--text-mute)', width: 92, paddingTop: 1, flexShrink: 0 }}>{formatDate(e.createdAt)}</div>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--blue)', marginTop: 5, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 2, textTransform: 'capitalize' }}>{e.eventType.replace(/[_.]/g, ' ')}</div>
                        {sub && <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>{sub}</div>}
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 12, color: amount ? 'var(--green)' : 'var(--text-faint)', flexShrink: 0 }}>{amount ?? '—'}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={dialog === 'extend'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Extend trial for {tenant.name}</DialogTitle></DialogHeader>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12 }}>
            Adds N days from today or the current trial end, whichever is later — an expired trial comes back on immediately.
            {tenant.trialEndsAt ? ` Current end: ${formatDate(tenant.trialEndsAt)}.` : ''}
          </p>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>Days (1–180)</label>
          <input className="input" type="number" min={1} max={180} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 120, padding: 10, fontSize: 13, marginBottom: 12 }} data-testid="extend-days" />
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>Reason (optional)</label>
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. finalising contract" maxLength={500} style={{ width: '100%', padding: 10, fontSize: 12.5 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Btn kind="ghost" onClick={() => setDialog(null)} disabled={extendMut.isPending}>Cancel</Btn>
            <Btn kind="primary" onClick={submitExtend} disabled={extendMut.isPending || !days || days < 1 || days > 180} data-testid="extend-confirm">
              {extendMut.isPending ? 'Extending…' : `Extend by ${days} days`}
            </Btn>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'months'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Give {tenant.name} free months</DialogTitle></DialogHeader>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12 }}>
            A private coupon is applied on the company's behalf: calendar months are added from today or the current trial end, whichever is later. The Owners get the usual "coupon applied" note; the grant is recorded in the plan history and the platform audit log.
          </p>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>Months</label>
          <select className="input" value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ width: 140, marginBottom: 12 }} data-testid="months-select">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m} month{m === 1 ? '' : 's'}</option>)}
          </select>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>Reason <span style={{ color: 'var(--coral)' }}>*</span></label>
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. lost invoice — founder goodwill" maxLength={500} style={{ width: '100%', padding: 10, fontSize: 12.5 }} data-testid="months-reason" />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Btn kind="ghost" onClick={() => setDialog(null)} disabled={grantMut.isPending}>Cancel</Btn>
            <Btn kind="primary" onClick={submitMonths} disabled={grantMut.isPending || !reason.trim()} data-testid="months-confirm">
              {grantMut.isPending ? 'Applying…' : `Give ${months} free month${months === 1 ? '' : 's'}`}
            </Btn>
          </div>
        </DialogContent>
      </Dialog>
    </>
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
            background: 'var(--bg-2)',
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
      await verifyMut.mutateAsync({ id: tenantId })
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
              ? 'This company is suspended: nobody can sign in. Lifting it restores the status the suspension interrupted (a trial stays a trial).'
              : 'Suspending signs everyone out, blocks every sign-in and emails the Owners the reason. Recorded in the platform audit log. Reversible.'
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
                <Link href={`/fam/verify?tenant=${tenant.id}`} style={{ textDecoration: 'none' }}>
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
            Everyone is signed out and nobody can sign in until it is lifted; the Owners are emailed the reason. Recorded in the platform audit log with your IP.
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
            Adds N days from today or the current trial end, whichever is later — an expired trial comes back on immediately. Recorded in the plan history and the platform audit log.
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
