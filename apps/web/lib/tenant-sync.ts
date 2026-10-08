'use client'

/**
 * Round R — keep every open tab of this browser in the same company.
 *
 * The sign-in cookie is shared across tabs, so switching company (or signing
 * out) in one tab silently changes what the others' requests act on. The API
 * refuses a mismatch (409 TENANT_MISMATCH, see TenantHeaderGuard); this
 * channel makes the other tabs reload right away instead of at their next
 * request.
 */
const CHANNEL = 'fs-tenant'

type TenantMessage = { type: 'switched'; tenantId: string } | { type: 'signed-out' }

function channel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(CHANNEL)
  } catch {
    return null
  }
}

export function broadcastTenantSwitched(tenantId: string): void {
  const ch = channel()
  if (!ch) return
  try {
    ch.postMessage({ type: 'switched', tenantId } satisfies TenantMessage)
  } finally {
    ch.close()
  }
}

export function broadcastSignedOut(): void {
  const ch = channel()
  if (!ch) return
  try {
    ch.postMessage({ type: 'signed-out' } satisfies TenantMessage)
  } finally {
    ch.close()
  }
}

/**
 * Subscribe this tab. `currentTenantId` is the company it is rendering; a
 * switch to another company (or a sign-out) anywhere else reloads it.
 */
export function listenTenantChanges(currentTenantId: string | null | undefined): () => void {
  const ch = channel()
  if (!ch) return () => {}
  const onMessage = (ev: MessageEvent<TenantMessage>) => {
    const msg = ev.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'signed-out') {
      window.location.replace('/login')
      return
    }
    if (msg.type === 'switched' && msg.tenantId && msg.tenantId !== currentTenantId) {
      window.location.reload()
    }
  }
  ch.addEventListener('message', onMessage)
  return () => {
    ch.removeEventListener('message', onMessage)
    ch.close()
  }
}
