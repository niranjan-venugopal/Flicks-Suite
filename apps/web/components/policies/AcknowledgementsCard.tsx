'use client'

import { useMemo, useState } from 'react'
import { Avatar, Btn, Icon, Pill, Skeleton, type PillTone } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { APIError } from '@/lib/api/client'
import { useAuthStore } from '@/lib/stores/auth.store'
import { formatDate } from '@/lib/utils'
import {
  useExportPolicyAcksCsv,
  usePolicyAcks,
  useRemindPolicy,
  type Policy,
  type PolicyAckMember,
} from '@/lib/api/queries/use-policies'

// ─────────────────────────────────────────────────────────
// Round P R3 — who signed / who is pending for the policy's CURRENT version.
// Signed and Pending tabs (avatars / initials, role, when), "Remind pending"
// (in-app + email; the API's 1/hour throttle message is shown verbatim) and
// "Export CSV" (cookie-authed download). Only applicable ACTIVE members
// count — guests and auditors are never asked.
// ─────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  owner: 'Admin',
  admin: 'HR Admin',
  manager: 'Manager',
  finance: 'Finance',
  employee: 'Employee',
}

function roleTone(role: string): PillTone {
  switch (role) {
    case 'owner': return 'yellow'
    case 'admin': return 'blue'
    case 'manager': return 'green'
    case 'finance': return 'purple'
    default: return ''
  }
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  return `${formatDate(d)} · ${time}`
}

export interface AcknowledgementsCardProps {
  policy: Policy
  canEdit: boolean
}

