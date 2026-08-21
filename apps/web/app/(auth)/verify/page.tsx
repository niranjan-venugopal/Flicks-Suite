'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { Btn, Icon } from '@/components/proto'
import { useVerifyMagicLinkQuery, useCompleteTotp } from '@/lib/api/queries/use-auth'
import { useToast } from '@/components/ui/use-toast'

function VerifyMagicLinkInner() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const { isLoading, isSuccess, isError, error, data } = useVerifyMagicLinkQuery(token)
  const completeTotp = useCompleteTotp()
  const { toast } = useToast()
  const [totpCode, setTotpCode] = useState('')

  // Enrolled platform admins get a CHALLENGE from the magic link (no session
  // yet) — completed inline below. Unenrolled ones have a session and go to
  // setup; everyone else goes straight in.
  const requiresTotp = Boolean(isSuccess && data?.requiresTotp && data?.challengeToken)

  useEffect(() => {
    if (isSuccess && !requiresTotp) {
      const target = data?.requiresTotpEnrollment ? '/totp-setup' : '/dashboard'
      const timeout = setTimeout(() => {
        window.location.assign(target)
      }, 800)
      return () => clearTimeout(timeout)
    }
  }, [isSuccess, requiresTotp, data])

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

  const renderState = () => {
    if (!token || isError) {
      return (
        <div style={{ textAlign: 'center' }}>
          {iconWrap('var(--coral)', 'rgba(248,120,107,.12)', <Icon.warn size={26} />)}
          <div className="t-h2" style={{ marginBottom: 8 }}>
            {!token ? 'Missing token' : 'Link expired or invalid'}
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 22 }}>
            {!token
              ? 'This link is missing the verification token. Please request a new one.'
              : error instanceof Error
                ? error.message
                : 'This magic link is no longer valid. Request a new one to continue.'}
          </div>
          <Link href="/login" style={{ display: 'block' }}>
            <Btn kind="primary" style={{ width: '100%', height: 46 }}>Back to sign in</Btn>
          </Link>
        </div>
      )
    }

    if (isLoading) {
      return (
        <div style={{ textAlign: 'center' }}>
          {iconWrap('var(--blue)', 'rgba(62,123,250,.12)', <Icon.refresh size={26} />)}
          <div className="t-h2" style={{ marginBottom: 8 }}>Verifying your link</div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>
            Hang tight while we sign you in securely…
          </div>
        </div>
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

    if (isSuccess) {
      return (
        <div style={{ textAlign: 'center' }}>
          {iconWrap('var(--green)', 'rgba(39,210,128,.12)', <Icon.check size={26} />)}
          <div className="t-h2" style={{ marginBottom: 8 }}>You&apos;re in</div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>
            Redirecting to your dashboard…
          </div>
        </div>
      )
    }

    return null
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
              <div className="t-h2" style={{ marginBottom: 8 }}>Verifying your link</div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>
                Hang tight…
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
