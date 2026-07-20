'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useEffectiveFlags } from '@/lib/api/queries/use-auth'
import { useToast } from '@/components/ui/use-toast'
import { PmSyncEngine } from './engine'

/**
 * FSE lifecycle provider (PRD v6 §3). Creates one PmSyncEngine per
 * (tenant, user) when the pm_sync_engine flag is on; 'rest' mode otherwise —
 * the kill-switch path where PM pages run on react-query + REST. Company
 * switch tears the engine down and builds a fresh one (its own IndexedDB
 * store + cursor, §3.8).
 */

export type PmMode = 'loading' | 'sync' | 'rest'

interface PmContextValue {
  mode: PmMode
  engine: PmSyncEngine | null
}

const PmContext = createContext<PmContextValue>({ mode: 'loading', engine: null })

export function usePm(): PmContextValue {
  return useContext(PmContext)
}

export function PmProvider({ children }: { children: React.ReactNode }) {
  const { currentUser } = useAuthStore()
  const { flags, loaded } = useEffectiveFlags()
  const { toast } = useToast()
  const [value, setValue] = useState<PmContextValue>({ mode: 'loading', engine: null })
  const engineRef = useRef<PmSyncEngine | null>(null)

  const tenantId = currentUser?.tenantId
  const userId = currentUser?.id
  const syncOn = flags.includes('pm_sync_engine')

  useEffect(() => {
    if (!tenantId || !userId || !loaded) return
    if (!syncOn) {
      engineRef.current?.destroy()
      engineRef.current = null
      setValue({ mode: 'rest', engine: null })
      return
    }
    const engine = new PmSyncEngine(tenantId, userId)
    engine.onReject = (message) =>
      toast({ title: 'Change rejected', description: message, variant: 'destructive' })
    engineRef.current = engine
    let cancelled = false
    engine
      .start()
      .then(() => {
        if (!cancelled) setValue({ mode: 'sync', engine })
      })
      .catch(() => {
        // SYNC_DISABLED mid-flight or bootstrap failure → REST fallback.
        if (!cancelled) setValue({ mode: 'rest', engine: null })
      })
    return () => {
      cancelled = true
      engine.destroy()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, userId, syncOn, loaded])

  return <PmContext.Provider value={value}>{children}</PmContext.Provider>
}
