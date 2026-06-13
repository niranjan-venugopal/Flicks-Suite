'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useMyCompanies, useSwitchCompany } from '@/lib/api/queries/use-members'
import { Icon, avBg, initials } from '@/components/proto'

/**
 * Company switcher (PRD §3.4/§3.5) — prototype shell-v3 CompanySwitcher.
 *
 * Lists the signed-in user's linked companies (GET /me/companies) and switches
 * the active tenant by re-issuing the JWT (POST /auth/switch-company). The
 * dropdown only arms when the user has more than one company; single-company
 * users get the same static workspace chip as before. Auditors additionally
 * get the "View all companies" footer → /my-companies.
 */
export function CompanySwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { currentUser, currentTenant } = useAuthStore()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const companies = useMyCompanies(!!currentUser)
  const switchCompany = useSwitchCompany()

  const isAuditor = currentUser?.role === 'AUDITOR'
  const linked = companies.data?.data ?? []
  // Allow the dropdown whenever there's a company to switch INTO — i.e. more
  // than one linked company, OR a single linked company that isn't the one the
  // session is currently scoped to (the revoked-current-tenant case, where the
  // active tenant has dropped out of `linked` entirely).
  const canSwitch =
    linked.length > 1 ||
    (linked.length === 1 && linked[0]!.tenantId !== currentUser?.tenantId)
  const landingPath = isAuditor ? '/invoicing' : '/dashboard'
  const tenantName = currentTenant?.name ?? 'Workspace'
  const subtitle = isAuditor
    ? `Auditor · ${linked.length || 1} ${linked.length === 1 ? 'company' : 'companies'}`
    : (currentTenant?.plan ?? 'free')

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (collapsed) {
    return (
      <div style={{ padding: '10px 0 0', display: 'flex', justifyContent: 'center' }}>
        <div className="avatar sm" style={{ background: avBg(tenantName) }} title={tenantName}>
          {initials(tenantName)}
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} style={{ padding: '12px 12px 0', position: 'relative' }}>
      <button
        type="button"
        onClick={() => canSwitch && setOpen((o) => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 11px',
          borderRadius: 10,
          background: 'var(--surf-1)',
          border: '1px solid var(--bord)',
          cursor: canSwitch ? 'pointer' : 'default',
        }}
      >
        <div className="avatar sm" style={{ background: avBg(tenantName) }}>
          {initials(tenantName)}
        </div>
        <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 800,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tenantName}
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
            {subtitle}
          </div>
        </div>
        {canSwitch && (
          <Icon.chevD
            size={14}
            style={{
              color: 'var(--text-mute)',
              transform: open ? 'rotate(180deg)' : 'none',
              transition: 'transform .15s',
            }}
          />
        )}
      </button>

      {open && canSwitch && (
        <div
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            top: 'calc(100% + 4px)',
            zIndex: 120,
            background: 'rgba(18,18,30,.98)',
            backdropFilter: 'blur(16px)',
            border: '1px solid var(--bord-2)',
            borderRadius: 12,
            padding: 6,
            boxShadow: '0 24px 60px rgba(0,0,0,.6)',
          }}
        >
          <div className="t-caption" style={{ padding: '6px 8px 4px' }}>
            {isAuditor ? 'My companies' : 'Switch company'}
          </div>
          {linked.map((c) => {
            const active = c.tenantId === currentUser?.tenantId
            const sub = [
              c.stats.overdueCount > 0 ? `${c.stats.overdueCount} overdue` : null,
              `GSTR-1 in ${daysToGstr1()}d`,
              c.status === 'invited' ? 'invite pending' : null,
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <button
                key={c.tenantId}
                type="button"
                disabled={switchCompany.isPending}
                onClick={() => {
                  setOpen(false)
                  if (!active) switchCompany.mutate({ tenantId: c.tenantId, redirectTo: landingPath })
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '8px 8px',
                  borderRadius: 8,
                  background: active ? 'var(--surf-2)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  marginBottom: 1,
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = 'var(--surf-1)'
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent'
                }}
              >
                <div className="avatar sm" style={{ background: avBg(c.name) }}>
                  {initials(c.name)}
                </div>
                <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      color: '#fff',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {c.name}
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-mute)' }}>
                    {sub}
                  </div>
                </div>
                {active && <Icon.check size={14} style={{ color: 'var(--blue)' }} />}
              </button>
            )
          })}
          {isAuditor && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                router.push('/my-companies')
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px',
                borderRadius: 8,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-2)',
                marginTop: 2,
                borderTop: '1px solid var(--bord)',
              }}
            >
              <Icon.grid size={14} />
              <span style={{ fontSize: 11.5, fontWeight: 700 }}>View all companies</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Days until the next GSTR-1 due date (the 11th of the following month). */
export function daysToGstr1(now = new Date()): number {
  const due = new Date(now.getFullYear(), now.getMonth() + (now.getDate() > 11 ? 1 : 0), 11)
  if (due.getTime() <= now.getTime()) due.setMonth(due.getMonth() + 1)
  return Math.max(0, Math.ceil((due.getTime() - now.getTime()) / 86_400_000))
}
