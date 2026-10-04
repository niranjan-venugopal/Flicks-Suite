'use client'

import { useEffect, useLayoutEffect } from 'react'
import { usePathname } from 'next/navigation'
import { reassertFromMirror, THEME_STORAGE_KEY } from '@/lib/theme/theme'

// Layout effect on the client (so the store catches up with <html data-theme>
// before the hydrated frame paints), plain effect on the server where layout
// effects would only warn.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Keeps `<html data-theme>` + the theme store in step with the device mirror
 * after the pre-paint script has done the first paint. Effect-only, renders
 * nothing, and deliberately does NOT call useCurrentUser — server
 * reconciliation lives in that hook's queryFn (syncThemeFromServer), so the
 * provider never forces an extra /me round-trip.
 *
 * Re-asserts on: mount, route change (public routes are forced dark),
 * `prefers-color-scheme` change (System users flip live, precedent
 * lib/hooks/use-is-mobile.ts) and the cross-tab `storage` event.
 */
export function ThemeProvider() {
  const pathname = usePathname()

  // reassertFromMirror never WRITES the mirror: an empty mirror stays empty
  // (pre-login / new device / public page) until the person picks or the
  // server reconciles — see lib/theme/theme.ts.
  useIsoLayoutEffect(() => {
    reassertFromMirror(pathname)
  }, [pathname])

  useEffect(() => {
    const reassert = () => reassertFromMirror(pathname)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', reassert)
    const onStorage = (e: StorageEvent) => {
      // key === null is a storage.clear() from another tab
      if (e.key === null || e.key === THEME_STORAGE_KEY) reassert()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      mq.removeEventListener('change', reassert)
      window.removeEventListener('storage', onStorage)
    }
  }, [pathname])

  return null
}
