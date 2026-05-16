'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuthStore, roleLabel, type UserRole } from '@/lib/stores/auth.store'
import { useAdminOverview } from '@/lib/api/queries/use-dashboard'
import { Avatar, Icon, LogoMark, avBg, initials } from '@/components/proto'
import type { IconKey } from '@/components/proto'

// ─── Nav model ─────────────────────────────────────────────────────────────

interface NavChild {
  href: string
  label: string
  badge?: number
}
interface NavItem {
  id: string
  icon: IconKey
  label: string
  href?: string
  badge?: number
  children?: NavChild[]
}
interface NavSection {
  section: 'main' | string
  items: NavItem[]
}

// Admin / Owner nav — used for HR_ADMIN and SUPER_ADMIN.
const ADMIN_NAV: NavSection[] = [
  {
    section: 'main',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'home', href: '/dashboard' },
      { id: 'inbox', label: 'Approvals', icon: 'inbox', href: '/inbox' },
    ],
  },
  {
    section: 'main',
    items: [
      {
        id: 'people',
        label: 'People',
        icon: 'people',
        children: [
          { href: '/employees', label: 'Employees' },
          { href: '/employees/org-chart', label: 'Org chart' },
          { href: '/employees/onboarding', label: 'Onboarding' },
          { href: '/employees/documents', label: 'Documents' },
        ],
      },
      {
        id: 'time',
        label: 'Time',
        icon: 'clock',
        children: [
          { href: '/attendance', label: 'Attendance' },
          { href: '/leave', label: 'Leave' },
          { href: '/timesheets', label: 'Timesheets' },
          { href: '/calendar', label: 'Calendar' },
        ],
      },
      {
        id: 'insights',
        label: 'Insights',
        icon: 'chart',
        children: [
          { href: '/reports', label: 'Reports' },
          { href: '/reports/audit', label: 'Audit log' },
        ],
      },
      { id: 'settings', label: 'Settings', icon: 'cog', href: '/settings' },
    ],
  },
]

// Manager nav — see direct reports + own self-service.
const MANAGER_NAV: NavSection[] = [
  {
    section: 'main',
    items: [
      { id: 'mgr-dashboard', label: 'My team', icon: 'home', href: '/dashboard' },
      { id: 'mgr-inbox', label: 'Approvals', icon: 'inbox', href: '/inbox' },
    ],
  },
  {
    section: 'Team',
    items: [
      { id: 'mgr-team', label: 'Direct reports', icon: 'people', href: '/team' },
      { id: 'mgr-attendance', label: 'Team attendance', icon: 'clock', href: '/team/attendance' },
      { id: 'mgr-leave', label: 'Team leave', icon: 'cal', href: '/team/leave' },
      { id: 'mgr-timesheets', label: 'Team timesheets', icon: 'sheet', href: '/team/timesheets' },
    ],
  },
  {
    section: 'Personal',
    items: [
      { id: 'emp-attendance', label: 'My attendance', icon: 'fingerprint', href: '/attendance' },
      { id: 'emp-leave', label: 'My leave', icon: 'cal', href: '/leave' },
      { id: 'emp-timesheet', label: 'My timesheet', icon: 'sheet', href: '/timesheets' },
      { id: 'emp-profile', label: 'My profile', icon: 'user', href: '/profile' },
    ],
  },
]

// Employee nav — pure self-service.
const EMPLOYEE_NAV: NavSection[] = [
  {
    section: 'main',
    items: [{ id: 'emp-home', label: 'Home', icon: 'home', href: '/dashboard' }],
  },
  {
    section: 'Time',
    items: [
      { id: 'emp-attendance', label: 'Attendance', icon: 'fingerprint', href: '/attendance' },
      { id: 'emp-leave', label: 'Leave', icon: 'cal', href: '/leave' },
      { id: 'emp-timesheet', label: 'Timesheet', icon: 'sheet', href: '/timesheets' },
      { id: 'emp-calendar', label: 'Calendar', icon: 'cal', href: '/calendar' },
    ],
  },
  {
    section: 'Personal',
    items: [
      { id: 'emp-profile', label: 'Profile', icon: 'user', href: '/profile' },
      { id: 'emp-documents', label: 'Documents', icon: 'doc', href: '/documents' },
    ],
  },
]

