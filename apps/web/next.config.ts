import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const isProd = process.env.NODE_ENV === 'production'

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
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  // Razorpay Checkout renders its payment UI in an iframe/popup.
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(isProd
    ? [
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        { key: 'Content-Security-Policy', value: PROD_CSP },
      ]
    : []),
]

const config: NextConfig = {
  images: { domains: ['files.flickssuite.com'] },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
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
