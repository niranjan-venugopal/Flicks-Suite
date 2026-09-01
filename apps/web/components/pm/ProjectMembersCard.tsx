'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Btn, Icon, Modal, Pill, Toggle } from '@/components/proto'
import { PmAv } from '@/components/pm/projects'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import { api } from '@/lib/api/client'
import type { PmSyncEngine } from '@/lib/pm/engine'
import {
  usePmProjectMembers,
  useAddPmMember,
  useRemovePmMember,
  useSetPmProjectVisibility,
} from '@/lib/api/queries/use-pm-members'

/**
 * Round E — the founder's "add specific members to give access" panel: the
 * project's INTERNAL roster (employees/managers with their workspace role),
 * plus the Private switch. Public projects: the roster organizes who's on
 * what — everyone with the Projects module still sees the project. Private:
 * only members, the lead, and owners/admins can see it anywhere. Guests keep
 * their own card. Managing (add/remove/Private) mirrors the server bar —
 * project lead + manager and above; the roster itself is visible to anyone
 * who can open the project.
 */
const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  employee: 'Employee',
  finance: 'Finance',
  auditor: 'Auditor',
}

export function ProjectMembersCard({
  projectId,
  leadUserId,
  isPrivate,
  engine,
}: {
  projectId: string
  leadUserId?: string | null
  isPrivate: boolean
  engine: PmSyncEngine | null
}) {
  const { currentUser } = useAuthStore()
  const mayManage =
    currentUser?.role === 'FAM' ||
    currentUser?.role === 'OWNER' ||
    currentUser?.role === 'HR_ADMIN' ||
    currentUser?.role === 'MANAGER' ||
    (!!leadUserId && currentUser?.id === leadUserId)
  const members = usePmProjectMembers(projectId)
  const add = useAddPmMember(projectId)
  const remove = useRemovePmMember(projectId)
  const setVisibility = useSetPmProjectVisibility(projectId)
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState('')

  // Workspace roster for the add-picker (works in both transports; the
  // engine store may hold the same rows but this stays one code path).
  const usersQ = useQuery({
    queryKey: ['pm', 'users'],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; name: string | null; avatar_url: string | null }> }>('/api/v1/pm/users'),
    staleTime: 300_000,
    enabled: open,
  })

  const rows = members.data?.data ?? []
  const memberIds = new Set(rows.map((r) => r.user_id))
  const candidates = (usersQ.data?.data ?? [])
    .filter((u) => !memberIds.has(u.id))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))

  const afterAccessChange = () => {
    // Private flips + membership on private projects ship sync refs — pull
    // the delta so the local graph converges without waiting for the poll.
    if (engine) void engine.pullDelta()
  }

  const submitAdd = async () => {
    if (!pick) return
    try {
      await add.mutateAsync(pick)
      toast({ title: 'Member added to this project' })
      setPick('')
      setOpen(false)
      afterAccessChange()
    } catch (err) {
      toast({
        title: 'Could not add member',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>
          Members{rows.length > 0 && <span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{rows.length}</span>}
        </span>
        {mayManage && (
          <Btn kind="ghost" size="sm" icon={<Icon.plus size={12} />} onClick={() => setOpen(true)}>
            Add
          </Btn>
        )}
      </div>

      {mayManage && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '2px 0 10px', borderBottom: '1px solid var(--bord)', marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#fff' }}>Private project</div>
            <div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-faint)', lineHeight: 1.45 }}>
              {isPrivate
                ? 'Only members, the lead and owners/admins can see it.'
                : 'Off — everyone with the Projects module can see it.'}
            </div>
          </div>
          <Toggle
            on={isPrivate}
            onChange={async (next: boolean) => {
              try {
                await setVisibility.mutateAsync(next)
                toast({
                  title: next ? 'Project is now Private' : 'Project is visible to everyone',
                  description: next
                    ? 'It disappears from non-members everywhere — lists, boards, search.'
                    : undefined,
                })
                afterAccessChange()
              } catch (err) {
                toast({
                  title: 'Could not change visibility',
                  description: err instanceof Error ? err.message : 'Try again',
                  variant: 'destructive',
                })
              }
            }}
          />
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          {mayManage
            ? isPrivate
              ? 'No members yet — only the lead and owners/admins can see this project.'
              : 'Add teammates to show who’s on this project.'
            : 'No members added yet.'}
        </div>
      ) : (
        rows.map((m) => (
          <div key={m.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
            <PmAv name={m.name ?? m.email} src={m.avatar_url} size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.name ?? m.email}
              </div>
              <div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-faint)' }}>{m.email}</div>
            </div>
            {m.is_lead && <Pill tone="blue">Lead</Pill>}
            <Pill>{ROLE_LABEL[m.role] ?? m.role}</Pill>
            {mayManage && (
              <button
                type="button"
                aria-label={`Remove ${m.email}`}
                onClick={async () => {
                  try {
                    await remove.mutateAsync(m.user_id)
                    toast({ title: `${m.name ?? m.email} removed from this project` })
                    afterAccessChange()
                  } catch (err) {
                    toast({
                      title: 'Could not remove member',
                      description: err instanceof Error ? err.message : 'Try again',
                      variant: 'destructive',
                    })
                  }
                }}
                disabled={remove.isPending}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 3 }}
              >
                <Icon.x size={12} />
              </button>
            )}
          </div>
        ))
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Add a member" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label className="label">Teammate</label>
            <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} autoFocus>
              <option value="">Choose a person…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>{u.name ?? u.id.slice(0, 6)}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.5 }}>
            {isPrivate
              ? 'They’ll gain access to this Private project and everything in it.'
              : 'They’ll show as part of this project. External clients go through the Guests card instead.'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Btn kind="ghost" onClick={() => setOpen(false)} disabled={add.isPending}>
              Cancel
            </Btn>
            <Btn kind="primary" onClick={submitAdd} disabled={add.isPending || !pick}>
              {add.isPending ? 'Adding…' : 'Add member'}
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  )
}
