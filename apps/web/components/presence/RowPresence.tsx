'use client'

import { AvatarV4 } from '@/components/media/AvatarV4'
import { PresenceDot, STATUS_META } from './PresenceDot'
import { useUserPresence } from '@/lib/api/queries/use-presence'

/**
 * D9 — presence on team surfaces (PRD v4 §5.4). Dot on the avatar + hover
 * tooltip with status label and the custom message. Row layouts unchanged —
 * this swaps in for a plain <Avatar> wherever a row shows a person.
 * Pages seed the batch with usePresence(userIds); the socket keeps it live.
 */
export function RowPresenceAvatar({
  name,
  src,
  userId,
  size = 30,
  ring = 'var(--bg)',
}: {
  name: string
  src?: string | null
  userId?: string | null
  size?: number
  ring?: string
}) {
  const { status, message } = useUserPresence(userId ?? undefined)
  const label = status ? STATUS_META[status].label : null
  return (
    <span
      title={label ? `${label}${message ? ` · ${message}` : ''}` : undefined}
      style={{ display: 'inline-flex', cursor: label ? 'default' : undefined }}
    >
      <AvatarV4 name={name} size={size} src={src} presence={status} ring={ring} />
    </span>
  )
}

/** Inline "● Status" text for list rows that have room (design team-list). */
export function PresenceText({ userId }: { userId?: string | null }) {
  const { status } = useUserPresence(userId ?? undefined)
  if (!status) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>
      <PresenceDot status={status} size={8} ring="transparent" />
      {STATUS_META[status].label}
    </span>
  )
}
