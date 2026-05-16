'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamFeaturesUsagePage() {
  return (
    <FamPlaceholder
      title="Feature usage"
      sub="Which modules are tenants actually using? Attendance / Leave / Timesheet adoption per workspace."
      sprintTag="Sprint 3 · C5"
      icon={<Icon.tag size={22} />}
      endpoints={[
        'aggregate on attendance_punches, leave_requests, timesheet_entries',
      ]}
    />
  )
}
