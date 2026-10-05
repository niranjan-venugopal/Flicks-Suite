'use client'

import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Btn, Icon, Modal, Pill, SectionHead, SkeletonCard } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { isPolicyReadable, PolicyReader } from '@/components/policies/PolicyReader'
import { useCurrentUser } from '@/lib/api/queries/use-auth'
import {
  useMyPolicyHistory,
  usePendingPolicies,
  usePolicy,
  type PendingPolicy,
  type PolicyDetail,
  type PolicyHistoryRow,
} from '@/lib/api/queries/use-policies'
import { api, APIError } from '@/lib/api/client'
import { formatDate } from '@/lib/utils'

/**
 * Round P (R3) — "My policies": every company policy that applies to the
 * signed-in member, as cards. A policy still to be agreed opens the reader
 * (same component the blocking gate uses); one already agreed shows
 * "Agreed on …" and opens read-only. Below, the full acknowledgement history
 * (every version ever signed, newest first).
 *
 * Data: /policies/pending (what still needs agreeing) + /policies/me/history
 * (what was agreed). History rows are not filtered by the policy's CURRENT
 * status, so each agreed policy is probed through GET /policies/:id (the
 * same `['policies','detail',id]` cache usePolicy uses): a 404 there means
 * archived / no longer applies to this role → it leaves the "applies to me"
 * grid and survives only in History (where View says so). The probe also
 * gives the current version, so an agreed card never claims an older
 * agreement covers a newer text.
 *
 * Open (v1): a published policy with requires_acknowledgement=false is in
 * neither list, so it is HR-only until the API grows a self-service
 * GET /policies/me (applicable published policies + my ack state).
 */

const EXEMPT_ROLES = new Set(['guest', 'auditor', 'fam', 'super_admin'])

type Card =
  | { kind: 'pending'; policy: PendingPolicy; previous?: PolicyHistoryRow }
  | { kind: 'agreed'; row: PolicyHistoryRow; detail?: PolicyDetail }

/** Same request + retry rule as usePolicy, so the probe and the modal share one cache entry. */
const policyDetailQuery = (id: string) => ({
  queryKey: ['policies', 'detail', id] as const,
  queryFn: () => api.get<{ data: PolicyDetail }>(`/api/v1/policies/${id}`),
  retry: (count: number, err: unknown) =>
    !(err instanceof APIError && (err.status === 404 || err.status === 403)) && count < 2,
})

const isGone = (err: unknown) => err instanceof APIError && (err.status === 404 || err.status === 403)

