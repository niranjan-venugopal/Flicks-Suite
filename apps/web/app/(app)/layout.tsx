'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCurrentUser } from '@/lib/api/queries/use-auth'
import { useEmployeeOnboardingStatus } from '@/lib/api/queries/use-employee-onboarding'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { isAuthenticated, currentUser } = useAuthStore()
  const { isLoading, isError } = useCurrentUser()

  // Employees who haven't finished self-onboarding go to the wizard. Owners
  // and HR Admins skip this check — they're managing the workspace, not
  // joining it. Tracked in employees.custom_fields.onboarding_step.
  const role = currentUser?.role
  const isJoiningEmployee =
    role === 'EMPLOYEE' || role === 'MANAGER'
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
    if (needsOnboarding) {
      router.replace('/onboarding/employee')
    }
  }, [isLoading, isError, isAuthenticated, needsOnboarding, router])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-brand-bg">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <Topbar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
