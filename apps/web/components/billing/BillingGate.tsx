'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useBilling } from '@/lib/api/queries/use-billing'

/**
 * D19 — trial & paywall states (PRD v4 §8B.5).
 *
 * BillingBanners: slim banner in normal flow under the topbar — whole-trial
 * countdown (dismissible per day) and the past-due grace countdown.
 *
 * BillingWall: full-screen wall when the workspace is locked (trial expired /
 * grace exhausted / canceled). Single self-subscribe variant: Owner+Admin get
 * the Subscribe CTA; members are told to ask their Owner/Admin. The billing
 * page and profile (data & privacy exports) stay reachable — the server
 * enforces the real lock (402) regardless.
 */

const WALL_ALLOWED = ['/settings/billing', '/profile']

// Local calendar date (en-CA = YYYY-MM-DD) — "dismiss for today" must roll at
// the user's midnight, not 05:30 IST (the UTC boundary).
function localDay() {
  return new Date().toLocaleDateString('en-CA')
}
function dismissKey() {
  return `fs_trial_banner_${localDay()}`
}

/** Whole days until `iso`, by LOCAL calendar date — stable across the day. */
function calendarDaysLeft(iso: string): number {
  const end = new Date(iso)
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.max(0, Math.round((endDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)))
}

export function BillingBanners() {
  const { currentUser } = useAuthStore()
  const billing = useBilling()
  const [dismissed, setDismissed] = useState(true) // assume dismissed until read
  useEffect(() => {
    setDismissed(!!localStorage.getItem(dismissKey()))
  }, [])

  const b = billing.data?.data
  if (!b || b.locked || currentUser?.role === 'FAM') return null
  const canManage = currentUser?.role === 'OWNER' || currentUser?.role === 'HR_ADMIN'

  // Past-due grace: not dismissible — money problems don't snooze.
  if (b.status === 'past_due' && b.grace_ends_at) {
    const days = calendarDaysLeft(b.grace_ends_at)
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 16px',
          background: 'rgba(248,120,107,.12)',
          borderBottom: '1px solid rgba(248,120,107,.3)',
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        <Icon.warn size={14} style={{ color: 'var(--coral)', flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          Your last payment failed — {days} day{days === 1 ? '' : 's'} of access left before the
          workspace goes read-only.
        </span>
        {canManage && (
          <Link href="/settings/billing">
            <Btn kind="primary" size="sm">Fix payment</Btn>
          </Link>
        )}
      </div>
    )
  }

  if (b.status !== 'trialing' || !b.trial_ends_at || dismissed) return null
  const days = calendarDaysLeft(b.trial_ends_at)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        background: 'rgba(254,216,0,.08)',
        borderBottom: '1px solid rgba(254,216,0,.25)',
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      <Icon.zap size={14} style={{ color: 'var(--yellow)', flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        Free trial — {days} day{days === 1 ? '' : 's'} left. ₹499/seat/month after
        {b.coupon ? ` (coupon ${b.coupon.code} applied)` : ''}.
      </span>
      {canManage && (
        <Link href="/settings/billing">
          <Btn kind="primary" size="sm">Subscribe</Btn>
        </Link>
      )}
      <button
        onClick={() => {
          localStorage.setItem(dismissKey(), '1')
          setDismissed(true)
        }}
        title="Hide for today"
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-mute)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon.x size={12} />
      </button>
    </div>
  )
}

export function BillingWall() {
  const { currentUser } = useAuthStore()
  const pathname = usePathname() ?? '/'
  const billing = useBilling()
  // A 402 from ANY page's mutation means we just locked mid-session — refetch
  // immediately so the wall appears without waiting out the staleTime.
  useEffect(() => {
    const onLocked = () => void billing.refetch()
    window.addEventListener('fs:billing-locked', onLocked)
    return () => window.removeEventListener('fs:billing-locked', onLocked)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const b = billing.data?.data
  if (!b?.locked || currentUser?.role === 'FAM') return null
  if (WALL_ALLOWED.some((p) => pathname.startsWith(p))) return null
  const canManage = currentUser?.role === 'OWNER' || currentUser?.role === 'HR_ADMIN'

  const copy =
    b.locked_reason === 'past_due' || b.locked_reason === 'halted'
      ? 'Payments for this workspace have failed and the grace window has passed.'
      : b.locked_reason === 'canceled'
        ? 'The subscription for this workspace has ended.'
        : 'The free trial for this workspace has ended.'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 850,
        background: 'rgba(1,1,13,.78)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: 'rgba(18,18,30,.98)',
          border: '1px solid var(--bord-2)',
          borderRadius: 16,
          boxShadow: '0 32px 80px rgba(0,0,0,.6)',
          padding: '30px 28px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 14,
            background: 'rgba(62,123,250,.12)',
            color: 'var(--blue)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <Icon.lock size={24} />
        </div>
        <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 8 }}>
          {copy}
        </div>
        <p className="t-mute" style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 18 }}>
          Your data is safe and read-only. Subscribe for ₹499/seat/month to pick up right where
          everyone left off{b.seats > 1 ? ` — ${b.seats} billable seats` : ''}.
        </p>
        {canManage ? (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <Link href="/settings/billing">
              <Btn kind="primary">Go to Billing &amp; plan</Btn>
            </Link>
          </div>
        ) : (
          <p style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)' }}>
            Ask your workspace Owner or Admin to subscribe — they&apos;ll see the option under
            Settings → Billing & plan.
          </p>
        )}
      </div>
    </div>
  )
}
