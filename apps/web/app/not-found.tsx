import type { Metadata } from 'next'
import Link from 'next/link'
import { Btn, LogoMark } from '@/components/proto'

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
}

/**
 * Round P polish — the App Router 404 for every route. Before this existed a
 * mistyped or stale link (an old invoice id, a removed page) showed Next's
 * unstyled "404 | This page could not be found". Proto look, theme tokens
 * only, and a single way out: the dashboard.
 *
 * Server component on purpose (it carries `metadata`, which a client
 * component may not export). Only direct component exports of the proto
 * client modules are rendered here — the `Icon` object is NOT, because a
 * client-reference proxy does not survive property access (`Icon.home`)
 * during prerender; the home glyph is inlined instead.
 */
const HomeGlyph = (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z" />
  </svg>
)

export default function NotFound() {
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
      <div className="glow glow-blue" style={{ top: -220, left: -160, width: 560, height: 560 }} />
      <div className="glow glow-purple" style={{ bottom: -240, right: -180, width: 480, height: 480 }} />

      <div
        className="card"
        data-testid="app-not-found"
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
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--text-faint)',
            marginBottom: 6,
          }}
        >
          404
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 8px' }}>
          We couldn&rsquo;t find that page
        </h1>
        <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-2)', margin: '0 0 22px' }}>
          The link may be out of date, or the record it pointed to has been removed. Head back to
          your dashboard and pick up from there.
        </p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Link href="/dashboard" style={{ textDecoration: 'none' }}>
            <Btn kind="primary" icon={HomeGlyph}>
              Go to dashboard
            </Btn>
          </Link>
          <Link href="/contact" style={{ textDecoration: 'none' }}>
            <Btn kind="ghost">Contact support</Btn>
          </Link>
        </div>
      </div>
    </div>
  )
}
