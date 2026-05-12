'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface Tab {
  id: string
  label: string
  href: string
}

const TABS: Tab[] = [
  { id: 'organization', label: 'Organization', href: '/settings' },
  { id: 'locations', label: 'Locations', href: '/settings/locations' },
  { id: 'departments', label: 'Departments', href: '/settings/departments' },
  { id: 'designations', label: 'Designations', href: '/settings/designations' },
  { id: 'working-hours', label: 'Working hours', href: '/settings/working-hours' },
  { id: 'leave-policies', label: 'Leave policies', href: '/settings/leave-policies' },
  { id: 'members', label: 'Members', href: '/settings/members' },
  { id: 'notifications', label: 'Notifications', href: '/settings/notifications' },
]

export function SettingsTabs() {
  const pathname = usePathname()
  const activeHref = TABS
    .slice()
    .sort((a, b) => b.href.length - a.href.length)
    .find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))?.href

  return (
    <div className="mb-6 flex flex-wrap gap-1.5 border-b border-white/8 pb-3">
      {TABS.map((tab) => {
        const isActive = tab.href === activeHref
        return (
          <Link
            key={tab.id}
            href={tab.href}
            className={
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ' +
              (isActive
                ? 'bg-white/10 text-white'
                : 'text-brand-muted hover:text-white hover:bg-white/5')
            }
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
