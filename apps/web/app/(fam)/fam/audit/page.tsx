'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamAuditPage() {
  return (
    <FamPlaceholder
      title="Platform audit log"
      sub="Every FAM action (suspend, extend, impersonate, flag toggle) recorded in audit_log_platform."
      sprintTag="Sprint 3 · C5"
      icon={<Icon.info size={22} />}
      endpoints={['select on audit_log_platform']}
    />
  )
}
