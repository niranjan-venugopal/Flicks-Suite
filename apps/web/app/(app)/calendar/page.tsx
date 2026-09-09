'use client'

import { Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/lib/stores/auth.store'
import { CalendarShell } from '@/components/calendar/CalendarShell'

// ─────────────────────────────────────────────────────────
// Round J — the Teams-style calendar (week / day / month / agenda, real
// events and meetings, team availability). Guests and auditors have no
// workspace calendar: the API refuses them (403) and the sidebar never
// links here, so a typed URL bounces to their own landing.
// ─────────────────────────────────────────────────────────

export default function CalendarPage() {
  // useSearchParams() needs a Suspense boundary for Next's static export step.
  return (
    <Suspense
      fallback={
        <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}>
          <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
        </div>
      }
    >
      <CalendarGate />
    </Suspense>
  )
}

function CalendarGate() {
  const router = useRouter()
  const { currentUser } = useAuthStore()
  const role = currentUser?.role
  const blocked = role === 'GUEST' || role === 'AUDITOR'
  useEffect(() => {
    if (role === 'GUEST') router.replace('/pm/projects')
    else if (role === 'AUDITOR') router.replace('/invoicing')
  }, [role, router])
  if (blocked) return null
  return <CalendarShell />
}
