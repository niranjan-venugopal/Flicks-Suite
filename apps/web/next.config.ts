import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const isProd = process.env.NODE_ENV === 'production'

// Local live-verification ONLY (Round O): a production build driven by
// Playwright against the API on :4000 and the s3-mock on :9000 needs those
// plain-http origins in the CSP. CSP_ALLOW_LOCALHOST is read at BUILD time and
// is never set in Vercel, so real production is inert — without it the CSP
// below is byte-identical to before.
const allowLocalhost = !!process.env.CSP_ALLOW_LOCALHOST
const localConnect = allowLocalhost
  ? ' http://localhost:4000 ws://localhost:4000 http://127.0.0.1:9000'
  : ''
const localImg = allowLocalhost ? ' http://127.0.0.1:9000 http://localhost:9000' : ''

// Round P (R3): PDF company policies render their 15-minute signed R2 URL in
// an <iframe> (components/policies/PolicyReader). The bucket's public host
// differs per deployment, so it comes from NEXT_PUBLIC_FILES_FRAME_SRC
// (comma-separated origins, read at BUILD time). Unset/empty leaves frame-src
// byte-identical to before — the reader then falls back to "Open PDF".
// A full URL may be pasted (e.g. the API's R2_ENDPOINT, path and trailing
// slash included) — only its origin is kept. The result must still be a bare
// https?://host[:port]: the value is spliced into the CSP header, so a stray
// `;`, space or wildcard must never widen the policy at build time — anything
// else is dropped loudly.
const FRAME_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/
const filesFrameSrc = (process.env.NEXT_PUBLIC_FILES_FRAME_SRC ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .flatMap((entry) => {
    let origin = entry
    try {
      origin = new URL(entry).origin
    } catch {
      // not a URL at all — the pattern below rejects it
    }
    if (FRAME_ORIGIN_RE.test(origin)) return [origin]
    console.warn(
      `[next.config] NEXT_PUBLIC_FILES_FRAME_SRC entry "${entry}" is not an https://host[:port] address — ignored.`,
    )
    return []
  })
  .join(' ')

// Defence-in-depth response headers. The CSP is only enforced in production —
// in dev it would block http://localhost API/websocket calls and Next's HMR.
// script/style allow 'unsafe-inline' (the app uses inline styles throughout and
// Next injects inline bootstrap scripts without a nonce); the value is in
// locking down object/base/form/frame + forcing https for connect/img.
const PROD_CSP = [
  "default-src 'self'",
  // checkout.razorpay.com hosts the Razorpay Checkout script (hosted invoice page).
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https:${localImg}`,
  "font-src 'self' data:",
  `connect-src 'self' https: wss:${localConnect}`,
  // Razorpay Checkout renders its payment UI in an iframe/popup.
  `frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com${filesFrameSrc ? ` ${filesFrameSrc}` : ''}`,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // geolocation=(self): the clock-in geofence check needs the browser API on
  // our own origin; camera/mic stay disabled.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
  ...(isProd
    ? [
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        { key: 'Content-Security-Policy', value: PROD_CSP },
      ]
    : []),
]

const config: NextConfig = {
  // Security audit 2026-10-06: don't advertise the framework (X-Powered-By).
  poweredByHeader: false,
  images: { domains: ['files.flickssuite.com'] },
  // No floating "N" dev-tools badge, ever — production builds never include it,
  // and hiding it in dev too keeps demo/screenshot sessions clean.
  devIndicators: false,
  // Perf: rewrite barrel imports (icons, radix) to per-module paths so route
  // chunks only carry the icons/components they render — faster dev compiles
  // and smaller production bundles.
  experimental: {
    optimizePackageImports: [
      'lucide-react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-select',
      '@radix-ui/react-popover',
    ],
  },
  // Expose the build's commit SHA to the browser bundle so client-side Sentry
  // events carry a release (§9) — Vercel's own SHA isn't NEXT_PUBLIC by default.
  env: {
    NEXT_PUBLIC_SENTRY_RELEASE:
      process.env.NEXT_PUBLIC_SENTRY_RELEASE ??
      process.env.SENTRY_RELEASE ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      '',
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
  // The common Inbox absorbed the PM inbox and the old notifications list —
  // bookmarks and stale links land on the unified page.
  async redirects() {
    return [
      { source: '/pm/inbox', destination: '/inbox', permanent: false },
      { source: '/notifications', destination: '/inbox', permanent: false },
      // /signup is the URL people type; the wizard lives at /onboarding.
      { source: '/signup', destination: '/onboarding', permanent: true },
    ]
  },
}

// Source-map upload only runs where SENTRY_AUTH_TOKEN is set (CI/prod);
// locally withSentryConfig is a thin pass-through. org/project come from
// env so Specflicks' Sentry identifiers aren't hard-coded here.
export default withSentryConfig(config, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  // Observability must never block a deploy — swallow CLI upload errors.
  errorHandler: () => {},
  // Tunnel browser events through a same-origin route to dodge ad-blockers.
  tunnelRoute: '/monitoring',
  disableLogger: true,
})
