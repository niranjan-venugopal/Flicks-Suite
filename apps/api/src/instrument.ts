// Sentry must be initialised before any other module is imported so its
// auto-instrumentation can patch them. main.ts imports this file first.
// DSN is read from SENTRY_DSN; when unset (local dev) Sentry is a no-op.
import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // Conservative trace sampling — bump per environment once we see volume.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Don't capture local noise.
    enabled: (process.env.NODE_ENV ?? 'development') !== 'test',
  });
}
