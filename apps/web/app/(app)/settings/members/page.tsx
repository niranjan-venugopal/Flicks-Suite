'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Plus } from 'lucide-react'
import { Avatar, Btn, Icon, Kpi, Pill, SectionHead, type PillTone } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import {
  useMembers,
  useUpdateMemberRole,
  useDeactivateMember,
  useReactivateMember,
  type Member,
  type MembershipRole,
} from '@/lib/api/queries/use-settings'
import { useSeats } from '@/lib/api/queries/use-members'
import { InviteAuditorModal } from '@/components/invoicing/InviteAuditorModal'
import { MemberAccessModal } from '@/components/invoicing/MemberAccessModal'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<MembershipRole, string> = {
  fam:         'FAM Admin',
  super_admin: 'FAM Admin', // legacy alias — pre-0004 rows
  owner:       'Admin', // displayed label (founder decision); role key stays 'owner'
  admin:       'HR Admin',
  manager:     'Manager',
  finance:     'Finance',
  employee:    'Employee',
  auditor:     'Auditor',
}

// Roles a customer admin can assign (fam is Specflicks-internal only;
// auditors are invited through the grant-scoped flow, not the role select).
const ASSIGNABLE_ROLES: MembershipRole[] = ['owner', 'admin', 'manager', 'employee']

// Short labels for the auditor "Granted scope" pills.
const GRANT_LABELS: Record<string, string> = {
  invoicing:     'Invoicing',
  reports:       'Reports',
  org_financial: 'Financial',
  payroll:       'Payroll',
  expenses:      'Expenses',
}

function grantPills(m: Member): string[] {
  return (m.grants ?? []).map((g) => {
    const caps = Object.keys(g.capabilities ?? {}).filter((k) => g.capabilities[k])
    const base = `${GRANT_LABELS[g.module] ?? g.module}: ${g.access_level}`
    return caps.length ? `${base} +${caps.length}` : base
  })
}

function roleTone(r: MembershipRole): PillTone {
  switch (r) {
    case 'fam':         return 'purple'
    case 'super_admin': return 'purple'
    case 'owner':       return 'yellow'
    case 'admin':       return 'blue'
    case 'manager':     return 'green'
    case 'finance':     return 'purple'
    case 'auditor':     return 'purple'
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
  const seats = useSeats()
  const updateRole = useUpdateMemberRole()
  const deactivate = useDeactivateMember()
  const reactivate = useReactivateMember()
  const { toast } = useToast()
  const [inviteAuditorOpen, setInviteAuditorOpen] = useState(false)
  const [accessFor, setAccessFor] = useState<Member | null>(null)

  const allItems = data?.data ?? []
  const auditors = useMemo(() => allItems.filter((m) => m.role === 'auditor'), [allItems])
  const items = useMemo(() => allItems.filter((m) => m.role !== 'auditor'), [allItems])
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
        description: 'Ask another Admin / HR Admin to do this for you.',
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
      {/* Seats — members are billable, auditors are not (PRD §3 / §13.3 Q3). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 18 }}>
        <Kpi
          label="Member seats"
          value={seats.data?.data.billable ?? counts.active}
          delta="billable"
          icon={<Icon.people size={16} />}
          accent="blue"
        />
        <Kpi
          label="Auditor seats"
          value={seats.data?.data.auditors ?? auditors.filter((a) => a.status === 'active').length}
          delta="non-billable"
          icon={<Icon.shield size={16} />}
          accent="purple"
        />
        <Kpi
          label="Pending invites"
          value={seats.data?.data.pendingInvites ?? counts.invited}
          delta="awaiting accept"
          icon={<Icon.mail size={16} />}
          accent="yellow"
        />
      </div>

      {/* Auditors — finance-scoped, multi-company, grant-driven access. */}
      <div className="card" style={{ marginBottom: 18 }}>
        <SectionHead
          title="Auditors"
          sub="Finance-scoped, multi-company and not billed. Access is exactly the granted modules."
          right={
            <Btn
              kind="primary"
              size="sm"
              icon={<Icon.shield size={14} />}
              onClick={() => setInviteAuditorOpen(true)}
            >
              Invite auditor
            </Btn>
          }
        />
        {auditors.length === 0 ? (
          <div className="t-mute" style={{ padding: '14px 14px 6px', fontSize: 12.5 }}>
            No auditors yet. Invite your CA firm — they get a non-billable seat scoped to the
            modules you grant.
          </div>
        ) : (
          <div className="tbl-scroll">
          <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                <th style={th}>Auditor</th>
                <th style={th}>Seat</th>
                <th style={th}>Granted scope</th>
                <th style={th}>Window</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {auditors.map((m, i, arr) => (
                <tr
                  key={m.id}
                  style={{
                    borderBottom: i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                    opacity: m.status === 'deactivated' ? 0.5 : 1,
                  }}
                >
                  <td style={{ padding: '12px 14px' }}>
                    <div className="flex items-center gap-3">
                      <Avatar name={displayName(m)} size="sm" src={m.avatarUrl ?? undefined} />
                      <div>
                        <div className="font-semibold text-white text-sm">{displayName(m)}</div>
                        <div className="text-xs text-brand-muted">{m.email ?? '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td style={td}>
                    <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 800 }}>
                      Non-billable
                    </span>
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {grantPills(m).map((s) => (
                        <Pill key={s}>{s}</Pill>
                      ))}
                    </div>
                  </td>
                  <td style={td}>
                    {m.accessExpiresAt ? (
                      <span className="t-mute" style={{ fontSize: 12 }}>
                        until {new Date(m.accessExpiresAt).toLocaleDateString('en-IN')}
                      </span>
                    ) : (
                      <span className="t-mute" style={{ fontSize: 12 }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 14px' }}>{statusPill(m.status)}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                    {m.status !== 'deactivated' && (
                      <Btn
                        kind="danger"
                        size="sm"
                        onClick={() => handleStatusToggle(m)}
                        disabled={deactivate.isPending}
                      >
                        Revoke
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className="card">
        <SectionHead
          title="Roles & permissions"
          sub={`${counts.total} member${counts.total === 1 ? '' : 's'} · ${counts.active} active · ${counts.invited} invited${counts.deactivated ? ` · ${counts.deactivated} deactivated` : ''}`}
          right={
            <Link href="/employees/add" style={{ textDecoration: 'none' }}>
              <Btn kind="secondary" size="sm" icon={<Plus className="w-3.5 h-3.5" />}>
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
          <div className="tbl-scroll">
          <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
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
                const canEdit = m.role !== 'fam' && m.role !== 'super_admin' && !isMe

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
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        {canEdit && (m.role === 'manager' || m.role === 'employee') && (
                          <Btn kind="ghost" size="sm" onClick={() => setAccessFor(m)}>
                            Invoicing access
                          </Btn>
                        )}
                        <Btn
                          kind="ghost"
                          size="sm"
                          onClick={() => handleStatusToggle(m)}
                          disabled={!canEdit || deactivate.isPending || reactivate.isPending}
                        >
                          {m.status === 'deactivated' ? 'Reactivate' : 'Deactivate'}
                        </Btn>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <InviteAuditorModal open={inviteAuditorOpen} onClose={() => setInviteAuditorOpen(false)} />
      {accessFor && (
        <MemberAccessModal
          open={!!accessFor}
          onClose={() => setAccessFor(null)}
          membershipId={accessFor.id}
          memberName={displayName(accessFor)}
          currentGrants={accessFor.grants ?? []}
        />
      )}
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
