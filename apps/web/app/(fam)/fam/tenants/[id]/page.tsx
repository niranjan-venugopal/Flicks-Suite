'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
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
  type FamTenantMember,
} from '@/lib/api/queries/use-fam'
import { formatCurrency, formatDate, timeAgo } from '@/lib/utils'

type TabKey = 'overview' | 'members' | 'usage' | 'billing' | 'audit' | 'settings'

const TABS: Array<{ key: TabKey; label: string; sprint?: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'members',  label: 'Members' },
  { key: 'usage',    label: 'Usage',    sprint: 'C4' },
  { key: 'billing',  label: 'Billing',  sprint: 'C4' },
  { key: 'audit',    label: 'Audit',    sprint: 'C4' },
  { key: 'settings', label: 'Settings', sprint: 'C4' },
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
        {/* Breadcrumb */}
        <div style={{ marginBottom: 12 }}>
          <Link
            href="/fam/tenants"
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: 'var(--text-mute)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Icon.chevL size={12} /> Tenants
          </Link>
        </div>

        {/* Header card */}
        <div
          className="card"
          style={{
            padding: '18px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            marginBottom: 18,
          }}
        >
          <Avatar name={t.name} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }}>
                {t.name}
              </h1>
              <Pill tone={statusTone(t.status)} dot>
                {t.status.replace('_', ' ')}
              </Pill>
              {t.health?.signal && (
                <Pill tone={signalTone(t.health.signal)} dot>
                  {t.health.signal.replace('_', ' ')}
                </Pill>
              )}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text-mute)',
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <span>{t.slug}</span>
              {t.industry && <span>· {t.industry}</span>}
              {t.sizeBand && <span>· {t.sizeBand} employees</span>}
              {t.city && (
                <span>
                  · {t.city}
                  {t.stateCode ? `, ${t.stateCode}` : ''}
                </span>
              )}
              <span>· Joined {timeAgo(t.createdAt)}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn kind="secondary" size="sm" icon={<Icon.warn size={13} />} disabled>
              Extend trial
            </Btn>
            <Btn kind="ghost" size="sm" icon={<Icon.shield size={13} />} disabled>
              Suspend
            </Btn>
          </div>
        </div>

        {/* Tab strip */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            borderBottom: '1px solid var(--bord)',
            marginBottom: 18,
          }}
        >
          {TABS.map((t) => {
            const active = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                style={{
                  background: 'transparent',
                  border: 0,
                  padding: '10px 14px',
                  fontSize: 12.5,
                  fontWeight: active ? 800 : 700,
                  color: active ? '#fff' : 'var(--text-mute)',
                  borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
                  marginBottom: -1,
                  cursor: 'pointer',
                  letterSpacing: '-0.01em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {t.label}
                {t.sprint && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 800,
                      padding: '1px 5px',
                      borderRadius: 4,
                      background: 'var(--surf-2)',
                      color: 'var(--text-faint)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {t.sprint}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {tab === 'overview' && <OverviewTab tenant={t} />}
        {tab === 'members'  && id && <MembersTab tenantId={id} />}
        {tab !== 'overview' && tab !== 'members' && (
          <ComingSoon tab={tab} />
        )}
      </div>
    </div>
  )
}

// ─── Overview tab ───────────────────────────────────────────────────────────

function OverviewTab({ tenant }: { tenant: NonNullable<ReturnType<typeof useFamTenant>['data']> }) {
  const t = tenant
  const usersForKpi = t.subscription?.userCount ?? t.employeeCount
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

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', marginBottom: 14 }}>
            Workspace details
          </div>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 10, columnGap: 14, fontSize: 12.5 }}>
            <DetailRow k="Legal name" v={t.legalName ?? '—'} />
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
  const members = useFamTenantMembers(tenantId)
  const rows: FamTenantMember[] = members.data?.data ?? []

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
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <table className="tbl" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Status</th>
            <th>Invited</th>
            <th>Accepted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Placeholder tabs (Usage / Billing / Audit / Settings) ──────────────────

function ComingSoon({ tab }: { tab: TabKey }) {
  return (
    <div
      className="card"
      style={{
        padding: 48,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Icon.warn size={22} style={{ opacity: 0.6 }} />
      <div style={{ fontSize: 13, fontWeight: 800 }}>{capitalize(tab)} wires up in C4</div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-mute)',
          maxWidth: 420,
          lineHeight: 1.5,
        }}
      >
        The {tab} tab will hydrate from the existing /api/v1/fam/*
        endpoints in the next FAM commit (Sprint 3 · C4).
      </div>
    </div>
  )
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
