'use client'

import type { CSSProperties } from 'react'
import Link from 'next/link'
import { Icon, Toggle } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
  useUpdateEmailDigest,
  type NotificationEvent,
} from '@/lib/api/queries/use-notifications'

// ─────────────────────────────────────────────────────────
// P10 — Notification settings (§11), faithful to scr-issue-inbox.jsx
// ScrNotifSettings: a 640px column — the event × In-app/Email matrix card,
// the email digest frequency segmented card, and the DND note row.
// ─────────────────────────────────────────────────────────

// Exact P10 rows, in prototype order.
const EVENTS: Array<{ event: NotificationEvent; label: string }> = [
  { event: 'pm_assigned', label: 'Assigned to me' },
  { event: 'pm_mention', label: 'Mentioned' },
  { event: 'pm_comment', label: 'Comment on subscribed' },
  { event: 'pm_status', label: 'Status → completed/canceled' },
  { event: 'pm_cycle_digest', label: 'Cycle review digest' },
  { event: 'pm_project_nudge', label: 'Project update nudge' },
  { event: 'pm_github', label: 'GitHub state change on my issues' },
]

const FREQS: Array<['urgent' | 'hourly' | 'daily', string]> = [
  ['urgent', '5-min urgent only'],
  ['hourly', 'Hourly digest'],
  ['daily', 'Daily digest'],
]

const colHead: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 800,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
}

/** Prototype PmDot status="dnd" — red dot with the white bar. */
function DndDot({ size = 10 }: { size?: number }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', background: 'var(--coral)',
      boxShadow: '0 0 0 2px var(--bg)', flexShrink: 0, display: 'inline-block', position: 'relative',
    }}>
      <span style={{ position: 'absolute', left: '20%', right: '20%', top: '50%', height: 1.4, transform: 'translateY(-50%)', background: '#fff', borderRadius: 99 }} />
    </span>
  )
}

export default function PmNotifSettingsPage() {
  const { data, isLoading } = useNotificationPreferences()
  const update = useUpdateNotificationPreference()
  const updateDigest = useUpdateEmailDigest()
  const { toast } = useToast()

  const rowFor = (event: NotificationEvent) => data?.events.find((r) => r.event === event)
  const freq = data?.emailDigest ?? 'daily'

  const toggle = async (event: NotificationEvent, channel: 'in_app' | 'email', enabled: boolean) => {
    try {
      await update.mutateAsync({ event, channel, enabled })
    } catch (e) {
      toast({ title: 'Could not save', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }

  if (isLoading || !data) {
    return (
      <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
        <Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '18px 20px' }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        <Link href="/pm/settings/github" style={{ padding: '5px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 800, textDecoration: 'none', color: 'var(--text-mute)', border: '1px solid transparent' }}>GitHub</Link>
        <Link href="/pm/settings/notifications" style={{ padding: '5px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 800, textDecoration: 'none', color: '#fff', background: 'var(--surf-2)', border: '1px solid var(--bord-2)' }}>Notifications</Link>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px', gap: 0, padding: '10px 16px', borderBottom: '1px solid var(--bord)' }}>
          <span style={colHead}>Event</span>
          <span style={{ ...colHead, textAlign: 'center' }}>In-app</span>
          <span style={{ ...colHead, textAlign: 'center' }}>Email</span>
        </div>
        {EVENTS.map(({ event, label }) => {
          const r = rowFor(event)
          return (
            <div key={event} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px', alignItems: 'center', padding: '9px 16px', borderBottom: '1px solid var(--bord)' }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{label}</span>
              <span style={{ display: 'flex', justifyContent: 'center' }}>
                <Toggle on={r?.inApp ?? true} onChange={(v) => toggle(event, 'in_app', v)} />
              </span>
              <span style={{ display: 'flex', justifyContent: 'center' }}>
                <Toggle on={r?.email ?? false} onChange={(v) => toggle(event, 'email', v)} />
              </span>
            </div>
          )
        })}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 9 }}>Email digest frequency</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {FREQS.map(([k, l]) => (
            <button
              key={k}
              onClick={async () => {
                try {
                  await updateDigest.mutateAsync(k)
                } catch (e) {
                  toast({ title: 'Could not save', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
                }
              }}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 9, cursor: 'pointer',
                background: freq === k ? 'rgba(62,123,250,.1)' : 'var(--surf-1)',
                border: `1px solid ${freq === k ? 'rgba(62,123,250,.45)' : 'var(--bord)'}`,
                color: freq === k ? '#fff' : 'var(--text-2)',
                fontSize: 11.5, fontWeight: 800,
              }}
            >{l}</button>
          ))}
        </div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', marginTop: 9 }}>
          Mention/assignment emails send after 5 min only if still unread in-app · reading in-app cancels the pending email
        </div>
      </div>

      <div style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '10px 14px', borderRadius: 10, background: 'var(--surf-1)', border: '1px solid var(--bord)' }}>
        <DndDot size={10} />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
          Do not disturb (your presence) mutes toasts automatically — Inbox still accrues.
        </span>
      </div>
    </div>
  )
}
