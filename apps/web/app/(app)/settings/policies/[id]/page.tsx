'use client'

import { use } from 'react'
import Link from 'next/link'
import { Btn, Icon, Pill, Skeleton, SkeletonCard } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { PolicyEditor, policyKindPill, policyStatusPill } from '@/components/policies/PolicyEditor'
import { AcknowledgementsCard } from '@/components/policies/AcknowledgementsCard'
import { APIError } from '@/lib/api/client'
import { usePoliciesAccess, usePolicy } from '@/lib/api/queries/use-policies'
import { formatDate } from '@/lib/utils'

// ─────────────────────────────────────────────────────────
// Round P R3 — Settings → Company policies → one policy. Header (back link,
// title, kind / status pills, version, "12 of 20 agreed"), the editor card
// and the acknowledgements card.
// ─────────────────────────────────────────────────────────

export default function PolicyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const access = usePoliciesAccess()
  const policy = usePolicy(access.canView ? id : null)

  if (!access.loaded || (access.canView && policy.isLoading)) {
    return (
      <SettingsLayout>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Skeleton w={120} h={12} />
          <Skeleton w={320} h={22} />
          <SkeletonCard lines={5} />
          <SkeletonCard lines={3} />
        </div>
      </SettingsLayout>
    )
  }

  if (!access.canView) {
    return (
      <SettingsLayout>
        <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
          <Icon.lock size={20} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>No access to manage policies</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)' }}>
            Ask an owner to grant you Policies under Settings → Module access.
          </div>
        </div>
      </SettingsLayout>
    )
  }

  if (policy.isError || !policy.data) {
    const notFound = policy.error instanceof APIError && policy.error.status === 404
    return (
      <SettingsLayout>
        <BackLink />
        <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
          <Icon.warn size={20} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>
            {notFound ? 'Policy not found' : 'Couldn’t load this policy'}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginBottom: 14 }}>
            {notFound
              ? 'It may have been removed, or the link belongs to another workspace.'
              : policy.error instanceof Error
                ? policy.error.message
                : 'Please try again.'}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {!notFound && (
              <Btn kind="secondary" size="sm" icon={<Icon.refresh size={13} />} onClick={() => void policy.refetch()}>
                Retry
              </Btn>
            )}
            <Link href="/settings/policies" className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>
              All policies
            </Link>
          </div>
        </div>
      </SettingsLayout>
    )
  }

  const p = policy.data.data
  const total = p.signed_count + p.pending_count

  return (
    <SettingsLayout>
      <div>
        <BackLink />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div className="t-h2" style={{ marginBottom: 6, wordBreak: 'break-word' }}>{p.title}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {policyStatusPill(p.status)}
              {policyKindPill(p.kind)}
              <Pill>v{p.version}</Pill>
              {p.status === 'published' && p.requires_acknowledgement && (
                <span style={{ fontSize: 12, fontWeight: 800, color: p.pending_count === 0 && total > 0 ? 'var(--green)' : 'var(--text-2)' }}>
                  {total === 0 ? 'No one it applies to yet' : `${p.signed_count} of ${total} agreed`}
                </span>
              )}
              {p.published_at && (
                <span className="t-mute" style={{ fontSize: 12 }}>
                  · published {formatDate(p.published_at)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <PolicyEditor policy={p} canEdit={access.canEdit} />
      <AcknowledgementsCard policy={p} canEdit={access.canEdit} />
    </SettingsLayout>
  )
}

function BackLink() {
  return (
    <Link
      href="/settings/policies"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        fontWeight: 800,
        color: 'var(--text-mute)',
        textDecoration: 'none',
        marginBottom: 10,
      }}
    >
      <Icon.arrowL size={13} /> All policies
    </Link>
  )
}
