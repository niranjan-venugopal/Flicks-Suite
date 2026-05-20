'use client'

import Link from 'next/link'
import { useAuthStore, roleLabel } from '@/lib/stores/auth.store'
import { useLogout } from '@/lib/api/queries/use-auth'
import { Avatar, Icon } from '@/components/proto'
import { NotificationsBell } from './NotificationsBell'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function Topbar() {
  const { currentUser } = useAuthStore()
  const logoutMutation = useLogout()
  const isFam = currentUser?.role === 'FAM'

  return (
    <header
      style={{
        height: 64,
        padding: '0 28px',
        borderBottom: '1px solid var(--bord)',
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        background: 'rgba(1,1,13,.6)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}
    >
      {/* Left-side space (page header lives inside the page content) */}
      <div style={{ flex: 1, minWidth: 0 }} />

      {/* Search */}
      <div style={{ position: 'relative', width: 280 }}>
        <Icon.search
          size={15}
          style={{
            position: 'absolute',
            left: 12,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-faint)',
            pointerEvents: 'none',
          }}
        />
        <input
          className="input with-icon"
          placeholder={isFam ? 'Search tenants…' : 'Search employees, requests…'}
          style={{ height: 36, fontSize: 12.5, paddingLeft: 35 }}
        />
        <div
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            padding: '2px 6px',
            background: 'var(--surf-2)',
            border: '1px solid var(--bord)',
            borderRadius: 5,
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--text-mute)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          ⌘K
        </div>
      </div>

      {/* Notifications */}
      <NotificationsBell />

      {/* User dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 10px 4px 4px',
              borderRadius: 999,
              background: 'var(--surf-1)',
              border: '1px solid var(--bord)',
              cursor: 'pointer',
              color: 'var(--text)',
            }}
          >
            <Avatar
              name={currentUser?.name ?? ''}
              size="sm"
              src={currentUser?.avatarUrl}
            />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.1 }}>
              <span style={{ fontSize: 12, fontWeight: 800 }}>
                {currentUser?.name ?? 'User'}
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                {roleLabel(currentUser?.role)}
              </span>
            </div>
            <Icon.chevD size={12} style={{ color: 'var(--text-mute)' }} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/profile">Profile</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/settings/notifications">Notifications</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => logoutMutation.mutate()}
            className="text-brand-coral hover:text-brand-coral focus:text-brand-coral"
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
