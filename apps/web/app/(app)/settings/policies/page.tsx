'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Pill, SectionHead, Skeleton } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { useToast } from '@/components/ui/use-toast'
import { policyKindPill, policyStatusPill } from '@/components/policies/PolicyEditor'
import {
  policyAudienceLabel,
  useCreatePolicy,
  usePolicies,
  usePoliciesAccess,
  type Policy,
} from '@/lib/api/queries/use-policies'
import { formatDate } from '@/lib/utils'

// ─────────────────────────────────────────────────────────
// Round P R3 — Settings → Company policies. The list (title, kind, version,
// status, "12 of 20 agreed") and "New policy", which creates a draft at once
// and opens the editor — the PDF upload needs an id to attach to.
// ─────────────────────────────────────────────────────────

function agreedCell(p: Policy) {
  if (p.status === 'draft') return <span className="t-mute">Not published</span>
  if (p.status === 'archived') return <span className="t-mute">Archived</span>
  if (!p.requires_acknowledgement) return <span className="t-mute">Not required</span>
  const total = p.signed_count + p.pending_count
  if (total === 0) return <span className="t-mute">No one yet</span>
  const done = p.pending_count === 0
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        aria-hidden
        style={{
          width: 56,
          height: 6,
          borderRadius: 99,
          background: 'var(--surf-3)',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${Math.round((p.signed_count / total) * 100)}%`,
            background: done ? 'var(--green)' : 'var(--blue)',
            borderRadius: 99,
          }}
        />
      </span>
      <span style={{ fontWeight: 800, color: done ? 'var(--green)' : 'var(--text)' }}>
        {p.signed_count} of {total} agreed
      </span>
    </span>
  )
}

export default function PoliciesSettingsPage() {
  const router = useRouter()
  const { toast } = useToast()
  const access = usePoliciesAccess()
  const { data, isLoading, isError, refetch } = usePolicies(access.canView)
  const create = useCreatePolicy()
  const [creating, setCreating] = useState(false)

  const items = data?.data ?? []
  const publishedCount = items.filter((p) => p.status === 'published').length

  const newPolicy = async () => {
    setCreating(true)
    try {
      const res = await create.mutateAsync({ title: 'Untitled policy', kind: 'rich_text' })
      router.push(`/settings/policies/${res.data.id}`)
    } catch (err) {
      setCreating(false)
      toast({
        title: 'Could not create the policy',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  if (!access.loaded) {
    return (
      <SettingsLayout>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} h={38} />)}
        </div>
      </SettingsLayout>
    )
  }

  if (!access.canView) {
    return (
      <SettingsLayout>
        <SectionHead title="Company policies" sub="Write policies, publish them and see who agreed." />
        <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
          <Icon.lock size={20} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>No access to manage policies</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)' }}>
            Ask an owner to grant you Policies under Settings → Module access. The policies that
            apply to you are on <Link href="/policies" style={{ color: 'var(--blue)', fontWeight: 800 }}>your Policies page</Link>.
          </div>
        </div>
      </SettingsLayout>
    )
  }

  return (
    <SettingsLayout>
      <div className="card">
        <SectionHead
          title="Company policies"
          sub={
            isLoading
              ? 'Loading…'
              : `${items.length} ${items.length === 1 ? 'policy' : 'policies'} · ${publishedCount} published`
          }
          right={
            access.canEdit ? (
              <Btn
                kind="primary"
                size="sm"
                icon={<Icon.plus size={13} />}
                onClick={() => void newPolicy()}
                disabled={creating}
              >
                {creating ? 'Creating…' : 'New policy'}
              </Btn>
            ) : (
              <Pill tone="blue">View only</Pill>
            )
          }
        />

        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} h={44} />)}
          </div>
        ) : isError ? (
          <div className="t-mute" style={{ padding: 18, fontSize: 12.5, textAlign: 'center' }}>
            Couldn&apos;t load policies.{' '}
            <button
              type="button"
              onClick={() => void refetch()}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontWeight: 800, cursor: 'pointer', padding: 0 }}
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '36px 24px' }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                margin: '0 auto 12px',
                background: 'color-mix(in srgb, var(--blue) 13%, transparent)',
                color: 'var(--blue)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon.clipboard size={20} />
            </div>
            <div className="t-h3" style={{ marginBottom: 6 }}>No policies yet</div>
            <p className="t-mute" style={{ maxWidth: 440, margin: '0 auto 16px', lineHeight: 1.55 }}>
              Write a policy or upload a PDF, publish it, and everyone it applies to is asked to
              read and agree at their next sign-in — you see who signed and who is still pending.
            </p>
            {access.canEdit && (
              <Btn kind="primary" icon={<Icon.plus size={14} />} onClick={() => void newPolicy()} disabled={creating}>
                {creating ? 'Creating…' : 'Create your first policy'}
              </Btn>
            )}
          </div>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Kind</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Agreed</th>
                  <th>Updated</th>
                  <th style={{ textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => router.push(`/settings/policies/${p.id}`)}
                    style={{ cursor: 'pointer', opacity: p.status === 'archived' ? 0.6 : 1 }}
                  >
                    <td>
                      <Link
                        href={`/settings/policies/${p.id}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)', textDecoration: 'none' }}
                      >
                        {p.title}
                      </Link>
                      <div className="t-caption" style={{ textTransform: 'none', letterSpacing: 0 }}>
                        {[p.category, policyAudienceLabel(p.applies_to_roles)].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>{policyKindPill(p.kind)}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 12.5 }}>v{p.version}</td>
                    <td>{policyStatusPill(p.status)}</td>
                    <td style={{ fontSize: 12.5 }}>{agreedCell(p)}</td>
                    <td className="t-mute" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                      {formatDate(p.updated_at)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Icon.chevR size={14} style={{ color: 'var(--text-faint)' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="t-caption" style={{ textTransform: 'none', letterSpacing: 0 }}>
        Published policies that require agreement block the next sign-in until the person agrees,
        and appear as a step in self-onboarding. Re-publish with &ldquo;Ask everyone to agree
        again&rdquo; after a material change.
      </div>
    </SettingsLayout>
  )
}
