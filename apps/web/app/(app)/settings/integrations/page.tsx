'use client'

import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { Icon, SectionHead } from '@/components/proto'
import { ComingSoon } from '@/components/crm/ComingSoon'

// ─────────────────────────────────────────────────────────
// Round J — Settings → Integrations. The calendar lets organizers pick
// Microsoft Teams / Google Meet and paste the link today; connecting an
// account here is what will let Flicks generate that link (and sync the
// event to Outlook / Google Calendar) automatically. Parked honestly as
// "Coming soon" until the OAuth round lands — the API already has the
// MeetingLinksService door for it.
// ─────────────────────────────────────────────────────────

export default function IntegrationsSettingsPage() {
  return (
    <SettingsLayout>
      <div className="card" style={{ maxWidth: 780 }}>
        <SectionHead
          title="Integrations"
          sub="Connect the accounts your team already uses — meeting links and calendar sync follow automatically."
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginTop: 6 }}>
          <ComingSoon
            compact
            title="Microsoft 365"
            icon={<Icon.laptop size={22} />}
            line="Sign in with your Microsoft work account to let Flicks create Teams meeting links for you and keep Outlook in step."
            bullets={[
              'Schedule a meeting → a Teams link is generated automatically',
              'Events you organize appear in your Outlook calendar',
              'Per-user connection — nobody else can use your account',
            ]}
          />
          <ComingSoon
            compact
            title="Google Workspace"
            icon={<Icon.globe size={22} />}
            line="Connect your Google account to auto-generate Google Meet links and mirror events into Google Calendar."
            bullets={[
              'Schedule a meeting → a Google Meet link is generated automatically',
              'Events you organize appear in your Google Calendar',
              'Per-user connection — nobody else can use your account',
            ]}
          />
        </div>
        <div className="t-mute" style={{ fontSize: 12, marginTop: 16, lineHeight: 1.6 }}>
          Until then, pick <b>Teams</b> or <b>Google Meet</b> when scheduling and paste the link from the app you use.
          The read-only <b>Subscribe (iCal)</b> feed on the calendar already works with Google Calendar, Outlook and Apple Calendar.
        </div>
      </div>
    </SettingsLayout>
  )
}
