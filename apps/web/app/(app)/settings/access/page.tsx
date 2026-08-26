'use client'

import { useMemo, useState } from 'react'
import { Btn, Icon, Pill, SectionHead, Skeleton } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useMembers, type Member } from '@/lib/api/queries/use-settings'
import {
  MANAGED_MODULES,
  MODULE_LABELS,
  POLICY_ROLES,
  POLICY_ROLE_LABELS,
  useClearMemberGrant,
  useRoleDefaults,
  useUpdateRoleDefaults,
  useUpsertMemberGrant,
  type GrantLevel,
  type ManagedModule,
  type PolicyRole,
} from '@/lib/api/queries/use-members'

// ─────────────────────────────────────────────────────────
// Settings → Module access. Who can open CRM, Invoicing and
// Projects — set once per role, or per person when someone
// needs an exception.
// ─────────────────────────────────────────────────────────

const LEVELS: { value: GrantLevel; label: string }[] = [
  { value: 'none', label: 'No access' },
  { value: 'view', label: 'View only' },
  { value: 'edit', label: 'Full access' },
]

/** Roles that hold every module by role — shown, but not editable. */
const FULL_BY_ROLE: Record<string, ManagedModule[]> = {
  owner: ['crm', 'invoicing', 'pm'],
  admin: ['crm', 'invoicing', 'pm'],
  finance: ['invoicing'],
}

function levelPill(level: GrantLevel) {
  if (level === 'edit') return <Pill tone="green">Full access</Pill>
  if (level === 'view') return <Pill tone="blue">View only</Pill>
  return <Pill tone="coral">No access</Pill>
}

function displayName(m: Member): string {
  const full = [m.firstName, m.lastName].filter(Boolean).join(' ').trim()
  return full || m.fullName || m.email || 'Member'
}

export default function ModuleAccessPage() {
  const { currentUser } = useAuthStore()
  const isOwnerOrAdmin = currentUser?.role === 'OWNER' || currentUser?.role === 'HR_ADMIN'
  const [tab, setTab] = useState<'roles' | 'people'>('roles')

  if (!isOwnerOrAdmin) {
    return (
      <SettingsLayout>
        <SectionHead title="Module access" sub="Who can open CRM, Invoicing and Projects." />
        <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
          <Icon.lock size={20} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>Owners and admins only</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)' }}>
            Ask an owner to change who can open which parts of the app.
          </div>
        </div>
      </SettingsLayout>
    )
  }

  return (
    <SettingsLayout>
      <SectionHead
        title="Module access"
        sub="Decide who can open CRM, Invoicing and Projects — by role, or per person."
      />
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 3,
          background: 'var(--surf-1)',
          border: '1px solid var(--bord)',
          borderRadius: 10,
          marginBottom: 18,
          width: 'fit-content',
        }}
      >
        {([['roles', 'By role'], ['people', 'By person']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              padding: '8px 14px',
              borderRadius: 7,
              border: 'none',
              cursor: 'pointer',
              background: tab === k ? 'var(--surf-3)' : 'transparent',
              color: tab === k ? '#fff' : 'var(--text-2)',
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'roles' ? <ByRole /> : <ByPerson />}
      <div className="t-caption" style={{ marginTop: 14 }}>
        Owners and admins always keep every module — change someone&apos;s role to
        change that. Access set here decides what a person can open; admin-only
        actions inside a module (deleting records, changing settings) still follow
        their role.
      </div>
    </SettingsLayout>
  )
}

// ─── By role ─────────────────────────────────────────────────────────────────

