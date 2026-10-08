'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCurrentUser } from '@/lib/api/queries/use-auth'
import { useSwitchCompany } from '@/lib/api/queries/use-members'
import { listenTenantChanges } from '@/lib/tenant-sync'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Round R — two things that keep a person inside the company they mean:
 *
 * 1. Tabs stay in step. A company switch or sign-out in another tab of this
 *    browser reloads this one (the API already refuses a drifted tab with
 *    409 TENANT_MISMATCH; this just makes it immediate).
 * 2. `?company=<id>` on a link (policy / asset notifications and emails)
 *    switches into that company when the person belongs to it, so someone
 *    with several companies never lands in whichever one happened to be
 *    active. An unknown company is ignored and the parameter dropped.
 */
export function TenantSync() {
  const me = useCurrentUser()
  const switchCompany = useSwitchCompany()
  const pathname = usePathname()
  const sp = useSearchParams()
  const router = useRouter()
  const handled = useRef(false)
  const currentTenantId = me.data?.currentMembership?.tenantId ?? null

  useEffect(() => listenTenantChanges(currentTenantId), [currentTenantId])

  useEffect(() => {
    if (!me.data || handled.current) return
    const wanted = sp.get('company')
    if (!wanted) return
    handled.current = true
    const rest = new URLSearchParams(sp.toString())
    rest.delete('company')
    const here = `${pathname}${rest.toString() ? `?${rest.toString()}` : ''}`
    const mine = (me.data.memberships ?? []).find(
      (m) => m.tenantId === wanted && (m.status === 'active' || m.status === 'invited'),
    )
    if (UUID.test(wanted) && mine && wanted !== currentTenantId) {
      switchCompany.mutate({ tenantId: wanted, redirectTo: here })
      return
    }
    router.replace(here, { scroll: false })
  }, [me.data, sp, pathname, currentTenantId, switchCompany, router])

  return null
}
