import type { Metadata } from 'next'
import Link from 'next/link'
import { LogoMark } from '@/components/proto'

export const metadata: Metadata = {
  title: 'Legal',
}

/**
 * Public, unauthenticated layout for legal / compliance pages
 * (/privacy, /contact). No app shell, no auth gate — these must be
 * reachable by anyone, including data principals exercising DPDP rights.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
        position: 'relative',
      }}
    >
      {/* Glow blobs */}
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div
          style={{
            position: 'absolute',
            top: '-10%',
            left: '-5%',
            width: 480,
            height: 480,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(62,123,250,.16), transparent 70%)',
            filter: 'blur(40px)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: '-10%',
            right: '-5%',
            width: 420,
            height: 420,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(155,123,250,.14), transparent 70%)',
            filter: 'blur(40px)',
          }}
        />
      </div>

      <header
        style={{
          position: 'relative',
          zIndex: 1,
          maxWidth: 820,
          margin: '0 auto',
          padding: '28px 24px 0',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Link
          href="/login"
          style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}
        >
          <LogoMark size={30} />
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Flicks Suite
          </span>
        </Link>
      </header>

      <main
        style={{
          position: 'relative',
          zIndex: 1,
          maxWidth: 820,
          margin: '0 auto',
          padding: '24px 24px 80px',
        }}
      >
        {children}
      </main>
    </div>
  )
}
