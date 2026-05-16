'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamFeatureFlagsPage() {
  return (
    <FamPlaceholder
      title="Feature flags"
      sub="Roll out features per cohort, per tenant, or globally."
      sprintTag="Sprint 3 · C5"
      icon={<Icon.cog size={22} />}
      endpoints={[
        'GET    /api/v1/fam/feature-flags',
        'PUT    /api/v1/fam/feature-flags',
        'GET    /api/v1/fam/cohorts',
        'PUT    /api/v1/fam/cohorts',
      ]}
    />
  )
}