// FAM nav — Specflicks platform admin. Only SUPER_ADMIN sees this; they
// live entirely under /fam/* and do not see customer-facing surfaces.
const FAM_NAV: NavSection[] = [
  {
    section: 'main',
    items: [
      { id: 'fam-overview', label: 'Overview', icon: 'home', href: '/fam/overview' },
      { id: 'fam-tenants', label: 'Tenants', icon: 'people', href: '/fam/tenants' },
    ],
  },
  {
    section: 'Insights',
    items: [
      { id: 'fam-revenue', label: 'Revenue', icon: 'chart', href: '/fam/revenue' },
      { id: 'fam-funnel', label: 'Signup funnel', icon: 'spark', href: '/fam/funnel' },
      { id: 'fam-usage', label: 'Feature usage', icon: 'tag', href: '/fam/features-usage' },
      { id: 'fam-health', label: 'Tenant health', icon: 'shield', href: '/fam/health' },
    ],
  },
  {
    section: 'Platform',
    items: [
      { id: 'fam-flags', label: 'Feature flags', icon: 'cog', href: '/fam/features' },
      { id: 'fam-verify', label: 'Verification queue', icon: 'success', href: '/fam/verify' },
      { id: 'fam-audit', label: 'Audit log', icon: 'info', href: '/fam/audit' },
    ],
  },
]

function navFor(role: UserRole | undefined): NavSection[] {
  switch (role) {
    case 'SUPER_ADMIN':
      return FAM_NAV
    case 'OWNER':
    case 'HR_ADMIN':
      // OWNER shares HR_ADMIN's nav for now; the prototype's OWNER_NAV
      // variant (with Documents, Calendar, Audit log) lands when those
      // pages exist as real surfaces in Sprint 2.
      return ADMIN_NAV
    case 'MANAGER':
      return MANAGER_NAV
    case 'EMPLOYEE':
    default:
      return EMPLOYEE_NAV
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

export function Sidebar() {
  const { currentUser, currentTenant } = useAuthStore()
  const pathname = usePathname() ?? '/'
  const role = currentUser?.role
  const nav = useMemo(() => navFor(role), [role])

  // Live approvals badge — only meaningful for the *tenant* approver roles.
  // SUPER_ADMIN lives in FAM and has no tenant approvals queue.
  const showApprovalsBadge =
    role === 'HR_ADMIN' || role === 'OWNER' || role === 'MANAGER'
  const overview = useAdminOverview()
  const pendingCount = showApprovalsBadge ? overview.data?.stats?.pendingApprovals ?? 0 : 0

  // Determine which item is active and which parent group to auto-open.
  const activeId = useMemo(() => {
    for (const sec of nav) {
      for (const it of sec.items) {
        if (it.href && pathname === it.href) return it.id
        if (it.children) {
          for (const c of it.children) {
            if (pathname === c.href) return `${it.id}>${c.href}`
          }
        }
      }
    }
    let bestLen = 0
    let bestId = ''
    for (const sec of nav) {
      for (const it of sec.items) {
        if (it.href && pathname.startsWith(it.href) && it.href.length > bestLen) {
          bestLen = it.href.length
          bestId = it.id
        }
        if (it.children) {
          for (const c of it.children) {
            if (pathname.startsWith(c.href) && c.href.length > bestLen) {
              bestLen = c.href.length
              bestId = `${it.id}>${c.href}`
            }
          }
        }
      }
    }
    return bestId
  }, [pathname, nav])

  const parentOfActive = activeId.includes('>') ? activeId.split('>')[0] : null
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (parentOfActive) setOpenGroups((g) => ({ ...g, [parentOfActive!]: true }))
  }, [parentOfActive])

  const isFam = role === 'SUPER_ADMIN'
  const tenantName = isFam
    ? 'Specflicks Platform'
    : currentTenant?.name ?? 'Workspace'
  const tenantPlan = isFam ? 'FAM console' : currentTenant?.plan ?? 'free'

  return (
    <aside
      style={{
        width: 252,
        flexShrink: 0,
        background:
          'linear-gradient(180deg, rgba(255,255,255,.025) 0%, rgba(255,255,255,0) 100%)',
        borderRight: '1px solid var(--bord)',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      {/* Brand */}
      <div
        style={{
          padding: '18px 18px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid var(--bord)',
        }}
      >
        <LogoMark size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Flicks Suite
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-mute)',
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tenantName}
          </div>
        </div>
      </div>

      {/* Workspace switcher (display-only single-tenant for now) */}
      <div style={{ padding: '12px 12px 0' }}>
        <button
          type="button"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 11px',
            borderRadius: 10,
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            cursor: 'pointer',
          }}
        >
          <div className="avatar sm" style={{ background: avBg(tenantName) }}>
            {initials(tenantName)}
          </div>
          <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 800,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {tenantName}
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
              {tenantPlan}
            </div>
          </div>
          <Icon.chevD size={14} style={{ color: 'var(--text-mute)' }} />
        </button>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflow: 'auto', padding: '8px 8px 12px' }}>
        {nav.map((sec, si) => (
          <div key={si} style={{ marginTop: sec.section === 'main' ? 4 : 14 }}>
            {sec.section !== 'main' && (
              <div
                style={{
                  padding: '8px 12px 6px',
                  fontSize: 10,
                  fontWeight: 800,
                  color: 'var(--text-faint)',
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                }}
              >
                {sec.section}
              </div>
            )}
            {sec.items.map((item) => (
              <NavRow
                key={item.id}
                item={item}
                activeId={activeId}
                openGroups={openGroups}
                setOpenGroups={setOpenGroups}
                approvalsBadge={
                  (item.id === 'inbox' || item.id === 'mgr-inbox') && pendingCount > 0
                    ? pendingCount
                    : undefined
                }
              />
            ))}
          </div>
        ))}
      </nav>

      {/* User block */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--bord)' }}>
        <Link
          href="/profile"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 8px',
            borderRadius: 10,
            background: 'transparent',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <Avatar name={currentUser?.name ?? ''} size="sm" src={currentUser?.avatarUrl} />
          <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 800,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {currentUser?.name ?? 'Guest'}
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
              {roleLabel(role)}
            </div>
          </div>
          <Icon.cog size={14} style={{ color: 'var(--text-mute)' }} />
        </Link>
      </div>
    </aside>
  )
}

