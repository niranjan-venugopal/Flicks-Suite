'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamFunnelPage() {
  return (
    <FamPlaceholder
      title="Signup funnel"
      sub="Visit → signup → workspace created → first employee invited → first activity."
      sprintTag="Sprint 3 · C5"
      icon={<Icon.spark size={22} />}
      endpoints={[
        'aggregate on tenants, memberships, employees',
        'audit_log_platform action filters',
      ]}
    />
  )
}
