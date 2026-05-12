'use client'

import { Icon, Pill, SectionHead } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'

interface ChannelRow {
  channel: string
  icon: 'mail' | 'bell' | 'phone' | 'zap'
  status: 'live' | 'soon'
  description: string
}

const CHANNELS: ChannelRow[] = [
  {
    channel: 'Email',
    icon: 'mail',
    status: 'live',
    description:
      'Magic-link sign-in + transactional alerts (leave approvals, attendance regularizations) ship today.',
  },
  {
    channel: 'In-app',
    icon: 'bell',
    status: 'soon',
    description:
      'Notification bell + dedicated /notifications page with unread counts. Sprint 2.',
  },
  {
    channel: 'Slack',
    icon: 'zap',
    status: 'soon',
    description:
      'Notify managers in #people-ops when approvals are pending; daily attendance digest.',
  },
  {
    channel: 'SMS',
    icon: 'phone',
    status: 'soon',
    description:
      'Critical-only fallback for managers (final approval reminders).',
  },
]

const EVENT_GROUPS: Array<{
  group: string
  items: Array<{ title: string; desc: string }>
}> = [
  {
    group: 'Leave',
    items: [
      { title: 'Request submitted',  desc: 'Notify the approving manager' },
      { title: 'Request approved',   desc: 'Notify the employee' },
      { title: 'Request rejected',   desc: 'Notify the employee with comment' },
      { title: 'Quota low',          desc: 'Warn employees when balance < 2 days' },
    ],
  },
  {
    group: 'Attendance',
    items: [
      { title: 'Missing punch',      desc: 'Notify employee at end of day' },
      { title: 'Regularization',     desc: 'Notify the approving manager' },
      { title: 'Late arrival',       desc: 'Daily summary to manager' },
    ],
  },
  {
    group: 'Timesheet',
    items: [
      { title: 'Period open',        desc: 'Remind employees to fill timesheet' },
      { title: 'Submitted',          desc: 'Notify the approving manager' },
      { title: 'Rework requested',   desc: 'Notify the employee with comment' },
    ],
  },
  {
    group: 'Workspace',
    items: [
      { title: 'New member joined',  desc: 'Notify admins' },
      { title: 'Role changed',       desc: 'Notify the affected member' },
    ],
  },
]

export default function NotificationsSettingsPage() {
  return (
    <SettingsLayout>
      <div className="card">
        <SectionHead
          title="Notifications"
          sub="Where and when the workspace tells you something happened. Per-event toggles ship in Sprint 2."
          right={<Pill tone="yellow" dot>Preview</Pill>}
        />

        <div style={{ marginBottom: 18 }}>
          <div className="t-h3" style={{ fontSize: 13, marginBottom: 10 }}>
            Channels
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {CHANNELS.map((c) => {
              const IconComp = Icon[c.icon]
              return (
                <div
                  key={c.channel}
                  style={{
                    padding: 14,
                    background: 'var(--surf-1)',
                    border: '1px solid var(--bord)',
                    borderRadius: 10,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 9,
                      background: 'rgba(62, 123, 250, 0.13)',
                      color: 'var(--blue)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <IconComp size={15} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 800 }}>{c.channel}</span>
                      {c.status === 'live' ? (
                        <Pill tone="green" dot>Live</Pill>
                      ) : (
                        <Pill tone="yellow">Soon</Pill>
                      )}
                    </div>
                    <p
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: 'var(--text-mute)',
                        lineHeight: 1.4,
                      }}
                    >
                      {c.description}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div>
          <div className="t-h3" style={{ fontSize: 13, marginBottom: 10 }}>
            Events
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {EVENT_GROUPS.map((g) => (
              <div
                key={g.group}
                style={{
                  padding: 14,
                  background: 'var(--surf-1)',
                  border: '1px solid var(--bord)',
                  borderRadius: 10,
                  opacity: 0.7,
                }}
              >
                <div
                  style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-mute)',
                    marginBottom: 10,
                  }}
                >
                  {g.group}
                </div>
                <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
                  {g.items.map((it) => (
                    <li
                      key={it.title}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}
                    >
                      <div
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 4,
                          border: '1px solid var(--bord-2)',
                          background: 'var(--surf-2)',
                          marginTop: 2,
                          flexShrink: 0,
                        }}
                      />
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{it.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-mute)' }}>{it.desc}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            padding: 14,
            background: 'rgba(254, 216, 0, 0.07)',
            border: '1px solid rgba(254, 216, 0, 0.18)',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div style={{ color: 'var(--yellow)', flexShrink: 0, marginTop: 1 }}>
            <Icon.info size={16} />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>
              Coming next: per-event toggles
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Sprint 2 adds a real bell + notifications page, a <code>notification_preferences</code>{' '}
              table, and per-event channel selection per user. Today the workspace defaults to email
              for every transactional event.
            </p>
          </div>
        </div>
      </div>
    </SettingsLayout>
  )
}
