'use client'

import { Suspense, useEffect } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { Btn, Icon } from '@/components/proto'
import { useVerifyMagicLinkQuery } from '@/lib/api/queries/use-auth'

function VerifyMagicLinkInner() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const { isLoading, isSuccess, isError, error, data } = useVerifyMagicLinkQuery(token)

  useEffect(() => {
    if (isSuccess) {
      // Platform admins carry a second factor: unenrolled ones have a session
      // and go straight to setup; enrolled ones got a challenge (no session
      // yet), which only the login page's code flow can complete.
      const target = data?.requiresTotpEnrollment
        ? '/totp-setup'
        : data?.requiresTotp
          ? '/login'
          : '/dashboard'
      const timeout = setTimeout(() => {
        window.location.assign(target)
      }, 800)
      return () => clearTimeout(timeout)
    }
  }, [isSuccess, data])

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
