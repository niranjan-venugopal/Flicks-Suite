'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamHealthPage() {
  return (
    <FamPlaceholder
      title="Tenant health"
      sub="Daily snapshots of activity, error rate, and risk score per workspace."
      sprintTag="Sprint 3 · C5"
      icon={<Icon.shield size={22} />}
      endpoints={['GET /api/v1/fam/tenants/:id/health']}
    />
  )
}
