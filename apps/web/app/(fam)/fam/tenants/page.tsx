'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamTenantsPage() {
  return (
    <FamPlaceholder
      title="Tenants"
      sub="Every workspace on the platform — filter, drill in, suspend, extend trial."
      sprintTag="Sprint 3 · C3"
      icon={<Icon.people size={22} />}
      endpoints={[
        'GET    /api/v1/fam/tenants',
        'GET    /api/v1/fam/tenants/:id',
        'POST   /api/v1/fam/tenants/:id/suspend',
        'POST   /api/v1/fam/tenants/:id/extend-trial',
        'GET    /api/v1/fam/tenants/:id/health',
      ]}
    />
  )
}
