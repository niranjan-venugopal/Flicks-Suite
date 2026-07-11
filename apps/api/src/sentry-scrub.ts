// PRD v4 §9 — extra PII scrubbing applied inside every Sentry beforeSend hook.
// Redacts email-shaped strings from the event message, exception values, and
// breadcrumbs, and strips query strings off breadcrumb URLs (they can carry
// magic-link / unsubscribe tokens). Kept dependency-free and loosely typed so
// it works across @sentry/nestjs and (mirrored copy) @sentry/nextjs event shapes.

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const REDACTED = '[redacted-email]';

function scrubString(s: unknown): unknown {
  return typeof s === 'string' ? s.replace(EMAIL_RE, REDACTED) : s;
}

function stripUrlQuery(s: unknown): unknown {
  return typeof s === 'string' ? s.split('?')[0] : s;
}

/** Mutates and returns the event with emails redacted + breadcrumb URLs de-queried. */
export function redactPii<T extends object>(event: T): T {
  const e = event as Record<string, unknown>;

  if (typeof e.message === 'string') e.message = scrubString(e.message) as string;

  const exception = e.exception as { values?: Array<{ value?: unknown }> } | undefined;
  if (exception?.values) {
    for (const v of exception.values) {
      if (v && typeof v.value === 'string') v.value = scrubString(v.value);
    }
  }

  const breadcrumbs = e.breadcrumbs as
    | Array<{ message?: unknown; data?: Record<string, unknown> }>
    | undefined;
  if (Array.isArray(breadcrumbs)) {
    for (const b of breadcrumbs) {
      if (b && typeof b.message === 'string') b.message = scrubString(b.message);
      if (b?.data) {
        for (const k of Object.keys(b.data)) {
          const raw = b.data[k];
          // URL-ish breadcrumb fields: drop query, then redact any email.
          b.data[k] = scrubString(
            k === 'url' || k === 'to' || k === 'from' ? stripUrlQuery(raw) : raw,
          );
        }
      }
    }
  }

  return event;
}
