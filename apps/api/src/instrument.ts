// Sentry must be initialised before any other module is imported so its
// auto-instrumentation can patch them. main.ts imports this file first.
// DSN is read from SENTRY_DSN; when unset (local dev) Sentry is a no-op.
// Hardened per PRD v4 §9: no PII, scrubbed requests, id-only user context.
import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;

const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-razorpay-signature',
];

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release:
      process.env.SENTRY_RELEASE ??
      process.env.RAILWAY_GIT_COMMIT_SHA ??
      process.env.GIT_COMMIT_SHA ??
      undefined,
    // §9: never attach request PII automatically.
    sendDefaultPii: false,
    // Conservative trace sampling — bump per environment once we see volume.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: 0,
    // Don't capture local noise.
    enabled: (process.env.NODE_ENV ?? 'development') !== 'test',
    // Expected application errors — HTTP exceptions are user feedback, not
    // crashes. Anchored to the START of the composed `Type: message` string
    // so a genuine 5xx whose MESSAGE merely mentions one of these names is
    // NOT suppressed (Sentry's InboundFilters does substring matching on the
    // full string; a bare word would over-match).
    ignoreErrors: [
      /^UnauthorizedException/,
      /^ForbiddenException/,
      /^NotFoundException/,
      /^BadRequestException/,
      /^ConflictException/,
      /^ThrottlerException/,
    ],
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        if (event.request.headers) {
          for (const h of SENSITIVE_HEADERS) {
            delete (event.request.headers as Record<string, unknown>)[h];
          }
        }
        // Query strings can carry tokens (magic links, unsubscribe HMACs).
        if (event.request.query_string) delete event.request.query_string;
        if (event.request.data) delete event.request.data; // request bodies: never
      }
      // User context is id-only (§9) — no email/name ever leaves the app.
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : undefined;
      }
      return event;
    },
  });
}
