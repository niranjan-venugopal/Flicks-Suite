'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamCohortsPage() {
  return (
    <FamPlaceholder
      title="Beta cohorts"
      sub="Named groups of tenants that get feature flags or beta rollouts together."
      sprintTag="Sprint 3 · C5"
      icon={<Icon.tag size={22} />}
      endpoints={[
        'GET /api/v1/fam/cohorts',
        'PUT /api/v1/fam/cohorts',
      ]}
    />
  )
}
