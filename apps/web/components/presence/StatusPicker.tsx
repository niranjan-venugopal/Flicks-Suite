'use client'

import { useEffect, useRef, useState } from 'react'
import { AvatarV4 } from '@/components/media/AvatarV4'
import { PresenceDot, STATUS_META, type PresenceStatus } from './PresenceDot'
import { Icon } from '@/components/proto'
import { useSetStatus, useClearStatus, type ManualStatus } from '@/lib/api/queries/use-presence'
import { useUserPresence } from '@/lib/api/queries/use-presence'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'

const MANUAL: ManualStatus[] = ['available', 'busy', 'dnd', 'brb', 'away', 'offline']
const CLEAR_OPTIONS = ['30 minutes', '1 hour', 'Today', 'This week', 'Never'] as const
type ClearAfter = (typeof CLEAR_OPTIONS)[number]

function expiryFor(choice: ClearAfter): string | undefined {
  const now = new Date()
  switch (choice) {
    case '30 minutes':
      return new Date(now.getTime() + 30 * 60 * 1000).toISOString()
    case '1 hour':
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    case 'Today': {
      const end = new Date(now)
      end.setHours(23, 59, 59, 999)
      return end.toISOString()
    }
    case 'This week': {
      const end = new Date(now)
      const day = end.getDay() // 0 = Sunday
      end.setDate(end.getDate() + ((7 - day) % 7))
      end.setHours(23, 59, 59, 999)
      return end.toISOString()
    }
    case 'Never':
      return undefined
  }
}

/**
 * D8 — status picker (PRD v4 §5). Resolved header → six manual options with
 * exact dot styles → auto states (shown, not selectable) → 80-char message →
 * Clear after → Reset. Manual selection saves immediately; expiry auto-reverts
 * live via the gateway's scheduled re-broadcast.
 */
export function StatusPicker({ onClose }: { onClose: () => void }) {
  const { currentUser } = useAuthStore()
  const { toast } = useToast()
  const setStatus = useSetStatus()
  const clearStatus = useClearStatus()
  const presence = useUserPresence(currentUser?.id)
  const [msg, setMsg] = useState('')
  const [clearAfter, setClearAfter] = useState<ClearAfter>('Never')
  const rootRef = useRef<HTMLDivElement>(null)

  const resolved: PresenceStatus = presence.status ?? 'offline'
  const meta = STATUS_META[resolved]
  const manualActive = MANUAL.includes(resolved as ManualStatus) ? (resolved as ManualStatus) : null

  useEffect(() => {
    setMsg(presence.message ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  const apply = async (status: ManualStatus, message = msg, clear = clearAfter) => {
    try {
      await setStatus.mutateAsync({
        status,
        message: message || undefined,
        expires_at: expiryFor(clear),
      })
    } catch (err) {
      toast({
        title: 'Could not set status',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const reset = async () => {
    try {
      await clearStatus.mutateAsync()
      setMsg('')
    } catch {
      /* surface-level only */
    }
  }

  return (
    <div
      ref={rootRef}
      style={{
        width: 308,
        background: 'rgba(18,18,30,.98)',
        backdropFilter: 'blur(16px)',
        border: '1px solid var(--bord-2)',
        borderRadius: 14,
        boxShadow: '0 28px 70px rgba(0,0,0,.6)',
        overflow: 'hidden',
      }}
    >
      {/* Resolved header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 11 }}>
        <AvatarV4 name={currentUser?.name ?? ''} size={38} src={currentUser?.avatarUrl} presence={resolved} ring="rgba(18,18,30,1)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>{currentUser?.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
            <PresenceDot status={resolved} size={8} ring="transparent" />
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>
              {meta.label}
              {!manualActive && meta.auto ? ' · auto' : ''}
            </span>
            {presence.message && (
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                · {presence.message}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer' }}
        >
          <Icon.x size={12} />
        </button>
      </div>

      {/* Six manual options */}
      <div style={{ padding: '8px 8px 4px' }}>
        {MANUAL.map((k) => {
          const m = STATUS_META[k]
          const sel = manualActive === k
          return (
            <button
              key={k}
              onClick={() => (sel ? reset() : apply(k))}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '8px 10px',
                borderRadius: 8,
                background: sel ? 'var(--surf-2)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <PresenceDot status={k} size={11} ring="transparent" />
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: sel ? 800 : 600, color: sel ? '#fff' : 'var(--text-2)' }}>
                {m.label}
              </span>
              {sel && <Icon.check size={14} style={{ color: 'var(--blue)' }} />}
            </button>
          )
        })}
      </div>

      {/* Auto states (informational) */}
      <div style={{ margin: '2px 8px 8px', padding: '8px 10px', borderRadius: 9, background: 'var(--surf-1)', border: '1px dashed var(--bord)' }}>
        <div className="t-caption" style={{ fontSize: 9, marginBottom: 6 }}>Auto · shown when active</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {(['in_office', 'out_of_office', 'remote_available', 'ooo_available'] as PresenceStatus[]).map((k) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
              <PresenceDot status={k} size={9} ring="transparent" /> {STATUS_META[k].label}
            </span>
          ))}
        </div>
      </div>

      {/* Message + clear-after */}
      <div style={{ padding: '10px 16px 14px', borderTop: '1px solid var(--bord)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span className="label" style={{ margin: 0 }}>Status message</span>
            <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-mono)', color: msg.length > 70 ? 'var(--yellow)' : 'var(--text-faint)' }}>
              {msg.length}/80
            </span>
          </div>
          <input
            className="input"
            style={{ height: 36, fontSize: 12, width: '100%' }}
            placeholder="Heads-down till 3 pm…"
            value={msg}
            maxLength={80}
            onChange={(e) => setMsg(e.target.value)}
            onBlur={() => manualActive && apply(manualActive)}
            onKeyDown={(e) => e.key === 'Enter' && manualActive && apply(manualActive)}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <div className="label">Clear after</div>
            <select
              className="input"
              style={{ height: 36, fontSize: 12, width: '100%' }}
              value={clearAfter}
              onChange={(e) => {
                const v = e.target.value as ClearAfter
                setClearAfter(v)
                if (manualActive) void apply(manualActive, msg, v)
              }}
            >
              {CLEAR_OPTIONS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
          <button
            onClick={reset}
            style={{ height: 36, padding: '0 12px', borderRadius: 9, background: 'transparent', border: '1px solid var(--bord)', color: 'var(--text-2)', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }}
          >
            Reset status
          </button>
        </div>
      </div>
    </div>
  )
}
