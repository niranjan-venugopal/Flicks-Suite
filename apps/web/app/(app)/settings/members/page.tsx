'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Loader2, Plus } from 'lucide-react'
import { Avatar, Btn, Pill, SectionHead, type PillTone } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import {
  useMembers,
  useUpdateMemberRole,
  useDeactivateMember,
  useReactivateMember,
  type Member,
  type MembershipRole,
} from '@/lib/api/queries/use-settings'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<MembershipRole, string> = {
  super_admin: 'Super Admin',
  owner:       'Owner',
  admin:       'HR Admin',
  manager:     'Manager',
  finance:     'Finance',
  employee:    'Employee',
}

// Roles a customer admin can assign (super_admin is Specflicks-internal only).
const ASSIGNABLE_ROLES: MembershipRole[] = ['owner', 'admin', 'manager', 'employee']

function roleTone(r: MembershipRole): PillTone {
  switch (r) {
    case 'super_admin': return 'purple'
    case 'owner':       return 'yellow'
    case 'admin':       return 'blue'
    case 'manager':     return 'green'
    case 'finance':     return 'purple'
    default:            return ''
  }
}

function statusPill(s: Member['status']) {
  switch (s) {
    case 'active':      return <Pill tone="green" dot>Active</Pill>
    case 'invited':     return <Pill tone="yellow" dot>Invited</Pill>
    case 'deactivated': return <Pill tone="coral">Deactivated</Pill>
  }
}

function displayName(m: Member): string {
  if (m.firstName || m.lastName) return `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim()
  return m.fullName ?? m.email ?? '—'
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MembersSettingsPage() {
  const { currentUser } = useAuthStore()
  const { data, isLoading } = useMembers()
  const updateRole = useUpdateMemberRole()
  const deactivate = useDeactivateMember()
  const reactivate = useReactivateMember()
  const { toast } = useToast()

  const items = data?.data ?? []
  const counts = useMemo(() => {
    const c = { total: 0, active: 0, invited: 0, deactivated: 0 }
    for (const m of items) {
      c.total++
      c[m.status]++
    }
    return c
  }, [items])

  // ─── Invite ─────────────────────────────────────────────────────────────
  //
  // Inviting an employee is now a single full-page flow at /employees/add
  // matching the prototype's ScrAddEmployee. The 'Invite employee' button
  // in the header simply navigates to that page — no in-page dialog. After
  // the admin sends the invite, the invitee receives a magic-link and the
  // (app) layout's guard redirects them to /onboarding/employee for the
  // 5-step self-onboarding wizard.

  // ─── Role / status mutations ─────────────────────────────────────────────
  const handleRoleChange = async (m: Member, role: MembershipRole) => {
    if (role === m.role) return
    try {
      await updateRole.mutateAsync({ id: m.id, role })
      toast({
        title: 'Role updated',
        description: `${displayName(m)} is now ${ROLE_LABELS[role]}.`,
      })
    } catch (err: any) {
      toast({
        title: 'Could not change role',
        description: err?.message,
        variant: 'destructive',
      })
    }
  }

  const handleStatusToggle = async (m: Member) => {
    const isMe = m.userId === currentUser?.id
    if (isMe) {
      toast({
        title: 'Cannot deactivate yourself',
        description: 'Ask another Owner / HR Admin to do this for you.',
        variant: 'destructive',
      })
      return
    }
    try {
      if (m.status === 'deactivated') {
        await reactivate.mutateAsync(m.id)
        toast({ title: 'Member reactivated', description: displayName(m) })
      } else {
        await deactivate.mutateAsync(m.id)
        toast({ title: 'Member deactivated', description: displayName(m) })
      }
    } catch (err: any) {
      toast({
        title: 'Could not change status',
        description: err?.message,
        variant: 'destructive',
      })
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <SettingsLayout>
      <div className="card">
        <SectionHead
          title="Roles & permissions"
          sub={`${counts.total} member${counts.total === 1 ? '' : 's'} · ${counts.active} active · ${counts.invited} invited${counts.deactivated ? ` · ${counts.deactivated} deactivated` : ''}`}
          right={
            <Link href="/employees/add" style={{ textDecoration: 'none' }}>
              <Btn kind="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />}>
                Invite employee
              </Btn>
            </Link>
          }
        />

        {isLoading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 px-6">
            <div className="t-h3 mb-1">No members yet</div>
            <p className="t-mute mb-4">Invite your first teammate to start collaborating.</p>
            <Link href="/employees/add" style={{ textDecoration: 'none' }}>
              <Btn kind="primary" icon={<Plus className="w-4 h-4" />}>
                Invite employee
              </Btn>
            </Link>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                <th style={th}>Member</th>
                <th style={th}>Email</th>
                <th style={th}>Department</th>
                <th style={th}>Role</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((m, i, arr) => {
                const isMe = m.userId === currentUser?.id
                const name = displayName(m)
                const canEdit = m.role !== 'super_admin' && !isMe

                return (
                  <tr
                    key={m.id}
                    style={{
                      borderBottom: i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                      opacity: m.status === 'deactivated' ? 0.5 : 1,
                    }}
                  >
                    <td style={{ padding: '12px 14px' }}>
                      <div className="flex items-center gap-3">
                        <Avatar name={name} size="sm" src={m.avatarUrl ?? undefined} />
                        <div>
                          <div className="font-semibold text-white text-sm">
                            {name}{' '}
                            {isMe && <span className="text-brand-muted text-xs">(you)</span>}
                          </div>
                          {m.designationTitle && (
                            <div className="text-xs text-brand-muted">{m.designationTitle}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {m.email ?? '—'}
                    </td>
                    <td style={td}>{m.departmentName ?? '—'}</td>
                    <td style={{ padding: '12px 14px' }}>
                      {canEdit ? (
                        <select
                          className="input"
                          style={{ padding: '6px 8px', fontSize: 12, height: 'auto', minWidth: 120 }}
                          value={m.role}
                          onChange={(e) => handleRoleChange(m, e.target.value as MembershipRole)}
                          disabled={updateRole.isPending}
                        >
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                          ))}
                        </select>
                      ) : (
                        <Pill tone={roleTone(m.role)}>{ROLE_LABELS[m.role]}</Pill>
                      )}
                    </td>
                    <td style={{ padding: '12px 14px' }}>{statusPill(m.status)}</td>
                    <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                      <Btn
                        kind="ghost"
                        size="sm"
                        onClick={() => handleStatusToggle(m)}
                        disabled={!canEdit || deactivate.isPending || reactivate.isPending}
                      >
                        {m.status === 'deactivated' ? 'Reactivate' : 'Deactivate'}
                      </Btn>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </SettingsLayout>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 11.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-mute)',
}

const td: React.CSSProperties = {
  padding: '12px 14px',
  fontSize: 12.5,
  color: 'var(--text-2)',
}
