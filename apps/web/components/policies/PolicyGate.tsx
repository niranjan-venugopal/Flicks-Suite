'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { LogoMark } from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCurrentUser } from '@/lib/api/queries/use-auth'
import { useMyConsents } from '@/lib/api/queries/use-consent'
import { usePendingPolicies, POLICIES_KEY } from '@/lib/api/queries/use-policies'
import { isPolicyReadable, PolicyReader } from './PolicyReader'

/**
 * Round P (R3) — blocking "read & agree" interstitial for company policies.
 * Structurally a copy of components/consent/ReacceptanceGate: a fixed
 * overlay in the 1300–1399 blocking band that cannot be dismissed. It shows
 * the caller's pending policies one at a time (oldest published first, the
 * API's order) and unmounts after the last acknowledgement.
 *
 * Eligibility: authenticated, /me resolved, membership role is a standard
 * seat (never guest / auditor / fam / super_admin), not impersonating (a
 * Specflicks admin must never sign on a customer's behalf), and not on a
 * public route. Terms re-acceptance goes first: until the consents ledger
 * has answered, and while it says `requires_reacceptance`, this gate stays
 * out of the way.
 *
 * Never a dead end (house rule 8): a PDF whose signed URL the API could not
 * produce (`file_url: null` — storage down / unconfigured) cannot be read,
 * so it never blocks sign-in. It stays on /policies and on HR's pending
 * roster; this gate re-checks every minute while one is outstanding and
 * picks it up as soon as a URL comes back. Likewise a policy archived or
 * re-targeted while the gate is open: PolicyReader's 404 path re-fetches
 * the pending list, which drops it here.
 */

const EXEMPT_ROLES = new Set(['guest', 'auditor', 'fam', 'super_admin'])
// How often to re-ask /policies/pending while an unreadable PDF is waiting
// for its URL (the gate otherwise only refetches on invalidation).
const UNREADABLE_RECHECK_MS = 60_000

