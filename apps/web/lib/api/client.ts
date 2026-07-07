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

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: requestHeaders,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  })

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
