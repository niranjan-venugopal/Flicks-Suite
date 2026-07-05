'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { api } from '@/lib/api/client'
import { readConsentCookie } from '@/lib/api/queries/use-consent'

/**
 * PRD v4 §6 — the ONLY client behavioral event: `module_opened` on route
 * change into a module. Client-side consent check (fs_consent cookie) plus the
 * server's own gate; identifiers only (module enum), never paths with ids.
 */
const ROUTE_MODULE: Array<[RegExp, string]> = [
  [/^\/dashboard/, 'dashboard'],
  [/^\/attendance|^\/time/, 'attendance'],
  [/^\/leave/, 'leave'],
  [/^\/timesheets?/, 'timesheets'],
  [/^\/employees/, 'employees'],
  [/^\/invoicing/, 'invoicing'],
  [/^\/reports/, 'reports'],
  [/^\/settings/, 'settings'],
  [/^\/inbox/, 'inbox'],
  [/^\/calendar/, 'calendar'],
]

export function ModuleOpenedTracker() {
  const pathname = usePathname()
  const last = useRef<string | null>(null)

  useEffect(() => {
    if (!pathname) return
    const module = ROUTE_MODULE.find(([re]) => re.test(pathname))?.[1]
    if (!module || module === last.current) return
    last.current = module
    // EU/India: off until granted; US/rest: cookie carries the on-default.
    const consent = readConsentCookie()
    if (!consent?.analytics) return
    api
      .post('/api/v1/events', { events: [{ event: 'module_opened', properties: { module } }] })
      .catch(() => {}) // analytics never breaks navigation
  }, [pathname])

  return null
}
