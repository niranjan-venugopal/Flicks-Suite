'use client'

import { Loader2 } from 'lucide-react'
import { Pill, SectionHead, Toggle } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { useToast } from '@/components/ui/use-toast'
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
  type NotificationEvent,
} from '@/lib/api/queries/use-notifications'

// Human labels + grouping for the HRMS preference-managed events (PRD §9.3).
// CRM events have no UI here; PM events live in the P10 page under
// Projects → Settings → Notifications (/pm/settings/notifications).
const EVENT_META: Partial<Record<
  NotificationEvent,
  { group: string; title: string; desc: string }
>> = {
  leave_requested: { group: 'Leave', title: 'Request submitted', desc: 'You are the approving manager' },
  leave_reviewed: { group: 'Leave', title: 'Approved / rejected', desc: 'Your leave request was reviewed' },
  timesheet_submitted: { group: 'Timesheet', title: 'Submitted', desc: 'A report submitted their week' },
  timesheet_reviewed: { group: 'Timesheet', title: 'Approved / rejected / rework', desc: 'Your timesheet was reviewed' },
  regularization_requested: { group: 'Attendance', title: 'Regularization submitted', desc: 'You are the approving manager' },
  regularization_reviewed: { group: 'Attendance', title: 'Regularization reviewed', desc: 'Your regularization was reviewed' },
  onboarding_submitted: { group: 'People', title: 'Onboarding submitted', desc: 'A hire finished self-onboarding' },
  onboarding_reviewed: { group: 'People', title: 'Onboarding reviewed', desc: 'Your onboarding was approved / sent back' },
}

const GROUP_ORDER = ['Leave', 'Timesheet', 'Attendance', 'People']

export default function NotificationsSettingsPage() {
  const { data, isLoading } = useNotificationPreferences()
  const update = useUpdateNotificationPreference()
  const { toast } = useToast()

  const toggle = async (
    event: NotificationEvent,
    channel: 'in_app' | 'email',
    enabled: boolean,
  ) => {
    try {
      await update.mutateAsync({ event, channel, enabled })
    } catch (e) {
      toast({
        title: 'Could not save',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const rowsByGroup = (group: string) =>
    (data?.events ?? []).filter((r) => EVENT_META[r.event]?.group === group)

  return (
    <SettingsLayout>
      <div className="card">
        <SectionHead
          title="Notifications"
          sub="Choose how the workspace tells you about each event. Sign-in and security emails are always sent."
          right={<Pill tone="green" dot>Live</Pill>}
        />

        {isLoading || !data ? (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-mute)' }} />
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 80px 80px',
                gap: 8,
                padding: '0 6px 8px',
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-mute)',
              }}
            >
              <div>Event</div>
              <div style={{ textAlign: 'center' }}>In-app</div>
              <div style={{ textAlign: 'center' }}>Email</div>
            </div>

            {GROUP_ORDER.map((group) => {
              const rows = rowsByGroup(group)
              if (rows.length === 0) return null
              return (
                <div key={group} style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-faint)',
                      padding: '8px 6px 4px',
                    }}
                  >
                    {group}
                  </div>
                  {rows.map((r) => {
                    const meta = EVENT_META[r.event]
                    if (!meta) return null
                    return (
                      <div
                        key={r.event}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 80px 80px',
                          gap: 8,
                          alignItems: 'center',
                          padding: '10px 6px',
                          borderTop: '1px solid var(--bord)',
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{meta.title}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-mute)' }}>{meta.desc}</div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'center' }}>
                          <Toggle
                            on={r.inApp}
                            onChange={(v) => toggle(r.event, 'in_app', v)}
                          />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'center' }}>
                          <Toggle
                            on={r.email}
                            onChange={(v) => toggle(r.event, 'email', v)}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}

            <p style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 4, padding: '0 6px' }}>
              WhatsApp and SMS channels are on the roadmap. Changes save instantly.
            </p>
          </div>
        )}
      </div>
    </SettingsLayout>
  )
}
