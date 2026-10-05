'use client'

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Btn, Icon, Pill, SectionHead, SkeletonCard } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { MyAssetCard } from '@/components/assets/MyAssetCard'
import { useAcknowledgeAsset, useMyAssets, type MyAsset } from '@/lib/api/queries/use-assets'
import { APIError } from '@/lib/api/client'

const MY_ASSETS_KEY = ['assets', 'me'] as const

// `min(320px, 100%)` lets a track shrink to the column on a phone (the
// sidebar rail leaves ~250px at 390px wide) instead of forcing a 320px card
// that pushes the Acknowledge button off-screen behind a horizontal scroll.
const CARD_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
  gap: 16,
}

/**
 * Round P R4 — "My assets": the company equipment currently issued to the
 * signed-in person (laptop, phone, SIM, ID card …), one card each, with the
 * receipt acknowledgement HR asked for. GET /assets/me is open to every
 * workspace member; a seat without an employee record (auditor, a platform
 * admin looking in) simply gets [] and sees the same empty state as a new
 * hire nobody has equipped yet. The one exception is a GUEST seat: the API's
 * guest allowlist does not include /assets, so the call 403s — that is shown
 * as an honest "not tracked for your seat" state, never a Retry loop.
 */
export default function MyAssetsPage() {
  const my = useMyAssets()
  const ack = useAcknowledgeAsset()
  const qc = useQueryClient()
  const { toast } = useToast()

  // Asset ids with an acknowledgement in flight. One mutation hook serves
  // every card and TanStack's observer only tracks its LAST mutate() call
  // (`isPending` / `variables` flip to the newest, and the earlier call's
  // per-call callbacks never fire), so the per-card "Recording…" state and
  // each click's own toast are tracked here instead.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())

  const items = useMemo<MyAsset[]>(() => my.data?.data ?? [], [my.data])
  // Unacknowledged first, then newest issue first (the API already orders by
  // assigned_at desc; the stable sort keeps that within each group).
  const ordered = useMemo(
    () =>
      [...items].sort((a, b) => {
        const pa = a.assignment.acknowledged_at ? 1 : 0
        const pb = b.assignment.acknowledged_at ? 1 : 0
        return pa - pb
      }),
    [items],
  )
  const pendingCount = items.filter((i) => !i.assignment.acknowledged_at).length

  const acknowledge = async (assetId: string) => {
    if (busy.has(assetId)) return
    const item = items.find((i) => i.asset.id === assetId)
    setBusy((prev) => new Set(prev).add(assetId))
    try {
      // mutateAsync returns THIS call's promise even when a later click
      // re-points the observer, so every card gets its own outcome.
      const res = await ack.mutateAsync(assetId)
      // Flip the card straight away; the hook's invalidation re-fetches the
      // list behind it and lands on the same state. Without this the card
      // kept an enabled "Acknowledge receipt" until the refetch arrived.
      qc.setQueryData<{ data: MyAsset[] }>(MY_ASSETS_KEY, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((m) =>
                m.asset.id === assetId
                  ? { ...m, assignment: { ...m.assignment, acknowledged_at: res.data.acknowledged_at } }
                  : m,
              ),
            }
          : old,
      )
      toast({
        title: 'Thanks — receipt recorded',
        description: item ? `${item.asset.name} (${item.asset.asset_tag})` : undefined,
      })
    } catch (err) {
      const status = err instanceof APIError ? err.status : 0
      toast({
        title:
          status === 403
            ? 'This asset is not assigned to you'
            : status === 404
              ? 'This asset is no longer assigned to you'
              : 'Could not record your receipt',
        description: err instanceof Error ? err.message : 'Please try again',
        variant: 'destructive',
      })
      // 403/404 mean the register moved under us (returned / reassigned) —
      // refresh so the card disappears instead of failing again.
      if (status === 403 || status === 404) void my.refetch()
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(assetId)
        return next
      })
    }
  }

  // A 403 is the guest-scope guard (guest seats are project-scoped and
  // /assets is not on their allowlist); a 404 is an API older than R4. Both
  // are permanent for this session — Retry would only fail again.
  const loadStatus = my.isError && my.error instanceof APIError ? my.error.status : 0
  const unavailable = loadStatus === 403 || loadStatus === 404

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1080, margin: '0 auto' }}>
        <SectionHead
          title="My assets"
          sub="Company equipment issued to you"
          right={
            pendingCount > 0 ? (
              <Pill tone="coral" dot>
                {pendingCount} to acknowledge
              </Pill>
            ) : items.length > 0 ? (
              <Pill tone="green" icon={<Icon.check size={11} />}>
                All acknowledged
              </Pill>
            ) : null
          }
        />

        {my.isLoading ? (
          <div data-testid="my-assets-loading" style={CARD_GRID}>
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonCard key={i} lines={4} />
            ))}
          </div>
        ) : unavailable ? (
          loadStatus === 403 ? (
            <EmptyCard
              title="Equipment isn't tracked for your seat"
              body="Company equipment is issued to workspace members. If you were handed something, ask the HR admin who issued it."
              testId="my-assets-unavailable"
            />
          ) : (
            <EmptyCard
              title="Nothing issued to you yet"
              body="When HR assigns you equipment it shows up here."
              testId="my-assets-empty"
            />
          )
        ) : my.isError ? (
          <EmptyCard
            title="Couldn't load your assets"
            body="We couldn't reach the server just now. Try again in a moment."
            testId="my-assets-error"
            action={
              <Btn kind="primary" icon={<Icon.refresh size={14} />} onClick={() => void my.refetch()}>
                Retry
              </Btn>
            }
          />
        ) : ordered.length === 0 ? (
          <EmptyCard
            title="Nothing issued to you yet"
            body="When HR assigns you equipment it shows up here."
            testId="my-assets-empty"
          />
        ) : (
          <div data-testid="my-assets-cards" style={CARD_GRID}>
            {ordered.map((item) => (
              <MyAssetCard
                key={item.assignment.id}
                item={item}
                onAcknowledge={(id) => void acknowledge(id)}
                acknowledging={busy.has(item.asset.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyCard({
  title,
  body,
  action,
  testId,
}: {
  title: string
  body: string
  action?: React.ReactNode
  testId?: string
}) {
  return (
    <div
      className="card"
      data-testid={testId}
      style={{
        padding: 50,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Icon.laptop size={26} style={{ color: 'var(--text-faint)', marginBottom: 4 }} />
      <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
      <div className="t-mute" style={{ maxWidth: 420, lineHeight: 1.55, fontSize: 12.5 }}>
        {body}
      </div>
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  )
}
