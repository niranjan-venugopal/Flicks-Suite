'use client'

import { useRouter } from 'next/navigation'
import { Icon } from '@/components/proto'
import { useEndImpersonation } from '@/lib/api/queries/use-fam'

/**
 * Sticky top banner shown across the customer app whenever the current
 * JWT carries an `impersonatorUserId` — i.e. a Specflicks FAM admin is
 * logged in as a customer user. Matches the prototype's red→yellow
 * gradient + audit-log copy.
 */
export function ImpersonationBanner({
  targetEmail,
  onExited,
}: {
  targetEmail: string | null
  onExited?: () => void
}) {
  const router = useRouter()
  const endMut = useEndImpersonation()

  const handleExit = async () => {
    try {
      await endMut.mutateAsync()
      onExited?.()
      // Cookies are now the FAM admin's again. (app)/layout reads the
      // fresh /me on next mount and bounces FAM admins to /fam/overview.
      router.replace('/fam/overview')
    } catch {
      // Worst case the FAM admin can just sign out manually.
    }
  }

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 200,
        background:
          'linear-gradient(90deg, rgba(248,120,107,.95), rgba(254,216,0,.95))',
        color: '#0A0612',
        padding: '10px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontSize: 12.5,
        fontWeight: 800,
        boxShadow: '0 4px 20px rgba(0,0,0,.3)',
      }}
    >
      <Icon.shield size={16} />
      <span>
        You are impersonating{' '}
        <strong>{targetEmail ?? 'this user'}</strong> as a Specflicks staff.
        All actions are audit-logged.
      </span>
      <div style={{ flex: 1 }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: 0.7 }}>
        Session expires in 15 min
      </span>
      <button
        onClick={handleExit}
        disabled={endMut.isPending}
        style={{
          background: 'rgba(0,0,0,.15)',
          color: '#0A0612',
          border: '1px solid rgba(0,0,0,.2)',
          padding: '5px 12px',
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 800,
          cursor: endMut.isPending ? 'wait' : 'pointer',
        }}
      >
        {endMut.isPending ? 'Exiting…' : 'Exit impersonation'}
      </button>
    </div>
  )
}
