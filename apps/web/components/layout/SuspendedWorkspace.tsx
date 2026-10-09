'use client'

import { Avatar, Btn, Icon, Pill } from '@/components/proto'
import { useLogout } from '@/lib/api/queries/use-auth'
import { useSwitchCompany } from '@/lib/api/queries/use-members'

/**
 * Round R R2 — the whole workspace is suspended by Specflicks. Every tenant
 * route answers 403 TENANT_SUSPENDED, so instead of a page of failed calls
 * the person sees why, can switch to another company they belong to, or
 * sign out. Nothing else of the shell is mounted.
 */
export function SuspendedWorkspace({
  tenantName,
  tenantLogoUrl,
  others,
}: {
  tenantName: string
  tenantLogoUrl?: string | null
  others: Array<{ tenantId: string; tenantName: string }>
}) {
  const logout = useLogout()
  const switchCompany = useSwitchCompany()
  return (
    <div
      className="bg-brand-bg"
      style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      data-testid="workspace-suspended"
    >
      <div className="card" style={{ width: 'min(520px, 100%)', padding: 28, textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <Avatar name={tenantName} size="xl" src={tenantLogoUrl ?? undefined} />
        </div>
        <Pill tone="coral" dot>Suspended</Pill>
        <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', margin: '12px 0 8px' }}>
          {tenantName} is suspended
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6, margin: 0 }}>
          Specflicks has suspended this workspace, so nobody in the company can use it right now. Your data is
          untouched. Please contact support — your Owner has been emailed the reason.
        </p>
        {others.length > 0 && (
          <div style={{ marginTop: 22, textAlign: 'left' }}>
            <div className="t-caption" style={{ marginBottom: 8 }}>Your other companies</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {others.map((o) => (
                <Btn
                  key={o.tenantId}
                  kind="secondary"
                  icon={<Icon.building size={14} />}
                  onClick={() => switchCompany.mutate({ tenantId: o.tenantId, redirectTo: '/dashboard' })}
                  disabled={switchCompany.isPending}
                >
                  Switch to {o.tenantName}
                </Btn>
              ))}
            </div>
          </div>
        )}
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'center', gap: 8 }}>
          <Btn kind="ghost" icon={<Icon.out size={14} />} onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </Btn>
        </div>
      </div>
    </div>
  )
}
