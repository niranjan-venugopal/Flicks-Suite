'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Skeleton } from '@/components/proto'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner'
import { ConsentLedgerSync } from '@/components/consent/ConsentLedgerSync'
import { ReacceptanceGate } from '@/components/consent/ReacceptanceGate'
import { PresenceProvider } from '@/lib/presence/PresenceProvider'
import { NotificationsSocket } from '@/lib/notifications/NotificationsSocket'
import { ModuleOpenedTracker } from '@/lib/analytics/ModuleOpenedTracker'
import { FeedbackPanel } from '@/components/feedback/FeedbackPanel'
import { NpsCard } from '@/components/feedback/NpsCard'
import { BillingBanners, BillingWall } from '@/components/billing/BillingGate'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCurrentUser } from '@/lib/api/queries/use-auth'
import { useSwitchCompany } from '@/lib/api/queries/use-members'
import { useEmployeeOnboardingStatus } from '@/lib/api/queries/use-employee-onboarding'

/**
 * Skeleton shell shown while /me resolves (perceived-performance pass,
 * 2026-07-06). Paints the sidebar/topbar/content silhouette instantly instead
 * of a blank screen with a spinner.
 */
function AppShellSkeleton() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-brand-bg">
      {/* Sidebar silhouette */}
      <div
        style={{
          width: 252,
          flexShrink: 0,
          borderRight: '1px solid var(--bord)',
          padding: '18px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Skeleton w={34} h={34} r="50%" />
          <Skeleton w={120} h={14} />
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} h={13} w={`${92 - (i % 4) * 12}%`} />
        ))}
      </div>
      {/* Topbar + content silhouette */}
      <div className="flex flex-col flex-1 min-w-0">
        <div
          style={{
            height: 58,
            borderBottom: '1px solid var(--bord)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
            padding: '0 24px',
          }}
        >
          <Skeleton w={200} h={14} />
          <Skeleton w={32} h={32} r="50%" />
        </div>
        <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Skeleton w={260} h={22} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18 }}>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} h={110} r={14} />
            ))}
          </div>
          <Skeleton h={280} r={14} />
        </div>
      </div>
    </div>
  )
}

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
  // Self-onboarding applies to EVERY tenant role (owner/HR/finance included
  // — statutory + banking details are needed regardless of seniority).
  // External auditors have no employee row (employeeId null skips them) and
  // FAM sessions are redirected to the console before this check.
  const isJoiningEmployee =
    !!freshRole && !['auditor', 'fam', 'super_admin'].includes(freshRole)
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
    return <AppShellSkeleton />
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
          {/* D19 (PRD v4 §8B.5): trial countdown / grace warning */}
          <BillingBanners />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
      {/* PRD v4 §3: ledger the pre-login banner choice once; re-acceptance on policy bumps */}
      <ConsentLedgerSync />
      <ReacceptanceGate />
      {/* PRD v4 §5: live presence socket (heartbeats + status_changed) */}
      <PresenceProvider />
      {/* Real-time notifications: push the bell instead of waiting on the poll */}
      <NotificationsSocket />
      {/* PRD v4 §6: consent-gated module_opened capture */}
      <ModuleOpenedTracker />
      {/* PRD v4 §7: menu-triggered feedback panel + NPS micro-card (no pill) */}
      <FeedbackPanel />
      <NpsCard />
      {/* D19: full lock wall when the workspace is read-only */}
      <BillingWall />
    </div>
  )
}
