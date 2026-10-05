'use client'

import { useEffect, useState } from 'react'

/** The value as it was `ms` ago — for search boxes that hit the server. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
