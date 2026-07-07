'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuthStore, type UserRole } from '@/lib/stores/auth.store'
import { useAdminOverview } from '@/lib/api/queries/use-dashboard'
import { useMyCompanies, type ModuleGrant } from '@/lib/api/queries/use-members'
import { CompanySwitcher } from '@/components/invoicing/CompanySwitcher'
import { Icon, LogoMark } from '@/components/proto'
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

// Admin / Owner nav — used for HR_ADMIN and OWNER.
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
        id: 'invoicing',
        label: 'Invoicing',
        icon: 'wallet',
        // Exact INV_SUBITEMS order/labels from the v3 prototype (shell-v3.jsx).
        children: [
          { href: '/invoicing', label: 'Overview' },
          { href: '/invoicing/invoices', label: 'Invoices' },
          { href: '/invoicing/quotes', label: 'Quotes / Estimates' },
          { href: '/invoicing/recurring', label: 'Recurring' },
          { href: '/invoicing/customers', label: 'Customers' },
          { href: '/invoicing/items', label: 'Items / Catalogue' },
          { href: '/invoicing/notes', label: 'Credit & Debit notes' },
          { href: '/invoicing/payments', label: 'Payments' },
          { href: '/invoicing/reports', label: 'Reports' },
          { href: '/invoicing/settings', label: 'Settings' },
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

// FAM nav — Specflicks platform admin. Only FAM sees this; they
// live entirely under /fam/* and do not see customer-facing surfaces.
// Mirrors the prototype's NAV_BY_ROLE.FAM: a flat "Overview" row up top,
// then three two-level collapsible groups (Tenants / Revenue / Platform).
const FAM_NAV: NavSection[] = [
  {
    section: 'main',
    items: [
      { id: 'fam-overview', label: 'Overview', icon: 'home', href: '/fam/overview' },
    ],
  },
  {
    section: 'main',
    items: [
      {
        id: 'fam-tenants-group',
        label: 'Tenants',
        icon: 'building',
        children: [
          { href: '/fam/tenants',  label: 'All tenants' },
          { href: '/fam/verify',   label: 'Verification queue' },
          { href: '/fam/cohorts',  label: 'Beta cohorts' },
        ],
      },
      {
        id: 'fam-revenue-group',
        label: 'Revenue',
        icon: 'trend',
        children: [
          { href: '/fam/revenue',         label: 'MRR & ARR' },
          { href: '/fam/coupons',         label: 'Coupons' },
          { href: '/fam/funnel',          label: 'Signup funnel' },
          { href: '/fam/features-usage',  label: 'Feature usage' },
          { href: '/fam/feedback',        label: 'Feedback & NPS' },
        ],
      },
      {
        id: 'fam-invoicing-group',
        label: 'Invoicing',
        icon: 'wallet',
        children: [
          { href: '/fam/invoicing', label: 'Modules & auditors' },
        ],
      },
      {
        id: 'fam-platform-group',
        label: 'Platform',
        icon: 'zap',
        children: [
          { href: '/fam/health',   label: 'System health' },
          { href: '/fam/features', label: 'Feature flags' },
          { href: '/fam/audit',    label: 'Audit log' },
        ],
      },
    ],
  },
]

function navFor(role: UserRole | undefined): NavSection[] {
  switch (role) {
    case 'FAM':
      return FAM_NAV
    case 'OWNER':
    case 'HR_ADMIN':
    case 'FINANCE':
      // Owner/Admin/Finance get the full sidebar incl. the complete Invoicing
      // section (they have full invoicing access by role).
      return ADMIN_NAV
    case 'MANAGER':
      return MANAGER_NAV
    case 'EMPLOYEE':
    default:
      return EMPLOYEE_NAV
  }
}

// Build the Invoicing sub-items a grant set unlocks (PRD §3 grant model). Used
// for Auditors AND for Manager/Employee whom the Owner has granted invoicing
// access — the same membership_grants mechanism drives both.
function invoicingChildrenFromGrants(grants: ModuleGrant[]): NavChild[] {
  const invoicing = grants.find((g) => g.module === 'invoicing')
  const reports = grants.find((g) => g.module === 'reports')
  const caps = invoicing?.capabilities ?? {}
  const children: NavChild[] = []
  if (invoicing && invoicing.access_level !== 'none') {
    children.push(
      { href: '/invoicing', label: 'Overview' },
      { href: '/invoicing/invoices', label: 'Invoices' },
    )
  }
  // 'edit' implies the create/manage surfaces; capabilities widen 'view'.
  if (invoicing?.access_level === 'edit') {
    children.push({ href: '/invoicing/quotes', label: 'Quotes / Estimates' })
  }
  if (invoicing?.access_level === 'edit' || caps.manage_customers) {
    children.push({ href: '/invoicing/customers', label: 'Customers' })
  }
  if (invoicing?.access_level === 'edit') {
    children.push({ href: '/invoicing/items', label: 'Items / Catalogue' })
  }
  if (caps.record_payments) children.push({ href: '/invoicing/payments', label: 'Payments' })
  if (reports && reports.access_level !== 'none') {
    children.push({ href: '/invoicing/reports', label: 'Reports' })
  }
  return children
}

// Auditor nav (prototype ROLE_CFG.Auditor): the cross-company My Companies
// surface + the grant-driven invoicing sub-items for the active company.
function auditorNavFor(grants: ModuleGrant[]): NavSection[] {
  const children = invoicingChildrenFromGrants(grants)
  return [
    {
      section: 'main',
      items: [
        { id: 'my-companies', label: 'My companies', icon: 'grid', href: '/my-companies' },
      ],
    },
    ...(children.length
      ? [{ section: 'main', items: [{ id: 'invoicing', label: 'Invoicing', icon: 'wallet' as IconKey, children }] }]
      : []),
  ]
}

// Manager/Employee see Invoicing ONLY if the Owner granted it (membership_grants).
// Their base HRMS nav stays; the granted invoicing section is appended.
function withGrantedInvoicing(base: NavSection[], grants: ModuleGrant[]): NavSection[] {
  const children = invoicingChildrenFromGrants(grants)
  if (!children.length) return base
  return [
    ...base,
    { section: 'main', items: [{ id: 'invoicing', label: 'Invoicing', icon: 'wallet' as IconKey, children }] },
  ]
}

// ─── Component ─────────────────────────────────────────────────────────────

export function Sidebar() {
  const { currentUser, currentTenant } = useAuthStore()
  const pathname = usePathname() ?? '/'
  const role = currentUser?.role

  // Grant-driven roles read the active company's grants from the same
  // /me/companies payload the switcher uses: Auditors always, and
  // Manager/Employee so the Owner can grant them invoicing access.
  const grantDriven = role === 'AUDITOR' || role === 'MANAGER' || role === 'EMPLOYEE'
  const myCompanies = useMyCompanies(grantDriven)
  const activeGrants = useMemo<ModuleGrant[]>(() => {
    if (!grantDriven) return []
    return (
      myCompanies.data?.data.find((c) => c.tenantId === currentUser?.tenantId)
        ?.grants ?? []
    )
  }, [grantDriven, myCompanies.data, currentUser?.tenantId])

  const nav = useMemo(() => {
    if (role === 'AUDITOR') return auditorNavFor(activeGrants)
    if (role === 'MANAGER') return withGrantedInvoicing(MANAGER_NAV, activeGrants)
    if (role === 'EMPLOYEE') return withGrantedInvoicing(EMPLOYEE_NAV, activeGrants)
    return navFor(role)
  }, [role, activeGrants])

  // Live approvals badge — only meaningful for the *tenant* approver roles.
  // FAM admins live under /fam/* and have no tenant approvals queue.
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

  // Collapsible rail (prototype shell-v3: 248px ↔ 72px). Persisted locally.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('sidebar-collapsed') === '1') {
      setCollapsed(true)
    }
  }, [])
  const toggleCollapsed = (next: boolean) => {
    setCollapsed(next)
    if (typeof window !== 'undefined') localStorage.setItem('sidebar-collapsed', next ? '1' : '0')
  }
  useEffect(() => {
    if (parentOfActive) setOpenGroups((g) => ({ ...g, [parentOfActive!]: true }))
  }, [parentOfActive])

  const isFam = role === 'FAM'
  // Brand area: customer workspaces see the Flicks Suite mark with the
  // tenant name underneath; FAM operators see "FAM Console · Specflicks
  // Internal" since they're not inside any single tenant.
  const brandTitle = isFam ? 'FAM Console' : 'Flicks Suite'
  const brandSub = isFam
    ? 'Specflicks Internal · admin.flickssuite.com'
    : currentTenant?.name ?? 'Workspace'

  return (
    <aside
      style={{
        width: collapsed ? 72 : 252,
        transition: 'width .2s',
        flexShrink: 0,
        // Match the prototype's FAM sidebar: a darker purple-tinted
        // gradient that distinguishes platform admin from tenant chrome.
        background: isFam
          ? 'linear-gradient(180deg, #0d0a18 0%, #01010D 100%)'
          : 'linear-gradient(180deg, rgba(255,255,255,.025) 0%, rgba(255,255,255,0) 100%)',
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
          padding: collapsed ? '18px 0 14px' : '18px 18px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid var(--bord)',
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}
      >
        <LogoMark size={32} />
        {!collapsed && (
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: '-0.02em' }}>
            {brandTitle}
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
            {brandSub}
          </div>
        </div>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={() => toggleCollapsed(true)}
            title="Collapse sidebar"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-faint)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <Icon.chevL size={15} />
          </button>
        )}
      </div>

      {/* Workspace / company switcher — hidden for FAM, who isn't inside any
          tenant. Multi-company users (auditors, multi-workspace owners) get
          the live dropdown; everyone else the static chip. */}
      {!isFam && collapsed && <CompanySwitcher collapsed />}
      {collapsed && (
        <button
          type="button"
          onClick={() => toggleCollapsed(false)}
          title="Expand sidebar"
          style={{
            margin: '10px auto 0',
            width: 30,
            height: 30,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-mute)',
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            cursor: 'pointer',
          }}
        >
          <Icon.chevR size={15} />
        </button>
      )}
      {!isFam && !collapsed && <CompanySwitcher />}

      {/* Nav */}
      <nav style={{ flex: 1, overflow: 'auto', padding: collapsed ? '8px 10px 12px' : '8px 8px 12px' }}>
        {nav.map((sec, si) => (
          <div key={si} style={{ marginTop: sec.section === 'main' ? 4 : 14 }}>
            {sec.section !== 'main' && !collapsed && (
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
                collapsed={collapsed}
                onExpand={() => toggleCollapsed(false)}
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

      {/* No bottom user block — profile + settings live in the topbar avatar menu */}
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
  collapsed = false,
  onExpand,
}: {
  item: NavItem
  activeId: string
  openGroups: Record<string, boolean>
  setOpenGroups: (fn: (g: Record<string, boolean>) => Record<string, boolean>) => void
  approvalsBadge?: number
  collapsed?: boolean
  onExpand?: () => void
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
    padding: collapsed ? '10px 0' : '9px 12px',
    justifyContent: collapsed ? ('center' as const) : ('flex-start' as const),
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
      {!collapsed && <span style={{ flex: 1 }}>{item.label}</span>}
      {!collapsed && badge !== undefined && badge > 0 && (
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
      {hasChildren && !collapsed && (
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
          title={collapsed ? item.label : undefined}
          onClick={() => {
            // Prototype behaviour: clicking a group on the collapsed rail
            // expands the sidebar and opens the group.
            if (collapsed) {
              onExpand?.()
              setOpenGroups((g) => ({ ...g, [item.id]: true }))
              return
            }
            setOpenGroups((g) => ({ ...g, [item.id]: !isOpen }))
          }}
          style={{ ...rowStyle, cursor: 'pointer' }}
        >
          {innerContent}
        </button>
      ) : (
        <Link href={item.href ?? '#'} title={collapsed ? item.label : undefined} style={rowStyle}>
          {innerContent}
        </Link>
      )}

      {hasChildren && isOpen && !collapsed && (
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
