'use client'

import { FamPlaceholder } from '@/components/fam/FamPlaceholder'
import { Icon } from '@/components/proto'

export default function FamVerifyPage() {
  return (
    <FamPlaceholder
      title="Verification queue"
      sub="Tenant verification: GST + PAN + workspace-domain checks before lifting plan limits."
      sprintTag="Sprint 3 · C5"
      icon={<Icon.success size={22} />}
      endpoints={[
        '(new) /api/v1/fam/verify, depends on tenant verification metadata',
      ]}
    />
  )
}
