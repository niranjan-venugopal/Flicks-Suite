// Browser-side Sentry. Loaded by Next via instrumentation-client.
// No-op when NEXT_PUBLIC_SENTRY_DSN is unset (local dev).
// Hardened per PRD v4 §9: no PII, no replays, scrubbed payloads.
import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // NEXT_PUBLIC_ prefix required to reach the browser bundle. Vercel's
    // commit SHA isn't auto-exposed client-side, so wire it in the build
    // (next.config env) or set NEXT_PUBLIC_SENTRY_RELEASE explicitly — else
    // client events ship release-less while server events carry the SHA.
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    // §9: never attach request PII (cookies, auth headers, user ip).
    sendDefaultPii: false,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: 0,
    // §9: replays OFF entirely — an HRMS shows salaries, PII and bank details
    // on screen; error-replays (previously 1.0 in prod) recorded them.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    ignoreErrors: [
      // Browser noise with no action for us.
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'AbortError',
      'Load failed', // Safari fetch cancellations
      'NetworkError when attempting to fetch resource',
      'Failed to fetch',
    ],
    beforeSend(event) {
      // Strip anything request-shaped that could carry tokens or PII.
      if (event.request) {
        delete event.request.cookies
        delete event.request.headers
        if (event.request.url) {
          event.request.url = event.request.url.split('?')[0]
        }
      }
      // User context is id-only (§9) — belt-and-braces on the client.
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : undefined
      }
      return event
    },
  })
}
