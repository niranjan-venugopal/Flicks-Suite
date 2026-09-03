const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

// Endpoints that handle their own 401s — don't trigger a global hard-redirect
// from inside the api client (which would mask the real error and bounce users
// out of the OTP/magic-link flow before they can see what went wrong).
//
// The background polls (notifications bell, presence) are listed too: a
// transient refresh failure on a 2-minute poll must NEVER eject a session
// holding a valid 7/180-day refresh cookie — react-query simply retries on
// the next tick. Only the /auth/me path (whose 401 the (app) layout already
// handles via authRejected) decides whether the session is really over.
const AUTH_PATHS_NO_REDIRECT = [
  '/api/v1/auth/me',
  '/api/v1/auth/request-otp',
  '/api/v1/auth/verify-otp',
  '/api/v1/auth/magic-link',
  '/api/v1/auth/magic-link/consume',
  '/api/v1/auth/magic-link/recover',
  '/api/v1/auth/refresh',
  '/api/v1/notifications/unread',
  '/api/v1/presence',
]

// Paths that must never trigger a silent refresh: the refresh call itself
// (recursion) and the pre-auth login endpoints, where a 401 is a real
// credential failure rather than an expired access token.
const NO_SILENT_REFRESH = [
  '/api/v1/auth/refresh',
  '/api/v1/auth/request-otp',
  '/api/v1/auth/verify-otp',
  '/api/v1/auth/magic-link',
  '/api/v1/auth/magic-link/consume',
  '/api/v1/auth/magic-link/recover',
  '/api/v1/auth/logout',
]

// Single-flight silent refresh: a burst of parallel 401s (dashboard mount
// after the 15-minute access cookie lapses) shares ONE rotation — the
// refresh endpoint revokes the old token on use, so a second concurrent
// attempt would trip the reuse detector and kill the whole session.
let refreshInFlight: Promise<boolean> | null = null

function silentRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    const attempt = () =>
      fetch(`${BASE_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      })
    refreshInFlight = attempt()
      .then(async (r) => {
        // A throttled or transiently-failing refresh is NOT an invalid
        // session — retry once after a beat instead of letting a healthy
        // 7/180-day cookie read as "logged out".
        if (r.status === 429 || r.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 750))
          r = await attempt()
        }
        return r.ok
      })
      .then((ok) => {
        if (ok) lastAuthOkAt = Date.now()
        else lastAuthOkAt = 0 // pause proactive ticking until a request succeeds
        return ok
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

// ─── Proactive refresh ───────────────────────────────────────────────────────
// The access cookie deliberately lives 15 minutes. Without this, the first
// request after a lapse eats a visible 401 (in practice always the
// notifications poll — the only query that refetches on focus), then silently
// refreshes and retries. Refreshing BEFORE the expiry removes the console
// noise at the source and keeps the socket handshakes finding a live cookie.
// Access cookie lifetime is 15 minutes (auth.service.ts) — refresh at ~12 so
// there are always ~3 minutes of margin.
const PROACTIVE_AT_MS = 12 * 60 * 1000

// Mint time of the current access cookie: stamped exactly by every successful
// refresh, and estimated (lower bound) by the first authenticated success
// after a page load. 0 = signed out / unknown — proactive ticking pauses
// until a request succeeds again.
let lastAuthOkAt = 0
let proactiveStarted = false

function tokenAge(): number {
  return lastAuthOkAt === 0 ? 0 : Date.now() - lastAuthOkAt
}

function maybeProactiveRefresh(threshold: number): void {
  if (lastAuthOkAt === 0) return
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/login')) return
  // No upper bound: after hours away the refresh cookie (7/180 days) is still
  // valid, and refreshing on return is exactly what keeps the reopened tab
  // signed in without a visible 401.
  if (tokenAge() >= threshold) {
    void silentRefresh()
  }
}

/** Idempotent — armed lazily on the first authenticated success. */
function armProactiveRefresh(): void {
  if (proactiveStarted || typeof window === 'undefined') return
  proactiveStarted = true
  // A coarse 60s heartbeat: refreshes at ~12min so the 15min cookie never
  // actually lapses while the tab is open.
  window.setInterval(() => maybeProactiveRefresh(PROACTIVE_AT_MS), 60_000)
  // Returning to a backgrounded tab: refresh FIRST if the cookie is stale, so
  // the focus refetches that follow find a live session instead of 401ing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      maybeProactiveRefresh(PROACTIVE_AT_MS)
    }
  })
}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

class APIError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown
  ) {
    super(message)
    this.name = 'APIError'
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options

  // Content-Type only when there IS content: setting it on GETs makes every
  // read a non-simple CORS request and forces a preflight round-trip.
  const requestHeaders: Record<string, string> = {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  }

  const doFetch = () =>
    fetch(`${BASE_URL}${path}`, {
      method,
      headers: requestHeaders,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    })

  let response = await doFetch()

  // Access tokens live 15 minutes; the httpOnly refresh cookie lives 7 days.
  // On the first 401, silently redeem the refresh token once and retry the
  // original request — before this, the session effectively ended at 15
  // minutes because nothing in the web app ever called /auth/refresh.
  if (
    response.status === 401 &&
    !NO_SILENT_REFRESH.some((p) => path.startsWith(p)) &&
    (await silentRefresh())
  ) {
    response = await doFetch()
  }

  if (response.status === 401) {
    const isAuthEndpoint = AUTH_PATHS_NO_REDIRECT.some((p) =>
      path.startsWith(p),
    )
    const onLoginPage =
      typeof window !== 'undefined' && window.location.pathname.startsWith('/login')

    if (!isAuthEndpoint && !onLoginPage && typeof window !== 'undefined') {
      window.location.href = '/login'
    }

    const errorData = await response.json().catch(() => null)
    throw new APIError(
      401,
      errorData?.message ?? 'Unauthorized',
      errorData,
    )
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => null)
    // 402 BILLING_REQUIRED: the workspace just locked (e.g. grace expired
    // mid-session). Announce it so BillingGate refetches and raises the D19
    // wall instead of every page showing a cryptic failure toast.
    if (
      response.status === 402 &&
      errorData?.code === 'BILLING_REQUIRED' &&
      typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new CustomEvent('fs:billing-locked'))
    }
    throw new APIError(
      response.status,
      errorData?.message ?? `HTTP ${response.status}`,
      errorData
    )
  }

  // First authenticated success after load: we know the cookie is live but
  // not when it was minted, so stamp "now" as a lower-bound estimate (worst
  // case one silent 401-recovery happens, exactly as before, and the refresh
  // then records the true mint time). Deliberately NOT re-stamped on every
  // success — requests prove the cookie is valid, they don't extend it, so
  // re-stamping would let it lapse mid-activity.
  if (!NO_SILENT_REFRESH.some((p) => path.startsWith(p))) {
    if (lastAuthOkAt === 0) lastAuthOkAt = Date.now()
    armProactiveRefresh()
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

/** Pull the filename out of a `Content-Disposition: attachment; filename="..."`. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  // RFC 5987 `filename*=UTF-8''...` takes precedence over a plain `filename=`.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^"]+)"?/i.exec(header)
  return plain?.[1]?.trim() ?? null
}

/**
 * Fetch a binary endpoint (e.g. the invoice PDF) as a Blob, reusing the same
 * cookie auth + 401-redirect behaviour as the JSON `request()` path. Returns the
 * Blob plus any server-suggested filename from Content-Disposition.
 */
async function download(
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const { method = 'GET', body, headers = {} } = options

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  })

  if (response.status === 401) {
    const onLoginPage =
      typeof window !== 'undefined' && window.location.pathname.startsWith('/login')
    if (!onLoginPage && typeof window !== 'undefined') {
      window.location.href = '/login'
    }
    throw new APIError(401, 'Unauthorized')
  }

  if (!response.ok) {
    // Error responses are JSON even on binary endpoints (Nest's exception filter).
    const errorData = await response.json().catch(() => null)
    throw new APIError(
      response.status,
      errorData?.message ?? `HTTP ${response.status}`,
      errorData,
    )
  }

  const blob = await response.blob()
  return { blob, filename: filenameFromDisposition(response.headers.get('Content-Disposition')) }
}

export const api = {
  get: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(path, { method: 'GET', headers }),

  download,

  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body, headers }),

  put: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'PUT', body, headers }),

  patch: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'PATCH', body, headers }),

  delete: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(path, { method: 'DELETE', headers }),
}

export { APIError }

// Round E — the PM sync engine's bootstrap streams NDJSON through a raw
// fetch (the JSON client can't carry it), so it needs the SAME single-flight
// refresh to recover from an expired 15-minute access cookie instead of
// silently degrading the whole session to REST mode.
export { silentRefresh }
