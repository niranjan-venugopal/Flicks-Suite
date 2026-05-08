'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Users,
  GitBranch,
  UserPlus,
  FileText,
  Clock,
  Calendar,
  BarChart3,
  Settings,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ClipboardList,
  TrendingUp,
  Briefcase,
  Bell,
  Building2,
  MapPin,
  Timer,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/lib/stores/auth.store'

interface NavItem {
  label: string
  href?: string
  icon: React.ComponentType<{ className?: string }>
  children?: NavItem[]
  badge?: number
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
  },
  {
    label: 'People',
    icon: Users,
    children: [
      { label: 'Employees', href: '/employees', icon: Users },
      { label: 'Org Chart', href: '/employees/org-chart', icon: GitBranch },
      { label: 'Onboarding', href: '/employees/onboarding', icon: UserPlus },
      { label: 'Documents', href: '/employees/documents', icon: FileText },
    ],
  },
  {
    label: 'Time',
    icon: Clock,
    children: [
      { label: 'Attendance', href: '/attendance', icon: Clock },
      { label: 'Leave', href: '/leave', icon: Calendar },
      { label: 'Timesheets', href: '/timesheets', icon: Timer },
      { label: 'Calendar', href: '/calendar', icon: Calendar },
    ],
  },
  {
    label: 'Reports',
    icon: BarChart3,
    children: [
      { label: 'Attendance', href: '/reports/attendance', icon: ClipboardList },
      { label: 'Leave', href: '/reports/leave', icon: Calendar },
      { label: 'Headcount', href: '/reports/headcount', icon: TrendingUp },
      { label: 'Audit Log', href: '/reports/audit', icon: FileText },
    ],
  },
  {
    label: 'Settings',
    icon: Settings,
    children: [
      { label: 'Organization', href: '/settings', icon: Building2 },
      { label: 'Locations', href: '/settings/locations', icon: MapPin },
      { label: 'Departments', href: '/settings/departments', icon: Briefcase },
      { label: 'Working Hours', href: '/settings/working-hours', icon: Clock },
      { label: 'Leave Policies', href: '/settings/leave-policies', icon: Calendar },
      { label: 'Members', href: '/settings/members', icon: Users },
      { label: 'Notifications', href: '/settings/notifications', icon: Bell },
    ],
  },
]

interface SidebarProps {
  className?: string
}

function NavLink({
  item,
  isCollapsed,
  depth = 0,
}: {
  item: NavItem
  isCollapsed: boolean
  depth?: number
}) {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(() => {
    if (item.children) {
      return item.children.some((child) => child.href && pathname.startsWith(child.href))
    }
    return false
  })

  const isActive = item.href ? pathname === item.href || pathname.startsWith(item.href + '/') : false
  const hasChildren = item.children && item.children.length > 0

  if (hasChildren) {
    const isChildActive = item.children!.some(
      (child) => child.href && (pathname === child.href || pathname.startsWith(child.href + '/'))
    )

    return (
      <div>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded text-sm font-medium font-gilroy transition-all duration-200 group',
            isChildActive
              ? 'text-white bg-brand-blue/10'
              : 'text-white/50 hover:text-white/80 hover:bg-white/5',
            isCollapsed && 'justify-center px-2'
          )}
          title={isCollapsed ? item.label : undefined}
        >
          <item.icon
            className={cn(
              'h-4 w-4 shrink-0',
              isChildActive ? 'text-brand-blue' : 'text-current'
            )}
          />
          {!isCollapsed && (
            <>
              <span className="flex-1 text-left">{item.label}</span>
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 transition-transform duration-200',
                  isOpen ? 'rotate-180' : ''
                )}
              />
            </>
          )}
        </button>
        {!isCollapsed && isOpen && (
          <div className="ml-3 mt-1 space-y-0.5 border-l border-white/[0.06] pl-3">
            {item.children!.map((child) => (
              <NavLink key={child.href} item={child} isCollapsed={false} depth={1} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <Link
      href={item.href!}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded text-sm font-medium font-gilroy transition-all duration-200 relative group',
        isActive
          ? 'nav-active text-white'
          : 'text-white/50 hover:text-white/80 hover:bg-white/5',
        isCollapsed && 'justify-center px-2',
        depth > 0 && 'text-xs py-1.5'
      )}
      title={isCollapsed ? item.label : undefined}
    >
      <item.icon
        className={cn(
          'shrink-0',
          depth > 0 ? 'h-3.5 w-3.5' : 'h-4 w-4',
          isActive ? 'text-brand-blue' : 'text-current'
        )}
      />
      {!isCollapsed && <span>{item.label}</span>}
      {item.badge && !isCollapsed && (
        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-blue text-white text-xs font-bold px-1">
          {item.badge}
        </span>
      )}
    </Link>
  )
}

export function Sidebar({ className }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const { logout } = useAuthStore()

  return (
    <div
      className={cn(
        'flex flex-col h-full glass border-r border-white/[0.06] transition-all duration-300',
        isCollapsed ? 'w-[60px]' : 'w-[240px]',
        className
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          'flex items-center h-16 px-4 border-b border-white/[0.06] shrink-0',
          isCollapsed ? 'justify-center' : 'gap-3'
        )}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-blue shrink-0">
          <span className="text-white font-bold text-sm font-gilroy">F</span>
        </div>
        {!isCollapsed && (
          <div className="flex flex-col">
            <span className="text-white font-bold text-sm font-gilroy leading-tight">
              Flicks Suite
            </span>
            <span className="text-white/40 text-xs font-gilroy">HRMS</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 py-3 px-2">
        <nav className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.label} item={item} isCollapsed={isCollapsed} />
          ))}
        </nav>
      </ScrollArea>

      {/* Bottom actions */}
      <div
        className={cn(
          'border-t border-white/[0.06] p-2 space-y-0.5 shrink-0'
        )}
      >
        <Link
          href="/help"
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded text-sm font-medium font-gilroy text-white/40 hover:text-white/70 hover:bg-white/5 transition-all duration-200',
            isCollapsed && 'justify-center px-2'
          )}
          title={isCollapsed ? 'Help' : undefined}
        >
          <HelpCircle className="h-4 w-4 shrink-0" />
          {!isCollapsed && <span>Help</span>}
        </Link>
        <button
          onClick={logout}
          className={cn(
            'w-full flex items-center gap-3 px-3 py-2 rounded text-sm font-medium font-gilroy text-white/40 hover:text-brand-coral/80 hover:bg-brand-coral/5 transition-all duration-200',
            isCollapsed && 'justify-center px-2'
          )}
          title={isCollapsed ? 'Logout' : undefined}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!isCollapsed && <span>Logout</span>}
        </button>

        {/* Collapse toggle */}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className={cn(
            'w-full flex items-center gap-3 px-3 py-2 rounded text-sm font-medium font-gilroy text-white/30 hover:text-white/60 hover:bg-white/5 transition-all duration-200',
            isCollapsed && 'justify-center px-2'
          )}
        >
          {isCollapsed ? (
            <PanelLeftOpen className="h-4 w-4 shrink-0" />
          ) : (
            <>
              <PanelLeftClose className="h-4 w-4 shrink-0" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
