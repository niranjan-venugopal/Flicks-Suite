'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCurrentUser } from '@/lib/api/queries/use-auth'
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
    }
  }, [isLoading, isError, isAuthenticated, isPlatformAdmin, needsOnboarding, router])

  // Don't render the app shell until /me has resolved. Otherwise the
  // persisted Zustand store re-hydrates with the PREVIOUS session's role
  // and the dashboard / sidebar / topbar render the wrong navigation
  // for ~half a second before the fresh data lands. Showing a centered
  // spinner is better UX than flashing the wrong UI.
  if (isLoading || (isAuthenticated && !meData)) {
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
    </div>
  )
}
