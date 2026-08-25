'use client'

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { io, type Socket } from 'socket.io-client'
import { useAuthStore } from '@/lib/stores/auth.store'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

interface PushedNotification {
  type: string
  message: string
  linkUrl?: string | null
  createdAt: string
}

/**
 * Notifications socket wiring — connects the Topbar bell to the /notifications
 * namespace (cookie-authed handshake, same as PresenceProvider) so approvals
 * and pings land in real time instead of on the ~2-min safety poll. On a
 * `notification` push we invalidate the notifications query cache; react-query
 * refetches the unread list (server stays the source of truth for read state
 * and the badge total). Falls back silently to the poll if the socket can't
 * connect (offline, blocked upgrade, single-instance restart).
 *
 * Note: the push is in-process — there's no Redis socket.io adapter yet, so a
 * multi-instance API would only reach sockets on the emitting node. Correct for
 * the single-instance MVP; the poll backstops the rest. See the launch-actions
 * doc for the multi-instance adapter follow-up.
 */
export function NotificationsSocket() {
  const { currentUser } = useAuthStore()
  const qc = useQueryClient()
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    if (!currentUser?.id || !currentUser.tenantId) return

    const socket = io(`${BASE_URL}/notifications`, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 15_000,
    })
    socketRef.current = socket

    socket.on('notification', (_p: PushedNotification) => {
      // Server is authoritative for the unread set + total; a refetch is
      // cheaper to reason about than a client-side prepend and keeps the badge
      // exact. Invalidating the whole 'notifications' tree also refreshes the
      // /notifications list page if it's mounted.
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    })

    // Tenant-wide HRMS data push (onboarding submitted/approved/rejected):
    // refresh the directory, org chart, Inbox approvals + dashboard badge, and
    // — when this session IS the person who just got approved — their own /me
    // and onboarding-status so the app unlocks without a reload.
    socket.on('employees_changed', () => {
      void qc.invalidateQueries({ queryKey: ['employees'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      void qc.invalidateQueries({ queryKey: ['employee', 'onboarding-status'] })
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, currentUser?.tenantId])

  return null
}