// ─── One nav row ───────────────────────────────────────────────────────────

function NavRow({
  item,
  activeId,
  openGroups,
  setOpenGroups,
  approvalsBadge,
}: {
  item: NavItem
  activeId: string
  openGroups: Record<string, boolean>
  setOpenGroups: (fn: (g: Record<string, boolean>) => Record<string, boolean>) => void
  approvalsBadge?: number
}) {
  const hasChildren = !!item.children?.length
  const isOpen =
    openGroups[item.id] || (hasChildren && activeId.startsWith(`${item.id}>`))
  const active = activeId === item.id
  const parentActive = hasChildren && activeId.startsWith(`${item.id}>`)
  const IconCmp = Icon[item.icon]

  const rowStyle = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 12px',
    borderRadius: 9,
    background: active ? 'var(--surf-2)' : 'transparent',
    border: active ? '1px solid var(--bord-2)' : '1px solid transparent',
    color: active || parentActive ? '#fff' : 'var(--text-2)',
    transition: 'all .15s',
    marginBottom: 1,
    fontSize: 13,
    fontWeight: active || parentActive ? 800 : 600,
    letterSpacing: '-0.01em',
    textAlign: 'left' as const,
    position: 'relative' as const,
    textDecoration: 'none',
  }

  const badge = approvalsBadge ?? item.badge

  const innerContent = (
    <>
      {active && (
        <div
          style={{
            position: 'absolute',
            left: -8,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 3,
            height: 18,
            borderRadius: '0 3px 3px 0',
            background: 'var(--blue)',
          }}
        />
      )}
      <IconCmp size={17} />
      <span style={{ flex: 1 }}>{item.label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          style={{
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 99,
            background: 'var(--blue)',
            color: '#fff',
            fontSize: 10,
            fontWeight: 800,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {badge}
        </span>
      )}
      {hasChildren && (
        <Icon.chevD
          size={12}
          style={{
            color: 'var(--text-mute)',
            transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform .15s',
          }}
        />
      )}
    </>
  )

  return (
    <div>
      {hasChildren ? (
        <button
          type="button"
          onClick={() => setOpenGroups((g) => ({ ...g, [item.id]: !isOpen }))}
          style={{ ...rowStyle, cursor: 'pointer' }}
        >
          {innerContent}
        </button>
      ) : (
        <Link href={item.href ?? '#'} style={rowStyle}>
          {innerContent}
        </Link>
      )}

      {hasChildren && isOpen && (
        <div
          style={{
            paddingLeft: 24,
            marginBottom: 4,
            borderLeft: '1px solid var(--bord)',
            marginLeft: 18,
            marginTop: 1,
          }}
        >
          {item.children!.map((c) => {
            const cActive = activeId === `${item.id}>${c.href}`
            return (
              <Link
                key={c.href}
                href={c.href}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  borderRadius: 7,
                  background: cActive ? 'var(--surf-2)' : 'transparent',
                  border: cActive ? '1px solid var(--bord-2)' : '1px solid transparent',
                  color: cActive ? '#fff' : 'var(--text-2)',
                  fontSize: 12,
                  fontWeight: cActive ? 800 : 600,
                  letterSpacing: '-0.01em',
                  textDecoration: 'none',
                  marginBottom: 1,
                }}
              >
                <span style={{ flex: 1 }}>{c.label}</span>
                {c.badge !== undefined && c.badge > 0 && (
                  <span
                    style={{
                      minWidth: 16,
                      height: 16,
                      padding: '0 4px',
                      borderRadius: 99,
                      background: 'var(--coral)',
                      color: '#fff',
                      fontSize: 9.5,
                      fontWeight: 800,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {c.badge}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
