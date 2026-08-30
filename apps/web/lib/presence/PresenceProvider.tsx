'use client'

import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuthStore } from '@/lib/stores/auth.store'
import { usePresenceStore, type ResolvedPresence } from './presence-store'
import { SOCKET_TRANSPORTS } from '@/lib/realtime'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

/**
 * Presence socket wiring (PRD v4 §5) — the first real socket.io consumer in
 * the web app. Connects to the /presence namespace (cookie-authed handshake),
 * sends a heartbeat every 60s plus an immediate ping when the user returns
 * from idle interaction, and folds `status_changed` broadcasts into the store.
 * Falls back silently when sockets can't connect (rows then rely on batched
 * GET /presence reads).
 */
export function PresenceProvider() {
  const { currentUser } = useAuthStore()
  const upsert = usePresenceStore((s) => s.upsert)
  const setSelf = usePresenceStore((s) => s.setSelf)
  const socketRef = useRef<Socket | null>(null)
  const lastPing = useRef(0)

  useEffect(() => {
    if (!currentUser?.id || !currentUser.tenantId) return
    setSelf(currentUser.id)

    const socket = io(`${BASE_URL}/presence`, {
      withCredentials: true,
      transports: SOCKET_TRANSPORTS,
      reconnectionDelayMax: 15_000,
    })
    socketRef.current = socket

    socket.on('status_changed', (p: ResolvedPresence) => upsert(p))

    const ping = () => {
      const now = Date.now()
      if (now - lastPing.current > 55_000) {
        lastPing.current = now
        socket.emit('heartbeat')
      }
    }
    const interval = setInterval(() => socket.emit('heartbeat'), 60_000)
    // Interaction bursts count as activity (idle→available without waiting).
    window.addEventListener('mousemove', ping)
    window.addEventListener('keydown', ping)
    window.addEventListener('focus', ping)

    return () => {
      clearInterval(interval)
      window.removeEventListener('mousemove', ping)
      window.removeEventListener('keydown', ping)
      window.removeEventListener('focus', ping)
      socket.disconnect()
      socketRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, currentUser?.tenantId])

  return null
}
