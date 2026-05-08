'use client'

import { Bell, ChevronDown, Search } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/lib/stores/auth.store'
import { getInitials } from '@/lib/utils'
import Link from 'next/link'

export function Topbar() {
  const { currentUser, currentTenant, logout } = useAuthStore()

  return (
    <header className="h-16 border-b border-white/[0.06] flex items-center justify-between px-6 glass shrink-0">
      {/* Left: Search */}
      <div className="flex items-center gap-3 flex-1 max-w-md">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30" />
          <input
            placeholder="Search employees, leaves, reports..."
            className="w-full h-9 rounded bg-white/5 border border-white/[0.06] pl-9 pr-3 text-sm text-white placeholder:text-white/30 font-gilroy focus:outline-none focus:border-brand-blue/40 focus:bg-white/[0.07] transition-all duration-200"
          />
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-3">
        {/* Notifications */}
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-4 w-4 text-white/60" />
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-brand-blue" />
        </Button>

        {/* Tenant name */}
        {currentTenant && (
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded bg-white/5 border border-white/[0.06]">
            <div className="h-2 w-2 rounded-full bg-brand-green animate-pulse" />
            <span className="text-sm font-medium text-white/70 font-gilroy">
              {currentTenant.name}
            </span>
          </div>
        )}

        {/* User avatar / dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors">
              <Avatar className="h-8 w-8">
                <AvatarImage src={currentUser?.avatarUrl} />
                <AvatarFallback>
                  {currentUser ? getInitials(currentUser.name) : 'U'}
                </AvatarFallback>
              </Avatar>
              <div className="hidden md:flex flex-col items-start">
                <span className="text-sm font-semibold text-white font-gilroy leading-none">
                  {currentUser?.name ?? 'User'}
                </span>
                <span className="text-xs text-white/40 font-gilroy capitalize">
                  {currentUser?.role?.toLowerCase() ?? 'member'}
                </span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-white/40 hidden md:block" />
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
              onClick={logout}
              className="text-brand-coral hover:text-brand-coral focus:text-brand-coral"
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
