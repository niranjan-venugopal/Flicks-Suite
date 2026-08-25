'use client'

import { useState } from 'react'
import { Btn, Icon, Modal, Pill } from '@/components/proto'
import { PmAv } from '@/components/pm/projects'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  usePmProjectGuests,
  useInvitePmGuest,
  useRevokePmGuest,
} from '@/lib/api/queries/use-pm-guests'

/**
 * Project guests (round 7): Linear-style external seats scoped to exactly
 * this project. Owner/Admin only — inviting mints a workspace membership
 * (role guest, non-billable) plus a pm_project_members row; removing the
 * last project revokes the membership entirely.
 */
export function ProjectGuestsCard({ projectId }: { projectId: string }) {
  const { currentUser } = useAuthStore()
  const isAdmin = currentUser?.role === 'OWNER' || currentUser?.role === 'HR_ADMIN'
  const guests = usePmProjectGuests(projectId, isAdmin)
  const invite = useInvitePmGuest(projectId)
  const revoke = useRevokePmGuest(projectId)
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')

  if (!isAdmin) return null
  const rows = guests.data?.data ?? []

  const submit = async () => {
    const trimmed = email.trim()
    if (!trimmed) return
    try {
      const res = await invite.mutateAsync({
        email: trimmed,
        full_name: name.trim() || undefined,
      })
      toast({
        title: res.data.magicLinkSent
          ? `Invite sent to ${trimmed}`
          : `${trimmed} added to this project`,
        description:
          'Guests see only this project — nothing else in your workspace.',
      })
      setEmail('')
      setName('')
      setOpen(false)
    } catch (err) {
      toast({
        title: 'Could not invite guest',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>Guests</span>
        <Btn kind="ghost" size="sm" icon={<Icon.plus size={12} />} onClick={() => setOpen(true)}>
          Invite
        </Btn>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Invite a client or contractor to just this project — they&rsquo;ll
          never see the rest of your workspace. Free seat.
        </div>
      ) : (
        rows.map((g) => (
          <div
            key={g.userId}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}
          >
            <PmAv name={g.fullName ?? g.email} size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: '#fff',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {g.fullName ?? g.email}
              </div>
              <div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-faint)' }}>
                {g.email}
              </div>
            </div>
            {g.status === 'invited' && <Pill tone="yellow">Invited</Pill>}
            <button
              type="button"
              aria-label={`Remove ${g.email}`}
              onClick={async () => {
                try {
                  const res = await revoke.mutateAsync(g.userId)
                  toast({
                    title: res.data.membershipRevoked
                      ? `${g.email} removed — their guest access is fully revoked`
                      : `${g.email} removed from this project`,
                  })
                } catch (err) {
                  toast({
                    title: 'Could not remove guest',
                    description: err instanceof Error ? err.message : 'Try again',
                    variant: 'destructive',
                  })
                }
              }}
              disabled={revoke.isPending}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-faint)',
                cursor: 'pointer',
                padding: 3,
              }}
            >
              <Icon.x size={12} />
            </button>
          </div>
        ))
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Invite a guest" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@theircompany.com"
              autoFocus
            />
          </div>
          <div>
            <label className="label">Name (optional)</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Their name"
              maxLength={120}
            />
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.5 }}>
            Guests can view and work on this project&rsquo;s issues only. They
            don&rsquo;t count toward your bill.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Btn kind="ghost" onClick={() => setOpen(false)} disabled={invite.isPending}>
              Cancel
            </Btn>
            <Btn kind="primary" onClick={submit} disabled={invite.isPending || !email.trim()}>
              {invite.isPending ? 'Inviting…' : 'Send invite'}
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  )
}