// Defence-in-depth: the (app) layout only wraps signed-in workspace routes,
// but the gate must never paint over a public/legal page if it is ever
// mounted higher up.
const PUBLIC_PREFIXES = [
  '/login',
  '/verify',
  '/totp-setup',
  '/onboarding',
  '/invite',
  '/terms',
  '/privacy',
  '/pay',
  '/i/',
  '/q/',
  '/fam',
]

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`))
}

export function PolicyGate() {
  const pathname = usePathname() ?? '/'
  const { isAuthenticated } = useAuthStore()
  const { data: me } = useCurrentUser()
  const qc = useQueryClient()

  const role = (me?.currentMembership?.role ?? me?.memberships?.[0]?.role ?? '').toLowerCase()
  const isImpersonating = !!me?.impersonatorUserId
  const eligible =
    isAuthenticated &&
    !!me &&
    !!role &&
    !EXEMPT_ROLES.has(role) &&
    !isImpersonating &&
    !isPublicRoute(pathname)

  // Same query key as ReacceptanceGate / TrustDevicePrompt → one request.
  const consents = useMyConsents(eligible)
  const termsDue = !!consents.data?.data?.requires_reacceptance

  const pending = usePendingPolicies(eligible)
  const list = useMemo(() => pending.data?.data ?? [], [pending.data])
  // Only what the member can actually read may block them (see header).
  const readable = useMemo(() => list.filter(isPolicyReadable), [list])
  const hasUnreadable = readable.length !== list.length

  // While an unreadable PDF is pending, re-check for its URL periodically so
  // the gate recovers on its own once storage is back — no reload needed.
  const refetchRef = useRef(pending.refetch)
  refetchRef.current = pending.refetch
  useEffect(() => {
    if (!eligible || !hasUnreadable) return
    const t = window.setInterval(() => void refetchRef.current(), UNREADABLE_RECHECK_MS)
    return () => window.clearInterval(t)
  }, [eligible, hasUnreadable])

  // Acknowledged-in-this-session set: the mutation invalidates ['policies'],
  // but until the refetch lands the server list still contains the policy
  // we just signed — filter it locally so the next one appears immediately
  // (and we never show a signed policy twice).
  const [acked, setAcked] = useState<Set<string>>(() => new Set())
  const remaining = useMemo(
    () => readable.filter((p) => !acked.has(`${p.id}:${p.version}`)),
    [readable, acked],
  )

  // "Policy N of M": hold the total from the first non-empty list so the
  // counter doesn't jump back to "1 of 2" after the refetch shrinks it.
  const totalRef = useRef(0)
  if (remaining.length > 0 && acked.size + remaining.length > totalRef.current) {
    totalRef.current = acked.size + remaining.length
  }

  // Final ack → make every policy surface refetch (the /policies page, the
  // sidebar-driven HR counts) and reset the local session state so a later
  // publish starts a fresh "1 of N".
  const finishedRef = useRef(false)
  useEffect(() => {
    if (acked.size > 0 && remaining.length === 0 && !finishedRef.current) {
      finishedRef.current = true
      void qc.invalidateQueries({ queryKey: [...POLICIES_KEY] })
    }
    if (remaining.length > 0) finishedRef.current = false
  }, [acked.size, remaining.length, qc])

  // Once the server confirms nothing readable is pending, drop the local
  // markers so a policy published later starts a fresh "1 of N". Never reset
  // mid-sequence (the refetch after ack #1 of 2 must still read "Policy 2 of
  // 2"). Unreadable PDFs don't count: they were never part of the sequence.
  useEffect(() => {
    if (acked.size === 0 || readable.length > 0 || pending.isFetching) return
    setAcked(new Set())
    totalRef.current = 0
  }, [readable.length, acked.size, pending.isFetching])

  // Terms first, policies second — and that must hold while /me/consents is
  // still in flight, not only once it has answered. Fall through on an
  // error so a failed consents call can never hide this gate for good.
  const termsUnknown = consents.isPending && !consents.data
  if (!eligible || termsDue || termsUnknown) return null
  const current = remaining[0]
  if (!current) return null

  const position = acked.size + 1
  const total = Math.max(totalRef.current, position)

  return (
    <div
      data-testid="policy-gate"
      style={{
        position: 'fixed',
        inset: 0,
        // Blocking gates live at 1300–1399: above every overlay in the
        // 900–1299 band (round K portals them all to <body>), below --z-float.
        // Same band as the terms gate; that one is simply never mounted at the
        // same time (termsDue above), so terms always comes first.
        zIndex: 1390,
        // Radix modals set pointer-events: none on <body>; this gate is not a
        // Radix layer, so it must re-arm its own subtree or every click dies.
        pointerEvents: 'auto',
        background: 'rgba(var(--scrim-rgb), .72)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 760,
          maxHeight: 'calc(100vh - 40px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surf-pop)',
          border: '1px solid var(--bord-2)',
          borderRadius: 16,
          boxShadow: 'var(--e3)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--bord)',
            flexShrink: 0,
          }}
        >
          <LogoMark size={34} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {total > 1 ? 'Company policies need your agreement' : 'A company policy needs your agreement'}
            </div>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: 'var(--text-mute)',
                fontFamily: 'var(--font-mono)',
                marginTop: 2,
              }}
              data-testid="policy-gate-counter"
            >
              Policy {position} of {total}
            </div>
          </div>
        </div>
        <div style={{ padding: '18px 24px 22px', overflowY: 'auto', minHeight: 0 }}>
          <div className="t-mute" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>
            Please read and agree to continue to your workspace. Your agreement is recorded
            with the policy version and the time you signed.
          </div>
          <PolicyReader
            key={`${current.id}:${current.version}`}
            policy={current}
            onRefetch={() => pending.refetch()}
            onAcknowledged={(res) =>
              setAcked((prev) => {
                const next = new Set(prev)
                next.add(`${res.policy_id}:${res.version}`)
                return next
              })
            }
            testId="policy-gate-reader"
          />
        </div>
      </div>
    </div>
  )
}
