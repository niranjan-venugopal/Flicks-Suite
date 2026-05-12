'use client'

import { useAuthStore } from '@/lib/stores/auth.store'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'

export default function ProfilePage() {
  const { currentUser, currentTenant } = useAuthStore()

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="My profile"
          sub="Your account, employment, and security settings"
          right={
            <Btn kind="secondary" size="sm" icon={<Icon.edit size={13} />}>
              Edit profile
            </Btn>
          }
        />

        {/* Identity card */}
        <div className="card" style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <Avatar name={currentUser?.name ?? ''} size="xl" src={currentUser?.avatarUrl} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t-h1" style={{ fontSize: 24, marginBottom: 6 }}>
                {currentUser?.name ?? 'Guest'}
              </div>
              <div className="t-mute" style={{ fontSize: 13, marginBottom: 8 }}>
                {currentUser?.email ?? '—'} · {currentTenant?.name ?? '—'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Pill tone="green" dot>Active</Pill>
                <Pill>{currentUser?.role?.replace('_', ' ').toLowerCase() ?? 'member'}</Pill>
                {currentUser?.employeeId && (
                  <Pill>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>
                      {currentUser.employeeId.slice(0, 8)}
                    </span>
                  </Pill>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {/* Account info */}
          <div className="card">
            <SectionHead title="Account" sub="Identity and contact details" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Full name" value={currentUser?.name ?? '—'} />
              <Field label="Work email" value={currentUser?.email ?? '—'} mono />
              <Field label="Workspace" value={currentTenant?.name ?? '—'} />
              <Field label="Role" value={currentUser?.role?.replace('_', ' ').toLowerCase() ?? '—'} />
            </div>
          </div>

          {/* Security */}
          <div className="card">
            <SectionHead title="Security" sub="Sign-in method and active sessions" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  padding: '12px 14px',
                  background: 'var(--surf-1)',
                  border: '1px solid var(--bord)',
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <Icon.mail size={16} style={{ color: 'var(--blue)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>Email + OTP</div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                    Passwordless · 6-digit code valid for 10 minutes
                  </div>
                </div>
                <Pill tone="green" dot>Active</Pill>
              </div>
              <Field label="Last sign-in" value={new Date().toLocaleString('en-IN')} />
              <Btn kind="secondary" size="sm" icon={<Icon.refresh size={13} />}>
                Sign out other devices
              </Btn>
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            padding: '12px 14px',
            background: 'rgba(62,123,250,.06)',
            border: '1px solid rgba(62,123,250,.2)',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-2)',
            display: 'flex',
            gap: 10,
          }}
        >
          <Icon.info size={16} style={{ color: 'var(--blue)', marginTop: 1, flexShrink: 0 }} />
          <div>
            More profile fields (PAN, bank, address, emergency contact) appear once the
            self-onboarding flow lands per PRD §5.
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="t-caption" style={{ marginBottom: 5 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: '#fff',
          fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        }}
      >
        {value}
      </div>
    </div>
  )
}
