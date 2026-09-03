'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { Btn, Icon } from '@/components/proto'
import {
  usePeekMagicLinkQuery,
  useConsumeMagicLink,
  useRecoverMagicLink,
  useCompleteTotp,
} from '@/lib/api/queries/use-auth'
import { useToast } from '@/components/ui/use-toast'

// Round H — peek first (never consumes), then:
//  • GUEST invite links (founder decision) show an explicit Continue button —
//    corporate mail security (Outlook / Defender Safe Links, Google link
//    scanning) opens links at delivery time and used to burn the single-use
//    token before the invitee clicked ("already been used" on the first click).
//  • Everyone else keeps the one-click sign-in: the page consumes on load.
// Either way a burned or expired link recovers into a fresh sign-in code for
// the same address instead of dead-ending on "Back to sign in".
function VerifyMagicLinkInner() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const { toast } = useToast()

  const peek = usePeekMagicLinkQuery(token)
  const consume = useConsumeMagicLink()
  const recover = useRecoverMagicLink()
  const completeTotp = useCompleteTotp()
  const [totpCode, setTotpCode] = useState('')

  const data = consume.data
  const requiresTotp = Boolean(consume.isSuccess && data?.requiresTotp && data?.challengeToken)

  // One-click path: a ready link that does NOT need the guest click signs in
  // on load, exactly as before. Fired once (the backend's 60s idempotency
  // window also absorbs a StrictMode double effect).
  const autoFired = useRef(false)
  useEffect(() => {
    if (!token || autoFired.current) return
    if (peek.data?.status === 'ready' && !peek.data.requiresClick) {
      autoFired.current = true
      consume.mutate({ token })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek.data, token])

  useEffect(() => {
    if (consume.isSuccess && !requiresTotp) {
      const target = data?.requiresTotpEnrollment ? '/totp-setup' : '/dashboard'
      const timeout = setTimeout(() => {
        window.location.assign(target)
      }, 800)
      return () => clearTimeout(timeout)
    }
  }, [consume.isSuccess, requiresTotp, data])

  const handleContinue = () => {
    if (!token || consume.isPending) return
    consume.mutate({ token })
  }

  const handleRecover = async () => {
    if (!token || recover.isPending) return
    try {
      const { email } = await recover.mutateAsync({ token })
      window.location.assign(`/login?email=${encodeURIComponent(email)}&sent=1`)
    } catch {
      toast({
        title: 'Could not send a code',
        description: 'Please sign in with your email address instead.',
        variant: 'destructive',
      })
    }
  }

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(totpCode)) {
      toast({ title: 'Enter the 6-digit code', variant: 'destructive' })
      return
    }
    try {
      await completeTotp.mutateAsync({ challengeToken: data!.challengeToken!, code: totpCode })
      window.location.assign('/fam/overview')
    } catch {
      toast({
        title: 'Invalid authentication code',
        description: 'Check your authenticator app and try again.',
        variant: 'destructive',
      })
      setTotpCode('')
    }
  }

  const iconWrap = (color: string, bg: string, node: React.ReactNode) => (
    <div
      style={{
        width: 60, height: 60, margin: '0 auto 16px', borderRadius: 16,
        background: bg, border: `1px solid ${bg.replace('.12', '.3')}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', color,
      }}
    >
      {node}
    </div>
  )

  const subtle: React.CSSProperties = {
    fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 22,
  }

  // The link was opened before (usually by a mail-security scanner) or has
  // expired — offer the recovery path rather than a dead end.
  const renderRecover = (title: string, body: string) => (
    <div style={{ textAlign: 'center' }}>
      {iconWrap('var(--coral)', 'rgba(248,120,107,.12)', <Icon.warn size={26} />)}
      <div className="t-h2" style={{ marginBottom: 8 }}>{title}</div>
      <div style={subtle}>{body}</div>
      <Btn kind="primary" style={{ width: '100%', height: 46 }} disabled={recover.isPending} onClick={() => void handleRecover()}>
        {recover.isPending ? 'Sending…' : 'Email me a sign-in code'}
      </Btn>
      <Link href="/login" style={{ display: 'block', marginTop: 12, fontSize: 12.5, fontWeight: 700, color: 'var(--text-mute)' }}>
        Back to sign in
      </Link>
    </div>
  )

  const renderState = () => {
    if (!token) {
      return (
        <div style={{ textAlign: 'center' }}>
          {iconWrap('var(--coral)', 'rgba(248,120,107,.12)', <Icon.warn size={26} />)}
          <div className="t-h2" style={{ marginBottom: 8 }}>Missing token</div>
          <div style={subtle}>This link is missing the verification token. Please request a new one.</div>
          <Link href="/login" style={{ display: 'block' }}>
            <Btn kind="primary" style={{ width: '100%', height: 46 }}>Back to sign in</Btn>
          </Link>
        </div>
      )
    }

    const status = peek.isError ? 'invalid' : peek.data?.status ?? 'invalid'
    const email = peek.data?.email
    const oneClick = status === 'ready' && !peek.data?.requiresClick

    // Checking the link, or signing a non-guest in automatically.
    if (peek.isLoading || (oneClick && !consume.isError && !consume.isSuccess)) {
      return (
        <div style={{ textAlign: 'center' }}>
          {iconWrap('var(--blue)', 'rgba(62,123,250,.12)', <Icon.refresh size={26} />)}
          <div className="t-h2" style={{ marginBottom: 8 }}>
            {peek.isLoading ? 'Checking your link' : 'Verifying your link'}
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>
            {peek.isLoading ? 'One moment…' : 'Hang tight while we sign you in securely…'}
          </div>
        </div>
      )
    }

    if (status === 'invalid') {
      return (
        <div style={{ textAlign: 'center' }}>
          {iconWrap('var(--coral)', 'rgba(248,120,107,.12)', <Icon.warn size={26} />)}
          <div className="t-h2" style={{ marginBottom: 8 }}>Link expired or invalid</div>
          <div style={subtle}>This sign-in link isn&apos;t valid. Sign in with your email address to get a fresh code.</div>
          <Link href="/login" style={{ display: 'block' }}>
            <Btn kind="primary" style={{ width: '100%', height: 46 }}>Back to sign in</Btn>
          </Link>
        </div>
      )
    }

    if (status === 'expired') {
      return renderRecover(
        'This link has expired',
        `Sign-in links stop working after a while. We can email a fresh 6-digit code to ${email ?? 'your address'} right now.`,
      )
    }

    // Consumed before we got here, or our own consume attempt lost a race.
    if (status === 'consumed' || consume.isError) {
      return renderRecover(
        'This link has already been opened',
        `Email security tools often open links before you do, which uses them up. No problem — we can email a fresh 6-digit code to ${email ?? 'your address'}.`,
      )
    }

    if (requiresTotp) {
      return (
        <div>
          <div style={{ textAlign: 'center' }}>
            {iconWrap('var(--purple)', 'rgba(155,123,250,.12)', <Icon.shield size={26} />)}
            <div className="t-h2" style={{ marginBottom: 8 }}>Two-factor check</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', marginBottom: 18 }}>
              Enter the 6-digit code from your authenticator app to finish signing in.
            </div>
          </div>
          <form onSubmit={handleTotpSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <input
              className="input"
              inputMode="numeric"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              autoFocus
              style={{ textAlign: 'center', letterSpacing: '0.5em', fontSize: 20, height: 56 }}
            />
            <Btn kind="primary" type="submit" disabled={completeTotp.isPending} style={{ height: 48, fontSize: 14 }}>
              {completeTotp.isPending ? 'Verifying…' : 'Verify'}
            </Btn>
          </form>
        </div>
      )
    }

    if (consume.isSuccess) {
      return (
        <div style={{ textAlign: 'center' }}>
          {iconWrap('var(--green)', 'rgba(39,210,128,.12)', <Icon.check size={26} />)}
          <div className="t-h2" style={{ marginBottom: 8 }}>You&apos;re in</div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>
            Taking you to your workspace…
          </div>
        </div>
      )
    }

    // status === 'ready' for a GUEST invite: the explicit human step that
    // scanners never take.
    return (
      <div style={{ textAlign: 'center' }}>
        {iconWrap('var(--blue)', 'rgba(62,123,250,.12)', <Icon.mail size={26} />)}
        <div className="t-h2" style={{ marginBottom: 8 }}>Accept your invite</div>
        <div style={subtle}>
          Continue as <strong style={{ color: '#fff' }}>{email}</strong>
        </div>
        <Btn
          kind="primary"
          style={{ width: '100%', height: 46 }}
          disabled={consume.isPending}
          iconRight={<Icon.arrow size={16} />}
          onClick={handleContinue}
        >
          {consume.isPending ? 'Signing you in…' : 'Continue'}
        </Btn>
        <Link href="/login" style={{ display: 'block', marginTop: 12, fontSize: 12.5, fontWeight: 700, color: 'var(--text-mute)' }}>
          Not you? Sign in with a different email
        </Link>
      </div>
    )
  }

  return (
    <AuthLayout>
      <AuthCard>{renderState()}</AuthCard>
    </AuthLayout>
  )
}

// useSearchParams() forces this route into client-side rendering, which Next's
// static export step rejects unless the consumer is inside a Suspense boundary.
export default function VerifyMagicLinkPage() {
  return (
    <Suspense
      fallback={
        <AuthLayout>
          <AuthCard>
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <div className="t-h2" style={{ marginBottom: 8 }}>Checking your link</div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>
                One moment…
              </div>
            </div>
          </AuthCard>
        </AuthLayout>
      }
    >
      <VerifyMagicLinkInner />
    </Suspense>
  )
}
