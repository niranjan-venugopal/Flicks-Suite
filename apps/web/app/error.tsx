'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import * as Sentry from '@sentry/nextjs'
import { Btn, Icon, LogoMark } from '@/components/proto'

/**
 * Round P polish — the App Router error boundary for every route below the
 * root layout. Before this existed an unhandled render error showed Next's
 * bare "Application error" screen with no way back. Proto look, theme
 * tokens only (works in light and dark), Retry re-renders the segment via
 * reset(), and the dashboard link is the way out when retrying cannot help.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Keep the stack in the console for support — the page shows only the
    // short digest so nothing internal leaks into a screenshot. A React
    // error boundary swallows the throw before Sentry's global handler sees
    // it, so report it explicitly (the SDK's documented error.tsx pattern);
    // a no-op without a DSN, and sentry.client.config scrubs PII.
    console.error(error)
    try {
      Sentry.captureException(error)
    } catch {
      /* reporting must never break the fallback itself */
    }
  }, [error])

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        position: 'relative',
        overflow: 'hidden',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <div className="glow glow-coral" style={{ top: -220, right: -180, width: 520, height: 520 }} />
      <div className="glow glow-blue" style={{ bottom: -240, left: -160, width: 560, height: 560 }} />

      <div
        className="card"
        role="alert"
        data-testid="app-error"
        style={{ width: '100%', maxWidth: 460, padding: '36px 36px 32px', position: 'relative', zIndex: 1 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
          <LogoMark size={32} />
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: '-0.02em' }}>Flicks Suite</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>by Specflicks</div>
          </div>
        </div>

        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgb(var(--coral-rgb) / .12)',
            color: 'var(--coral)',
            marginBottom: 16,
          }}
        >
          <Icon.warn size={22} />
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 8px' }}>
          Something went wrong
        </h1>
        <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-2)', margin: '0 0 20px' }}>
          This page hit an unexpected error. Your data is safe — try again, or head back to the
          dashboard. If it keeps happening, email{' '}
          <a href="mailto:support@flickssuite.com" style={{ color: 'var(--blue)', fontWeight: 700 }}>
            support@flickssuite.com
          </a>
          {error.digest ? ' and quote the reference below.' : '.'}
        </p>

        {error.digest && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              color: 'var(--text-mute)',
              padding: '8px 12px',
              borderRadius: 8,
              background: 'var(--surf-1)',
              border: '1px solid var(--bord)',
              marginBottom: 20,
            }}
          >
            Reference: {error.digest}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Btn kind="primary" icon={<Icon.refresh size={14} />} onClick={() => reset()}>
            Retry
          </Btn>
          <Link href="/dashboard" style={{ textDecoration: 'none' }}>
            <Btn kind="secondary" icon={<Icon.home size={14} />}>
              Go to dashboard
            </Btn>
          </Link>
        </div>
      </div>
    </div>
  )
}
