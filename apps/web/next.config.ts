import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const config: NextConfig = {
  images: { domains: ['files.flickssuite.com'] },
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