export function AcknowledgementsCard({ policy, canEdit }: AcknowledgementsCardProps) {
  const { toast } = useToast()
  const myUserId = useAuthStore((s) => s.currentUser?.id)
  const acks = usePolicyAcks(policy.id)
  const remind = useRemindPolicy()
  const exportCsv = useExportPolicyAcksCsv()
  const [tab, setTab] = useState<'signed' | 'pending'>('pending')
  const [q, setQ] = useState('')

  const data = acks.data?.data
  const signed = data?.signed ?? []
  const pending = data?.pending ?? []
  const total = signed.length + pending.length
  const published = policy.status === 'published'
  // The API never reminds the caller (they are looking at the page), so when
  // the publishing owner / HR admin is the only one pending there is nobody
  // to remind — say that, not "everyone has agreed".
  const remindable = pending.filter((m) => m.user_id !== myUserId).length
  const onlyMePending = pending.length > 0 && remindable === 0

  const rows = useMemo(() => {
    const list: Array<PolicyAckMember & { acknowledged_at?: string }> = tab === 'signed' ? signed : pending
    const needle = q.trim().toLowerCase()
    if (!needle) return list
    return list.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(needle))
  }, [tab, signed, pending, q])

  const onRemind = async () => {
    try {
      const res = await remind.mutateAsync(policy.id)
      const n = res.data.reminded
      toast({
        title: n === 0 ? 'Nobody to remind' : `Reminder sent to ${n} ${n === 1 ? 'person' : 'people'}`,
        description:
          n === 0
            ? onlyMePending
              ? 'No one else to remind — only you are still pending.'
              : 'Everyone has already agreed.'
            : 'In-app notification and email, to everyone still pending.',
      })
    } catch (err) {
      // 429 REMIND_TOO_SOON — the API's message is the whole story; show it as is.
      const tooSoon = err instanceof APIError && err.status === 429
      toast({
        title: tooSoon ? 'Reminder not sent' : 'Could not send the reminder',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const onExport = async () => {
    try {
      await exportCsv.mutateAsync({ id: policy.id, title: policy.title })
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const lastReminded = policy.last_reminded_at ? fmtWhen(policy.last_reminded_at) : null

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Head */}
      <div
        style={{
          padding: '18px 20px 14px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="t-h3" style={{ marginBottom: 4 }}>Acknowledgements</div>
          <div className="t-mute" style={{ fontSize: 12 }}>
            {policy.status === 'draft'
              ? 'Publish the policy to start collecting acknowledgements.'
              : !policy.requires_acknowledgement
                ? `v${policy.version} · no acknowledgement required — nobody is asked to agree.`
                : data
                  ? `v${data.version} · ${signed.length} of ${total} agreed${
                      policy.status === 'archived' ? ' · archived' : ''
                    }`
                  : `v${policy.version}`}
            {lastReminded && policy.requires_acknowledgement && (
              <span> · last reminder {lastReminded}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn
            kind="secondary"
            size="sm"
            icon={<Icon.download size={13} />}
            onClick={() => void onExport()}
            disabled={exportCsv.isPending || policy.status === 'draft'}
          >
            {exportCsv.isPending ? 'Exporting…' : 'Export CSV'}
          </Btn>
          {canEdit && (
            <Btn
              kind="primary"
              size="sm"
              icon={<Icon.bell size={13} />}
              onClick={() => void onRemind()}
              disabled={remind.isPending || !published || !policy.requires_acknowledgement || remindable === 0}
              title={
                !published
                  ? 'Only a published policy can be reminded'
                  : acks.isError
                    ? 'Roster unavailable — retry below'
                    : onlyMePending
                      ? 'Only you are still pending — nobody else to remind'
                      : pending.length === 0
                        ? 'Nobody is pending'
                        : undefined
              }
            >
              {remind.isPending ? 'Sending…' : 'Remind pending'}
            </Btn>
          )}
        </div>
      </div>

      {/* Tabs + search */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 20px 12px',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 3,
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            borderRadius: 10,
          }}
        >
          {(
            [
              ['pending', 'Pending', pending.length, 'coral'],
              ['signed', 'Signed', signed.length, 'green'],
            ] as const
          ).map(([k, label, n, tone]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 13px',
                borderRadius: 7,
                border: 'none',
                cursor: 'pointer',
                background: tab === k ? 'var(--surf-3)' : 'transparent',
                color: tab === k ? 'var(--text)' : 'var(--text-2)',
                fontSize: 12,
                fontWeight: 800,
              }}
            >
              {label}
              <span
                style={{
                  minWidth: 18,
                  height: 18,
                  padding: '0 6px',
                  borderRadius: 99,
                  fontSize: 10.5,
                  fontWeight: 800,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: `color-mix(in srgb, var(--${tone}) 14%, transparent)`,
                  color: `var(--${tone})`,
                }}
              >
                {acks.isLoading ? '…' : n}
              </span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people"
          style={{ height: 34, width: '100%', maxWidth: 240, fontSize: 12.5 }}
        />
      </div>

      {/* List */}
      <div style={{ borderTop: '1px solid var(--bord)' }}>
        {acks.isLoading ? (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} h={40} />)}
          </div>
        ) : acks.isError ? (
          <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>
            Couldn&apos;t load the roster.{' '}
            <button
              type="button"
              onClick={() => void acks.refetch()}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontWeight: 800, cursor: 'pointer', padding: 0 }}
            >
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '26px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>
              {q.trim()
                ? 'No people match that search.'
                : tab === 'pending'
                  ? policy.status === 'draft'
                    ? 'Nobody is asked until the policy is published.'
                    : !policy.requires_acknowledgement
                      ? 'This policy doesn’t ask anyone to agree.'
                      : total === 0
                        ? 'No one it applies to yet.'
                        : 'Everyone has agreed.'
                  : 'No one has agreed yet.'}
            </div>
            <div className="t-mute" style={{ fontSize: 11.5 }}>
              {tab === 'pending' && published && policy.requires_acknowledgement && total > 0 && signed.length === total
                ? 'Nice — the whole audience has signed the current version.'
                : tab === 'signed' && published && policy.requires_acknowledgement
                  ? 'Acknowledgements appear here the moment someone agrees.'
                  : ''}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((m, i) => (
              <div
                key={m.user_id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 20px',
                  borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none',
                }}
              >
                <Avatar name={m.name || m.email} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name || m.email}
                  </div>
                  <div className="t-mute" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.email}
                  </div>
                </div>
                <Pill tone={roleTone(m.role)}>{ROLE_LABELS[m.role] ?? m.role}</Pill>
                {tab === 'signed' ? (
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      color: 'var(--green)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <Icon.check size={12} />
                    {m.acknowledged_at ? fmtWhen(m.acknowledged_at) : 'Agreed'}
                  </span>
                ) : (
                  <span className="t-mute" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>Pending</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
