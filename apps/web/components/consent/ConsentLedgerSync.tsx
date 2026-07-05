'use client'

import { useEffect, useRef } from 'react'
import {
  readConsentCookie,
  writeConsentCookie,
  analyticsDefaultFor,
  useBannerSync,
} from '@/lib/api/queries/use-consent'

/**
 * First-authenticated-session cookie→ledger sync (PRD v4 §3.3 fix). Ledgers
 * the pre-login banner choice — or the region default when the visitor never
 * touched the banner (US/rest default = granted) — as a source='banner' row.
 * The server dedupes: it only writes when the state differs from the latest
 * ledger row, so repeat logins add nothing. Mounted inside the authed shell.
 */
export function ConsentLedgerSync() {
  const sync = useBannerSync()
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const run = async () => {
      let cookie = readConsentCookie()
      if (!cookie) {
        // Never touched the banner → apply + persist the region default.
        try {
          const r = await fetch('/api/geo').then((x) => x.json())
          const region = String(r.region ?? 'IN')
          cookie = { v: 1, analytics: analyticsDefaultFor(region), region }
          writeConsentCookie(cookie.analytics, region)
        } catch {
          return // no region, no default — the banner will collect it
        }
      }
      sync.mutate({
        analytics: cookie.analytics,
        region_code: cookie.region.length === 2 ? cookie.region : undefined,
      })
    }
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
