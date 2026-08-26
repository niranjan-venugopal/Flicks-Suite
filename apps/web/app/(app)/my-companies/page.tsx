'use client'

import { Loader2 } from 'lucide-react'
import { Icon, Pill, avBg, initials } from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useMyCompanies, useSwitchCompany } from '@/lib/api/queries/use-members'
import { daysToGstr1 } from '@/components/invoicing/CompanySwitcher'

/**
 * My Companies (PRD §3.4) — prototype ScrMyCompanies. The auditor's
 * cross-company landing surface: every linked company as a switch-in row with
 * overdue / GSTR-1 / outstanding pills. Switching into a pending invite
 * accepts it (the API activates the membership on switch).
 */
export default function MyCompaniesPage() {
  const { currentUser } = useAuthStore()
  const companies = useMyCompanies(!!currentUser)
  const switchCompany = useSwitchCompany()
  const linked = companies.data?.data ?? []

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: 'rgba(155,123,250,.16)',
            color: 'var(--purple)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon.shield size={22} />
        </div>
        <div>
          <div className="t-h1">My companies</div>
          <div className="t-mute">
            {linked.length} linked {linked.length === 1 ? 'company' : 'companies'} · one login ·
            switch into one at a time
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '11px 14px',
          borderRadius: 10,
          margin: '18px 0',
          background: 'rgba(155,123,250,.08)',
          border: '1px solid rgba(155,123,250,.25)',
        }}
      >
        <Icon.info size={15} style={{ color: 'var(--purple)', flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>
          Each company is a separate workspace. There is no cross-company roll-up — selecting one
          enters its scoped workspace with exactly your granted access.
        </span>
      </div>

      {companies.isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--text-mute)' }} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {linked.map((c) => {
            const active = c.tenantId === currentUser?.tenantId
            const outstanding = Number(c.stats.outstanding)
            const gstr1Days = daysToGstr1()
            return (
              <button
                key={c.tenantId}
                type="button"
                disabled={switchCompany.isPending}
                onClick={() => {
                  if (!active)
                    switchCompany.mutate({
                      tenantId: c.tenantId,
                      // Land where the role held IN THAT company makes sense.
                      redirectTo:
                        c.role === 'guest'
                          ? '/pm/projects'
                          : c.role === 'auditor'
                            ? '/invoicing'
                            : '/dashboard',
                    })
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: '18px 20px',
                  borderRadius: 14,
                  background: 'var(--surf-1)',
                  border: '1px solid var(--bord)',
                  cursor: active ? 'default' : 'pointer',
                  textAlign: 'left',
                  transition: 'all .15s',
                }}
                onMouseEnter={(e) => {
                  if (active) return
                  e.currentTarget.style.background = 'var(--surf-2)'
                  e.currentTarget.style.borderColor = 'var(--bord-2)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--surf-1)'
                  e.currentTarget.style.borderColor = 'var(--bord)'
                }}
              >
                <div className="avatar lg" style={{ background: avBg(c.name) }}>
                  {initials(c.name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 3 }}>
                    {c.name}
                    {active && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--blue)', fontWeight: 800 }}>
                        Current
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: 'var(--text-mute)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {c.gstin ? `GSTIN ${c.gstin}` : 'GSTIN not set'}
                    {c.city ? ` · ${c.city}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {c.status === 'invited' && <Pill tone="yellow" dot>Invite pending</Pill>}
                  {c.stats.overdueCount > 0 && (
                    <Pill tone="coral" dot>{c.stats.overdueCount} overdue</Pill>
                  )}
                  <Pill tone={gstr1Days <= 7 ? 'yellow' : ''} dot={gstr1Days <= 7}>
                    GSTR-1 in {gstr1Days}d
                  </Pill>
                  {outstanding > 0 && (
                    <Pill tone="blue">
                      {new Intl.NumberFormat('en-IN', {
                        style: 'currency',
                        currency: 'INR',
                        maximumFractionDigits: 0,
                      }).format(outstanding)}{' '}
                      due
                    </Pill>
                  )}
                </div>
                <Icon.chevR size={18} style={{ color: 'var(--text-faint)' }} />
              </button>
            )
          })}
          {companies.data?.canCreateWorkspace ? (
            <button
              type="button"
              onClick={() => (window.location.href = '/onboarding')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '14px',
                borderRadius: 14,
                background: 'transparent',
                border: '1px dashed var(--bord-2)',
                color: 'var(--blue)',
                fontSize: 12.5,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              <Icon.plus size={14} /> Create your own workspace →
            </button>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '14px',
                borderRadius: 14,
                background: 'transparent',
                border: '1px dashed var(--bord-2)',
                color: 'var(--text-mute)',
                fontSize: 12.5,
                fontWeight: 800,
              }}
            >
              <Icon.info size={14} /> New links appear here when a company invites you
            </div>
          )}
        </div>
      )}
    </div>
  )
}
