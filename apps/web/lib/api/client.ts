const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

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
    // Clear auth and redirect to login
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
    throw new APIError(401, 'Unauthorized')
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => null)
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

export const api = {
  get: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(path, { method: 'GET', headers }),

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
