const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

// Endpoints that handle their own 401s — don't trigger a global hard-redirect
// from inside the api client (which would mask the real error and bounce users
// out of the OTP/magic-link flow before they can see what went wrong).
const AUTH_PATHS_NO_REDIRECT = [
  '/api/v1/auth/me',
  '/api/v1/auth/request-otp',
  '/api/v1/auth/verify-otp',
  '/api/v1/auth/magic-link',
  '/api/v1/auth/refresh',
]

// Paths that must never trigger a silent refresh: the refresh call itself
// (recursion) and the pre-auth login endpoints, where a 401 is a real
// credential failure rather than an expired access token.
const NO_SILENT_REFRESH = [
  '/api/v1/auth/refresh',
  '/api/v1/auth/request-otp',
  '/api/v1/auth/verify-otp',
  '/api/v1/auth/magic-link',
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
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
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

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
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