export default function MyPoliciesPage() {
  const { data: me } = useCurrentUser()
  const role = (me?.currentMembership?.role ?? me?.memberships?.[0]?.role ?? '').toLowerCase()
  const eligible = !!me && !!role && !EXEMPT_ROLES.has(role)

  const pending = usePendingPolicies(eligible)
  const history = useMyPolicyHistory(eligible)
  const { toast } = useToast()

  const [open, setOpen] = useState<{ id: string; mode: 'pending' | 'agreed' } | null>(null)

  const pendingList = useMemo(() => pending.data?.data ?? [], [pending.data])
  const historyRows = useMemo(() => history.data?.data ?? [], [history.data])

  // Latest acknowledgement per policy (history is newest first).
  const latestByPolicy = useMemo(() => {
    const m = new Map<string, PolicyHistoryRow>()
    for (const r of historyRows) if (!m.has(r.policy_id)) m.set(r.policy_id, r)
    return m
  }, [historyRows])

  // Agreed policies not currently pending → probe whether they are still
  // live for this member (see header). Bounded by the distinct policies the
  // member ever signed; results are cached 5 min like every detail.
  const pendingIds = useMemo(() => new Set(pendingList.map((p) => p.id)), [pendingList])
  const agreedIds = useMemo(
    () => [...latestByPolicy.keys()].filter((id) => !pendingIds.has(id)),
    [latestByPolicy, pendingIds],
  )
  const probes = useQueries({
    queries: agreedIds.map((id) => ({ ...policyDetailQuery(id), enabled: eligible })),
  })
  const probesLoading = probes.some((q) => q.isPending && q.fetchStatus !== 'idle')

  const cards = useMemo<Card[]>(() => {
    const out: Card[] = pendingList.map((policy) => ({
      kind: 'pending',
      policy,
      previous: latestByPolicy.get(policy.id),
    }))
    agreedIds.forEach((id, i) => {
      const row = latestByPolicy.get(id)
      if (!row) return
      const q = probes[i]
      // Settled 404/403 = archived or no longer applies → not "mine" any more
      // (History below still lists the agreement). Anything else — loading,
      // 5xx, network — keeps the card: never hide a live policy over a
      // transient failure.
      if (q && q.isError && isGone(q.error)) return
      out.push({ kind: 'agreed', row, detail: q?.data?.data })
    })
    return out
  }, [pendingList, latestByPolicy, agreedIds, probes])

  const loading = eligible && (pending.isLoading || history.isLoading || probesLoading)
  const failed = eligible && (pending.isError || history.isError)

  const openPending = open?.mode === 'pending' ? pendingList.find((p) => p.id === open.id) ?? null : null

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1080, margin: '0 auto' }}>
        <SectionHead
          title="Company policies"
          sub="Policies that apply to you, and what you've agreed to"
          right={
            pendingList.length > 0 ? (
              <Pill tone="coral" dot>
                {pendingList.length} to agree
              </Pill>
            ) : eligible && !loading && !failed ? (
              <Pill tone="green" icon={<Icon.check size={11} />}>
                All agreed
              </Pill>
            ) : null
          }
        />

        {!eligible ? (
          <EmptyCard
            title="Policies don't apply to this seat"
            body="Company policies are asked of employees, managers, finance and admins. There is nothing for you to agree to here."
            testId="policies-not-applicable"
          />
        ) : loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : failed ? (
          <EmptyCard
            title="Couldn't load your policies"
            body="We couldn't reach the server just now. Try again in a moment."
            action={
              <Btn
                kind="primary"
                icon={<Icon.refresh size={14} />}
                onClick={() => {
                  void pending.refetch()
                  void history.refetch()
                }}
              >
                Retry
              </Btn>
            }
          />
        ) : cards.length === 0 ? (
          <EmptyCard
            title="No policies yet"
            body="When HR publishes a company policy that applies to you, it shows up here to read and agree."
            testId="policies-empty"
          />
        ) : (
          <div
            data-testid="policies-cards"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}
          >
            {cards.map((c) =>
              c.kind === 'pending' ? (
                <PolicyCard
                  key={`p:${c.policy.id}`}
                  title={c.policy.title}
                  category={c.policy.category}
                  kind={c.policy.kind}
                  version={c.policy.version}
                  publishedAt={c.policy.published_at}
                  status="pending"
                  note={
                    !isPolicyReadable(c.policy)
                      ? 'The PDF is temporarily unavailable — it will not block your sign-in; agree once it loads.'
                      : c.previous
                        ? `You agreed to v${c.previous.version} on ${formatDate(c.previous.acknowledged_at)} — this version is new.`
                        : undefined
                  }
                  onOpen={() => setOpen({ id: c.policy.id, mode: 'pending' })}
                />
              ) : (
                <PolicyCard
                  key={`a:${c.row.policy_id}`}
                  title={c.detail?.title ?? c.row.title}
                  category={c.detail?.category}
                  kind={c.detail?.kind}
                  version={c.detail?.version ?? c.row.version}
                  publishedAt={c.detail?.published_at}
                  status="agreed"
                  agreedAt={c.row.acknowledged_at}
                  onOpen={() => setOpen({ id: c.row.policy_id, mode: 'agreed' })}
                />
              ),
            )}
          </div>
        )}

        {eligible && !loading && !failed && historyRows.length > 0 && (
          <div className="card" style={{ marginTop: 28, padding: 0, overflow: 'hidden' }} data-testid="policies-history">
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--bord)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div className="t-h3" style={{ fontSize: 14 }}>History</div>
                <div className="t-mute" style={{ fontSize: 12, marginTop: 2 }}>
                  Every policy version you&apos;ve agreed to
                </div>
              </div>
              <Pill>{historyRows.length}</Pill>
            </div>
            <div>
              {historyRows.map((r, i) => (
                <div
                  key={`${r.policy_id}:${r.version}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '12px 20px',
                    borderTop: i ? '1px solid var(--bord)' : 'none',
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 9,
                      background: 'rgb(var(--green-rgb) / 0.1)',
                      color: 'var(--green)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon.check size={14} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.title}
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                      Version {r.version}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                    Agreed on {formatDate(r.acknowledged_at)}
                  </div>
                  <Btn
                    kind="ghost"
                    size="sm"
                    onClick={() => setOpen({ id: r.policy_id, mode: 'agreed' })}
                    icon={<Icon.eye size={13} />}
                  >
                    View
                  </Btn>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Reader for a policy still to agree */}
      <Modal
        open={!!openPending}
        onClose={() => setOpen(null)}
        title="Read & agree"
        sub="Your agreement is recorded with the policy version and time."
        width={780}
      >
        {openPending && (
          <PolicyReader
            key={`${openPending.id}:${openPending.version}`}
            policy={openPending}
            onRefetch={() => pending.refetch()}
            onAcknowledged={() => {
              toast({ title: 'Thanks — agreement recorded', description: openPending.title })
              setOpen(null)
            }}
            testId="policies-page-reader"
          />
        )}
      </Modal>

      {/* Read-only view of a policy already agreed */}
      {open?.mode === 'agreed' && (
        <AgreedPolicyModal
          id={open.id}
          agreedAt={latestByPolicy.get(open.id)?.acknowledged_at ?? null}
          agreedVersion={latestByPolicy.get(open.id)?.version ?? null}
          stillPending={pendingIds.has(open.id)}
          onReadPending={() => setOpen({ id: open.id, mode: 'pending' })}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function PolicyCard({
  title,
  category,
  kind,
  version,
  publishedAt,
  status,
  agreedAt,
  note,
  onOpen,
}: {
  title: string
  category?: string | null
  kind?: 'rich_text' | 'pdf'
  version: number
  publishedAt?: string | null
  status: 'pending' | 'agreed'
  agreedAt?: string | null
  note?: string
  onOpen: () => void
}) {
  const isPending = status === 'pending'
  return (
    <div
      className="card"
      data-testid={`policy-card-${status}`}
      style={{
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        borderColor: isPending ? 'color-mix(in srgb, var(--coral) 35%, var(--bord))' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            flexShrink: 0,
            background: isPending ? 'rgb(var(--coral-rgb) / 0.1)' : 'rgb(var(--green-rgb) / 0.1)',
            color: isPending ? 'var(--coral)' : 'var(--green)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isPending ? <Icon.clipboard size={17} /> : <Icon.check size={17} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.3 }}>{title}</div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              marginTop: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--text-mute)',
            }}
          >
            {kind && <Pill tone={kind === 'pdf' ? 'purple' : 'blue'}>{kind === 'pdf' ? 'PDF' : 'Policy'}</Pill>}
            <span style={{ fontFamily: 'var(--font-mono)' }}>v{version}</span>
            {category && <span>· {category}</span>}
            {publishedAt && <span>· {formatDate(publishedAt)}</span>}
          </div>
        </div>
      </div>
      {note && (
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.5 }}>{note}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 'auto' }}>
        {isPending ? (
          <Pill tone="coral" dot>
            Needs your agreement
          </Pill>
        ) : (
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>
            Agreed on {agreedAt ? formatDate(agreedAt) : '—'}
          </span>
        )}
        <Btn
          kind={isPending ? 'primary' : 'secondary'}
          size="sm"
          onClick={onOpen}
          iconRight={isPending ? <Icon.arrow size={12} /> : undefined}
          icon={isPending ? undefined : <Icon.eye size={12} />}
        >
          {isPending ? 'Read & agree' : 'View'}
        </Btn>
      </div>
    </div>
  )
}

/**
 * Read-only view of a policy the member agreed to. GET /policies/:id is
 * always the CURRENT version, so the "Agreed on …" banner is only shown
 * when that version is the one in the history row; otherwise the modal says
 * plainly which version was agreed and that the current one is new.
 */
function AgreedPolicyModal({
  id,
  agreedAt,
  agreedVersion,
  stillPending,
  onReadPending,
  onClose,
}: {
  id: string
  agreedAt: string | null
  agreedVersion: number | null
  /** The current version is in the member's pending list (re-ack asked). */
  stillPending: boolean
  onReadPending: () => void
  onClose: () => void
}) {
  const detail = usePolicy(id)
  const policy = detail.data?.data
  const gone = detail.isError && isGone(detail.error)
  const sameVersion = !!policy && agreedVersion !== null && policy.version === agreedVersion
  const agreedLabel =
    agreedAt && agreedVersion !== null ? `Agreed to v${agreedVersion} on ${formatDate(agreedAt)}` : undefined
  return (
    <Modal open onClose={onClose} title={policy?.title ?? 'Policy'} sub={agreedLabel} width={780}>
      {detail.isLoading ? (
        <SkeletonCard />
      ) : gone ? (
        <EmptyCard
          title="This policy is no longer active"
          body="It was archived or no longer applies to your role. Your earlier agreement stays on record."
          flat
        />
      ) : detail.isError || !policy ? (
        <EmptyCard
          title="Couldn't load this policy"
          body="Try again in a moment."
          action={
            <Btn kind="primary" icon={<Icon.refresh size={14} />} onClick={() => void detail.refetch()}>
              Retry
            </Btn>
          }
          flat
        />
      ) : (
        <PolicyReader
          key={`${policy.id}:${policy.version}`}
          policy={policy}
          acknowledgedAt={sameVersion ? agreedAt : null}
          readOnly={!agreedAt || !sameVersion}
          onRefetch={() => detail.refetch()}
          footerNote={
            !sameVersion && agreedVersion !== null ? (
              <div
                data-testid="policies-page-version-note"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '11px 13px',
                  borderRadius: 10,
                  background: 'rgb(var(--blue-rgb) / 0.06)',
                  border: '1px solid rgb(var(--blue-rgb) / 0.2)',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'var(--text-2)',
                  lineHeight: 1.5,
                }}
              >
                <span>
                  You agreed to <strong style={{ color: 'var(--text)' }}>v{agreedVersion}</strong>
                  {agreedAt ? ` on ${formatDate(agreedAt)}` : ''}. This is{' '}
                  <strong style={{ color: 'var(--text)' }}>v{policy.version}</strong>
                  {stillPending ? ', which is awaiting your agreement.' : ' — the current text.'}
                </span>
                {stillPending && (
                  <Btn kind="primary" size="sm" onClick={onReadPending} iconRight={<Icon.arrow size={12} />}>
                    Read &amp; agree
                  </Btn>
                )}
              </div>
            ) : undefined
          }
          testId="policies-page-agreed-reader"
        />
      )}
    </Modal>
  )
}

function EmptyCard({
  title,
  body,
  action,
  flat,
  testId,
}: {
  title: string
  body: string
  action?: React.ReactNode
  flat?: boolean
  testId?: string
}) {
  return (
    <div
      className={flat ? undefined : 'card'}
      data-testid={testId}
      style={{
        padding: flat ? '30px 10px' : 50,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Icon.doc size={26} style={{ color: 'var(--text-faint)', marginBottom: 4 }} />
      <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
      <div className="t-mute" style={{ maxWidth: 420, lineHeight: 1.55, fontSize: 12.5 }}>{body}</div>
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  )
}
