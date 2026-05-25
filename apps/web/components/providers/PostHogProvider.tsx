'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  initPostHog,
  identify,
  capturePageview,
  isPostHogEnabled,
} from '@/lib/analytics/posthog'

/**
 * Initialises PostHog once, identifies the signed-in user, and captures a
 * pageview on every client-side route change. No-op without
 * NEXT_PUBLIC_POSTHOG_KEY so local dev is unaffected.
 *
 * Pathname-only (no useSearchParams) so the root layout doesn't get
 * pulled into a Suspense boundary requirement on Next 15.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const currentUser = useAuthStore((s) => s.currentUser)

  useEffect(() => {
    initPostHog()
  }, [])

  // Identify whenever the signed-in user changes.
  useEffect(() => {
    if (!isPostHogEnabled() || !currentUser?.id) return
    identify(currentUser.id, {
      email: currentUser.email,
      role: currentUser.role,
      tenantId: currentUser.tenantId,
    })
  }, [currentUser?.id, currentUser?.email, currentUser?.role, currentUser?.tenantId])

  // Pageview on route change.
  useEffect(() => {
    if (!isPostHogEnabled() || !pathname) return
    capturePageview(pathname)
  }, [pathname])

  return <>{children}</>
}
