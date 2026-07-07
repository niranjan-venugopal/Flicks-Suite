// Edge-runtime Sentry (middleware, edge routes).
import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release:
      process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
    // §9 hardening: no request PII, no profiling, scrubbed events.
    sendDefaultPii: false,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: 0,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies
        delete event.request.headers
        if (event.request.data) delete event.request.data
      }
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : undefined
      }
      return event
    },
  })
}
