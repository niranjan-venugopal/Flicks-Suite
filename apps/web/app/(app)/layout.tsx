'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner'
import { ConsentLedgerSync } from '@/components/consent/ConsentLedgerSync'
import { ReacceptanceGate } from '@/components/consent/ReacceptanceGate'
import { PresenceProvider } from '@/lib/presence/PresenceProvider'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCurrentUser } from '@/lib/api/queries/use-auth'
import { useSwitchCompany } from '@/lib/api/queries/use-members'
import { useEmployeeOnboardingStatus } from '@/lib/api/queries/use-employee-onboarding'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { isAuthenticated, currentUser } = useAuthStore()
  const me = useCurrentUser()
  const { isLoading, isError, data: meData } = me

  // Employees who haven't finished self-onboarding go to the wizard. Owners
  // and HR Admins skip this check — they're managing the workspace, not
  // joining it. Tracked in employees.custom_fields.onboarding_step.
  //
  // Use the FRESH /me role for routing decisions (currentMembership.role),
  // not the persisted auth-store snapshot. The store has the previous
  // session's value on first paint and would mis-route the user for one
  // tick otherwise.
  const freshRole =
    (meData?.currentMembership?.role ?? meData?.memberships?.[0]?.role ?? '').toLowerCase()
  // Specflicks platform admins (role='fam') live entirely under /fam/*.
  // They land in (app) only when they hit the post-verify default —
  // bounce them out so they never see the customer dashboard. The legacy
  // 'super_admin' enum value is accepted as an alias until all rows are
  // migrated by 0004_role_fam.sql.
  //
  // EXCEPT when impersonating: the JWT carries impersonatorUserId, /me
  // returns the target user (role=employee/manager/owner) — we want them
  // to stay inside (app) so the FAM admin can see what the customer
  // sees. The ImpersonationBanner identifies the session as a Specflicks
  // staff impersonation.
  const isImpersonating = !!meData?.impersonatorUserId
  const isPlatformAdmin =
    !isImpersonating && (freshRole === 'fam' || freshRole === 'super_admin')
  const isJoiningEmployee =
    freshRole === 'employee' || freshRole === 'manager'
  const onboarding = useEmployeeOnboardingStatus()
  const needsOnboarding =
    isJoiningEmployee &&
    onboarding.data &&
    !onboarding.data.submittedForReview &&
    onboarding.data.employeeId !== null

  // ─── Revoked-current-tenant recovery (Invoicing v3 auditors) ──────────────
  // If the session is still scoped to a tenant the user no longer has ACTIVE
  // access to (e.g. an auditor whose current company just revoked them), the
  // JWT keeps pointing at the dead tenant and every screen shows it. Detect
  // that and recover: silently switch into the sole remaining active company,
  // or send them to My Companies to choose when there are several / none.
  const switchCompany = useSwitchCompany()
  const recoveryFired = useRef(false)
  const currentMembership = meData?.currentMembership ?? null
  const activeMemberships = (meData?.memberships ?? []).filter(
    (m) => m.status === 'active',
  )
  // Only meaningful once /me has resolved; impersonation + platform admins +
  // joining employees are handled by their own redirects below.
  const currentTenantRevoked =
    !!meData &&
    !isImpersonating &&
    !isPlatformAdmin &&
    (!currentMembership || currentMembership.status !== 'active')

  useEffect(() => {
    if (!isLoading && (isError || !isAuthenticated)) {
      router.replace('/login')
      return
    }
    if (isPlatformAdmin) {
      router.replace('/fam/overview')
      return
    }
    if (needsOnboarding) {
      router.replace('/onboarding/employee')
      return
    }
    // Recover from a revoked/expired current tenant exactly once per load.
    if (currentTenantRevoked && !recoveryFired.current) {
      recoveryFired.current = true
      const soleActive = activeMemberships.length === 1 ? activeMemberships[0] : null
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (soleActive && uuid.test(soleActive.tenantId ?? '')) {
        // Re-scope the JWT into the only company they can still use.
        switchCompany.mutate({
          tenantId: soleActive.tenantId,
          redirectTo: freshRole === 'auditor' ? '/invoicing' : '/dashboard',
        })
      } else {
        // None left, several to choose from, or a membership without a usable
        // tenant id → let them pick / see the empty state rather than auto-
        // firing a switch that can't succeed.
        router.replace('/my-companies')
      }
    }
  }, [
    isLoading,
    isError,
    isAuthenticated,
    isPlatformAdmin,
    needsOnboarding,
    currentTenantRevoked,
    activeMemberships,
    freshRole,
    switchCompany,
    router,
  ])

  // Don't render the app shell until /me has resolved. Otherwise the
  // persisted Zustand store re-hydrates with the PREVIOUS session's role
  // and the dashboard / sidebar / topbar render the wrong navigation
  // for ~half a second before the fresh data lands. Showing a centered
  // spinner is better UX than flashing the wrong UI.
  // Render the app shell ONLY when we're fully authenticated with fresh /me
  // data. Showing a spinner in every other state (loading, logged out, error)
  // means a logout never flashes the dashboard with cleared data before the
  // redirect lands.
  if (!isAuthenticated || isLoading || !meData) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-brand-bg">
        <Loader2 className="w-7 h-7 animate-spin text-brand-muted" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-brand-bg">
      {isImpersonating && (
        <ImpersonationBanner
          targetEmail={meData?.email ?? null}
          endsAt={meData?.impersonation?.endsAt ?? null}
          impersonatorEmail={meData?.impersonation?.impersonatorEmail ?? null}
        />
      )}
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <Topbar />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
      {/* PRD v4 §3: ledger the pre-login banner choice once; re-acceptance on policy bumps */}
      <ConsentLedgerSync />
      <ReacceptanceGate />
      {/* PRD v4 §5: live presence socket (heartbeats + status_changed) */}
      <PresenceProvider />
    </div>
  )
}
