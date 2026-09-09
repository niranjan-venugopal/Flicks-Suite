'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { SkeletonRows } from '@/components/states'
import { useAuthStore } from '@/lib/stores/auth.store'

// Round 14 (founder): the team view lives INSIDE the Attendance page behind
// the My/Team toggle — this route survives only so old links keep working.
// Round K: stored regularization notifications used to point here, which
// dumped the manager on their OWN daily log. Approver roles now land on
// Inbox → Approvals (the review queue); everyone else keeps /attendance.
// Role-aware, so it waits for the persisted auth store to rehydrate.
export default function TeamAttendanceRedirect() {
  const router = useRouter()
  const role = useAuthStore((s) => s.currentUser?.role)

  useEffect(() => {
    if (!role) return
    const approver = role === 'OWNER' || role === 'HR_ADMIN' || role === 'MANAGER'
    router.replace(approver ? '/inbox?tab=approvals' : '/attendance')
  }, [role, router])

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 1280, margin: '0 auto' }}>
      <SkeletonRows rows={6} height={44} />
    </div>
  )
}
