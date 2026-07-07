'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { type ReactNode } from 'react'
import { Icon } from '@/components/proto'
import type { IconKey } from '@/components/proto'
import { useFeedbackPanel } from '@/components/feedback/FeedbackPanel'

interface NavItem {
  href: string
  label: string
  icon: IconKey
}

// Matches prototype's ScrSettings sections, mapped to our actual routes.
// Holidays / Roles / Billing / Integrations / Audit are flagged so we can
// progressively enable them as the surfaces become real.
const NAV: Array<NavItem & { disabled?: boolean }> = [
  { href: '/settings',              label: 'General',              icon: 'cog' },
  { href: '/settings/organization', label: 'Organization · Financial', icon: 'bank' },
  { href: '/settings/departments',  label: 'Departments',          icon: 'layers' },
  { href: '/settings/locations',    label: 'Locations & geofence', icon: 'pin' },
  { href: '/settings/designations', label: 'Designations',         icon: 'briefcase' },
  { href: '/settings/working-hours',label: 'Working hours & shifts', icon: 'clock' },
  { href: '/settings/leave-policies', label: 'Leave policy',       icon: 'cal' },
  { href: '/settings/members',      label: 'Roles & permissions',  icon: 'shield' },
  { href: '/settings/notifications',label: 'Notifications',        icon: 'bell' },
  { href: '/settings/privacy',      label: 'Privacy & data',       icon: 'eye' },
]

interface SettingsLayoutProps {
  children: ReactNode
}

export function SettingsLayout({ children }: SettingsLayoutProps) {
  const pathname = usePathname() ?? '/settings'

  // Longest-prefix match so /settings/departments doesn't activate /settings.
  const activeHref = [...NAV]
    .sort((a, b) => b.href.length - a.href.length)
    .find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`))?.href

  return (
    <div className="relative min-h-full">
      <div className="relative z-10 p-8 max-w-6xl mx-auto">
        {/* Page header — same shape as ScrSettings */}
        <div style={{ marginBottom: 24 }}>
          <div className="t-h1" style={{ fontSize: 24, marginBottom: 4 }}>Settings</div>
          <div className="t-mute" style={{ fontSize: 13 }}>
            Configure your workspace · changes are logged in the audit trail
          </div>
        </div>

        {/* 2-column grid — exactly as prototype */}
        <div style={{ display: 'grid', gridTemplateColumns: '232px 1fr', gap: 20 }}>
          {/* Vertical nav */}
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {NAV.map((item) => {
              const active = item.href === activeHref
              const IconComp = Icon[item.icon]
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: active ? 'var(--surf-2)' : 'transparent',
                    border: active ? '1px solid var(--bord-2)' : '1px solid transparent',
                    color: active ? '#fff' : 'var(--text-2)',
                    cursor: 'pointer',
                    fontSize: 12.5,
                    fontWeight: active ? 800 : 600,
                    textAlign: 'left',
                    textDecoration: 'none',
                  }}
                >
                  <IconComp size={14} />
                  {item.label}
                </Link>
              )
            })}
            <SendFeedbackNavItem />
          </nav>

          {/* Content panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

/** D10-R secondary trigger — "Send feedback" entry in the settings rail. */
function SendFeedbackNavItem() {
  const setOpen = useFeedbackPanel((s) => s.setOpen)
  return (
    <button
      onClick={() => setOpen(true)}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        padding: '10px 12px',
        borderRadius: 8,
        background: 'transparent',
        border: '1px solid transparent',
        color: 'var(--text-2)',
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 600,
        textAlign: 'left',
        marginTop: 8,
        borderTop: '1px solid var(--bord)',
        paddingTop: 14,
      }}
    >
      <Icon.chat size={14} />
      Send feedback
    </button>
  )
}
