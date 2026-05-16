'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamRevenuePage() {
  return (
    <FamPlaceholder
      title="Revenue"
      sub="MRR / ARR, churn, plan distribution, expansion."
      sprintTag="Sprint 3 · C5"
      icon={<Icon.chart size={22} />}
      endpoints={[
        'GET    /api/v1/fam/tenants  (drives plan distribution)',
        'select on subscriptions, subscription_events  (MRR/ARR)',
      ]}
    />
  )
}
