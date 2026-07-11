// PRD v4 §9 — extra PII scrubbing for Sentry beforeSend (web client/server/edge).
// Redacts email-shaped strings from message/exception/breadcrumbs and strips
// query strings off breadcrumb URLs (magic-link / unsubscribe tokens). Loosely
// typed so it applies uniformly across the three @sentry/nextjs runtimes.

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const REDACTED = '[redacted-email]'

function scrubString(s: unknown): unknown {
  return typeof s === 'string' ? s.replace(EMAIL_RE, REDACTED) : s
}

function stripUrlQuery(s: unknown): unknown {
  return typeof s === 'string' ? s.split('?')[0] : s
}

/** Mutates and returns the event with emails redacted + breadcrumb URLs de-queried. */
export function redactPii<T extends object>(event: T): T {
  const e = event as Record<string, unknown>

  if (typeof e.message === 'string') e.message = scrubString(e.message) as string

  const exception = e.exception as { values?: Array<{ value?: unknown }> } | undefined
  if (exception?.values) {
    for (const v of exception.values) {
      if (v && typeof v.value === 'string') v.value = scrubString(v.value)
    }
  }

  const breadcrumbs = e.breadcrumbs as
    | Array<{ message?: unknown; data?: Record<string, unknown> }>
    | undefined
  if (Array.isArray(breadcrumbs)) {
    for (const b of breadcrumbs) {
      if (b && typeof b.message === 'string') b.message = scrubString(b.message)
      if (b?.data) {
        for (const k of Object.keys(b.data)) {
          const raw = b.data[k]
          b.data[k] = scrubString(
            k === 'url' || k === 'to' || k === 'from' ? stripUrlQuery(raw) : raw,
          )
        }
      }
    }
  }

  return event
}
