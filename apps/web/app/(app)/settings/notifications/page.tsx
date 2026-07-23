'use client'

import { Loader2 } from 'lucide-react'
import { Pill, SectionHead, Toggle } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { useToast } from '@/components/ui/use-toast'
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
  useUpdateEmailDigest,
  type NotificationEvent,
} from '@/lib/api/queries/use-notifications'

// Human labels + grouping for the preference-managed events (PRD §9.3 + v6 §11).
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
  crm_activity: { group: 'CRM', title: 'Activity assigned to me', desc: 'A call, task or meeting lands in your queue' },
  crm_digest: { group: 'CRM', title: 'Morning digest', desc: 'Overdue + today summary at 8am' },
  // PM (P10 matrix rows)
  pm_assigned: { group: 'Projects', title: 'Assigned to me', desc: 'An issue was put in your hands' },
  pm_mention: { group: 'Projects', title: 'Mentioned', desc: 'Someone @-mentioned you in a comment' },
  pm_comment: { group: 'Projects', title: 'Comment on subscribed', desc: 'New comment on an issue you follow' },
  pm_status: { group: 'Projects', title: 'Status → completed / canceled', desc: 'A followed issue reached a final state' },
  pm_cycle_digest: { group: 'Projects', title: 'Cycle review digest', desc: 'What rolled over and what returned at cycle end' },
  pm_project_nudge: { group: 'Projects', title: 'Project update nudge', desc: 'Your project has no health update in 7 days' },
  pm_github: { group: 'Projects', title: 'GitHub state change on my issues', desc: 'Branch / PR / merge walked your issue' },
}

const GROUP_ORDER = ['Projects', 'Leave', 'Timesheet', 'Attendance', 'People', 'CRM']

const DIGEST_OPTIONS = [
  { id: 'urgent' as const, label: '5-min urgent only', desc: 'Only unread mentions + assignments email' },
  { id: 'hourly' as const, label: 'Hourly digest', desc: 'Everything else folds every hour' },
  { id: 'daily' as const, label: 'Daily digest', desc: 'One fold at 8am your time' },
]

export default function NotificationsSettingsPage() {
  const { data, isLoading } = useNotificationPreferences()
  const update = useUpdateNotificationPreference()
  const updateDigest = useUpdateEmailDigest()
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

            {/* Email digest cadence (P10) */}
            <div style={{ borderTop: '1px solid var(--bord)', paddingTop: 14, marginTop: 4 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)', padding: '0 6px 8px' }}>
                Email digest frequency
              </div>
              <div style={{ display: 'flex', gap: 8, padding: '0 6px', flexWrap: 'wrap' }}>
                {DIGEST_OPTIONS.map((o) => {
                  const active = (data.emailDigest ?? 'daily') === o.id
                  return (
                    <button
                      key={o.id}
                      onClick={async () => {
                        try {
                          await updateDigest.mutateAsync(o.id)
                        } catch (e) {
                          toast({ title: 'Could not save', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
                        }
                      }}
                      style={{
                        flex: '1 1 150px', textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                        background: active ? 'rgba(62,123,250,.12)' : 'var(--surf-1)',
                        border: `1px solid ${active ? 'var(--blue)' : 'var(--bord)'}`,
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 800, color: active ? 'var(--blue)' : 'var(--text-1)' }}>{o.label}</div>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>{o.desc}</div>
                    </button>
                  )
                })}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-mute)', padding: '10px 6px 0' }}>
                Mentions and assignments email after 5 minutes only if still unread in-app — reading in-app cancels the pending email.
                Do not disturb (your presence) mutes toasts automatically; the Inbox still accrues.
              </p>
            </div>

            <p style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 4, padding: '0 6px' }}>
              WhatsApp and SMS channels are on the roadmap. Changes save instantly.
            </p>
          </div>
        )}
      </div>
    </SettingsLayout>
  )
}
