'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCurrentUser } from '@/lib/api/queries/use-auth'

/**
 * Specflicks-internal FAM console layout. Only role='fam' members are
 * allowed in; everyone else gets bounced back to the customer app shell.
 * Mirrors the (app) layout's spinner-while-/me-resolves pattern so we don't
 * render the wrong nav for half a second on hard refresh. The legacy
 * 'super_admin' enum value is accepted as an alias until 0004_role_fam.sql
 * has been applied everywhere.
 */
export default function FamLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { isAuthenticated } = useAuthStore()
  const me = useCurrentUser()
  const { isLoading, isError, data: meData } = me

  const freshRole =
    (meData?.currentMembership?.role ?? meData?.memberships?.[0]?.role ?? '').toLowerCase()
  // User-level flag first: after login auto-selection the ACTIVE workspace is
  // usually the admin's own company (role 'owner'), so membership role alone
  // would wrongly bounce platform admins out of /fam.
  const isPlatformAdmin =
    meData?.isPlatformAdmin === true ||
    freshRole === 'fam' ||
    freshRole === 'super_admin'

  useEffect(() => {
    if (isLoading) return
    if (isError || !isAuthenticated) {
      router.replace('/login')
      return
    }
    if (meData && !isPlatformAdmin) {
      // A non-platform-admin somehow reached /fam — bounce them to the
      // customer shell. The (app) layout will then onward-route as needed.
      router.replace('/dashboard')
    }
  }, [isLoading, isError, isAuthenticated, meData, isPlatformAdmin, router])

  if (!isAuthenticated || isLoading || !meData || !isPlatformAdmin) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-brand-bg">
        <Loader2 className="w-7 h-7 animate-spin text-brand-muted" />
      </div>
    )
  }

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
