'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAuthStore, roleLabel } from '@/lib/stores/auth.store'
import { useLogout } from '@/lib/api/queries/use-auth'
import { Icon } from '@/components/proto'
import { AvatarV4 } from '@/components/media/AvatarV4'
import { PresenceDot } from '@/components/presence/PresenceDot'
import { StatusPicker } from '@/components/presence/StatusPicker'
import { STATUS_META } from '@/components/presence/PresenceDot'
import { useUserPresence, usePresence } from '@/lib/api/queries/use-presence'
import { NotificationsBell } from './NotificationsBell'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function Topbar() {
  const { currentUser } = useAuthStore()
  const logoutMutation = useLogout()
  const isFam = currentUser?.role === 'FAM'
  const [pickerOpen, setPickerOpen] = useState(false)

  // Seed my own presence (the socket keeps it live afterwards).
  usePresence(currentUser?.id ? [currentUser.id] : [])
  const presence = useUserPresence(currentUser?.id)
  const resolved = presence.status ?? 'offline'

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

      {/* User dropdown (D8/D10-R menu: status → profile/settings/feedback → sign out) */}
      <div style={{ position: 'relative' }}>
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
              <AvatarV4
                name={currentUser?.name ?? ''}
                size={26}
                src={currentUser?.avatarUrl}
                presence={resolved}
                ring="var(--surf-1)"
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
          <DropdownMenuContent align="end" className="w-56">
            {/* Status header — resolved presence + message */}
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <AvatarV4
                name={currentUser?.name ?? ''}
                size={34}
                src={currentUser?.avatarUrl}
                presence={resolved}
                ring="var(--surf-1)"
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800 }}>{currentUser?.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
                  <PresenceDot status={resolved} size={7} ring="transparent" />
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {STATUS_META[resolved].label}
                  </span>
                </div>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setPickerOpen(true)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <PresenceDot status="busy" size={9} ring="transparent" /> Set a status…
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/profile">My profile</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">Settings</Link>
            </DropdownMenuItem>
            {/* "Send feedback" lands here in Sprint 20 (D10-R) */}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => logoutMutation.mutate()}
              className="text-brand-coral hover:text-brand-coral focus:text-brand-coral"
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* D8 status picker — anchored below the chip */}
        {pickerOpen && (
          <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 80 }}>
            <StatusPicker onClose={() => setPickerOpen(false)} />
          </div>
        )}
      </div>
    </header>
  )
}
