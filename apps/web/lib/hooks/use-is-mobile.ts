'use client'

import { useEffect, useState } from 'react'

/**
 * True while `query` matches (SSR-safe: false on the server and the first
 * client render, then live via matchMedia). Round J lifted this out of the
 * CRM deals board so the calendar can share the same breakpoints.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const apply = () => setMatches(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [query])
  return matches
}

/** Phone-width layout switch (≤ 760 px). */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 760px)')
}