function ByRole() {
  const { data, isLoading } = useRoleDefaults()
  const save = useUpdateRoleDefaults()
  const { toast } = useToast()

  const current = useMemo(() => {
    const map = new Map<string, GrantLevel>()
    for (const d of data?.data.defaults ?? []) map.set(`${d.role}|${d.module}`, d.access_level)
    return map
  }, [data])

  const setLevel = async (role: PolicyRole, module: ManagedModule, access_level: GrantLevel) => {
    try {
      await save.mutateAsync([{ role, module, access_level }])
      toast({
        title: 'Access updated',
        description: `${POLICY_ROLE_LABELS[role]}s now have ${
          LEVELS.find((l) => l.value === access_level)!.label.toLowerCase()
        } to ${MODULE_LABELS[module]}.`,
      })
    } catch (err) {
      toast({
        title: 'Could not update access',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 38 }} />)}
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Role</th>
            {MANAGED_MODULES.map((m) => <th key={m}>{MODULE_LABELS[m]}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ fontWeight: 800 }}>
              Owner · Admin
              <div className="t-caption">Always full access</div>
            </td>
            {MANAGED_MODULES.map((m) => (
              <td key={m}><Pill tone="green">Full access</Pill></td>
            ))}
          </tr>
          {POLICY_ROLES.map((role) => (
            <tr key={role}>
              <td style={{ fontWeight: 800 }}>{POLICY_ROLE_LABELS[role]}</td>
              {MANAGED_MODULES.map((module) => {
                const lockedByRole = (FULL_BY_ROLE[role] ?? []).includes(module)
                if (lockedByRole) {
                  return (
                    <td key={module}>
                      <Pill tone="green">Full access</Pill>
                      <div className="t-caption">by role</div>
                    </td>
                  )
                }
                return (
                  <td key={module}>
                    <select
                      className="input"
                      value={current.get(`${role}|${module}`) ?? 'none'}
                      disabled={save.isPending}
                      onChange={(e) => void setLevel(role, module, e.target.value as GrantLevel)}
                      style={{ height: 34, fontSize: 12 }}
                    >
                      {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── By person ───────────────────────────────────────────────────────────────

function ByPerson() {
  const { data, isLoading } = useMembers()
  const defaults = useRoleDefaults()
  const upsert = useUpsertMemberGrant()
  const clear = useClearMemberGrant()
  const { toast } = useToast()
  const [q, setQ] = useState('')

  const defaultFor = useMemo(() => {
    const map = new Map<string, GrantLevel>()
    for (const d of defaults.data?.data.defaults ?? []) map.set(`${d.role}|${d.module}`, d.access_level)
    return map
  }, [defaults.data])

  // Guests are excluded: their Projects access IS their project invite, and
  // clearing it here would strand them with no way back in.
  const members = useMemo(() => {
    const rows = (data?.data ?? []).filter((m) => m.role !== 'guest')
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((m) =>
      `${displayName(m)} ${m.email ?? ''}`.toLowerCase().includes(needle),
    )
  }, [data, q])

  const change = async (m: Member, module: ManagedModule, value: string) => {
    try {
      if (value === 'role-default') {
        await clear.mutateAsync({ membershipId: m.id, module })
        toast({ title: 'Reset to role default', description: `${displayName(m)} now follows their role for ${MODULE_LABELS[module]}.` })
        return
      }
      await upsert.mutateAsync({ membershipId: m.id, module, accessLevel: value as GrantLevel })
      toast({
        title: 'Access updated',
        description: `${displayName(m)} · ${MODULE_LABELS[module]} — ${
          LEVELS.find((l) => l.value === value)!.label.toLowerCase()
        }.`,
      })
    } catch (err) {
      toast({
        title: 'Could not update access',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 38 }} />)}
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bord)' }}>
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people"
          style={{ height: 34, width: '100%', maxWidth: 320, fontSize: 12.5 }}
        />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              {MANAGED_MODULES.map((m) => <th key={m}>{MODULE_LABELS[m]}</th>)}
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && (
              <tr>
                <td colSpan={2 + MANAGED_MODULES.length} className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>
                  No people match that search.
                </td>
              </tr>
            )}
            {members.map((m) => {
              const fullByRole = FULL_BY_ROLE[m.role] ?? []
              return (
                <tr key={m.id}>
                  <td>
                    <div style={{ fontWeight: 800 }}>{displayName(m)}</div>
                    <div className="t-caption">{m.email}</div>
                  </td>
                  <td style={{ textTransform: 'capitalize' }}>{m.role}</td>
                  {MANAGED_MODULES.map((module) => {
                    if (fullByRole.includes(module)) {
                      return (
                        <td key={module}>
                          {levelPill('edit')}
                          <div className="t-caption">by role</div>
                        </td>
                      )
                    }
                    const override = m.grants.find((g) => g.module === module)
                    const roleLevel = defaultFor.get(`${m.role}|${module}`) ?? 'none'
                    return (
                      <td key={module}>
                        <select
                          className="input"
                          value={override ? (override.access_level as GrantLevel) : 'role-default'}
                          disabled={upsert.isPending || clear.isPending}
                          onChange={(e) => void change(m, module, e.target.value)}
                          style={{ height: 34, fontSize: 12, minWidth: 148 }}
                        >
                          <option value="role-default">
                            Same as role ({LEVELS.find((l) => l.value === roleLevel)!.label.toLowerCase()})
                          </option>
                          {LEVELS.map((l) => (
                            <option key={l.value} value={l.value}>{l.label}</option>
                          ))}
                        </select>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="t-caption" style={{ padding: '10px 16px', borderTop: '1px solid var(--bord)' }}>
        Project guests aren&apos;t listed here — their access comes from the project
        they were invited to, and is managed on that project.
      </div>
    </div>
  )
}
