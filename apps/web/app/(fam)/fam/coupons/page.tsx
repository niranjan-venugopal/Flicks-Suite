'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Pill, SectionHead, Skeleton } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  downloadCouponCsv,
  useFamBillingOverview,
  useFamCouponBatch,
  useFamCouponRedemptions,
  useFamCouponUpdate,
  useFamCoupons,
  type FamCoupon,
} from '@/lib/api/queries/use-fam-billing'

/**
 * D21 — FAM coupon console (PRD v4 §8B.3, Sprint 22): batch mint (sequential
 * or random suffixes), table with filters, deactivate, CSV download, and a
 * per-code redemption drawer. D22 tiles ride along up top.
 */

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—'

function OverviewTiles() {
  const { data, isLoading } = useFamBillingOverview()
  const d = data?.data
  // Subtexts render only once data exists — "0 past due" while loading reads
  // as data, and +0-style placeholders are a known error class here.
  const tiles: Array<[string, string, string]> = [
    ['Platform MRR', d ? `₹${d.platform_mrr.toLocaleString('en-IN')}` : '—', d ? 'active subs only' : ''],
    ['Active subs', d ? String(d.active_subscriptions) : '—', d ? `${d.past_due} past due` : ''],
    ['Trial → paid', d ? `${d.trial_to_paid_pct}%` : '—', d ? `${d.trialing} still on trial` : ''],
    ['Coupons redeemed', d ? String(d.coupons_redeemed) : '—', d ? 'one per workspace' : ''],
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
      {tiles.map(([label, value, sub]) => (
        <div key={label} className="card" style={{ padding: '14px 16px' }}>
          <div className="t-caption" style={{ marginBottom: 6 }}>{label}</div>
          {isLoading ? (
            <Skeleton w={70} h={24} />
          ) : (
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{value}</div>
          )}
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 4 }}>{sub}</div>
        </div>
      ))}
    </div>
  )
}

function BatchForm({ onDone }: { onDone: (minted: number) => void }) {
  const { toast } = useToast()
  const batch = useFamCouponBatch()
  const [prefix, setPrefix] = useState('FLICKS')
  const [mode, setMode] = useState<'random' | 'sequential'>('random')
  const [count, setCount] = useState('50')
  const [months, setMonths] = useState(2)
  const [campaign, setCampaign] = useState('')
  const [maxRedemptions, setMaxRedemptions] = useState('1')
  const [expiresAt, setExpiresAt] = useState('')

  const countN = Math.max(1, Math.min(500, parseInt(count, 10) || 1))
  const maxRedemptionsN = Math.max(1, Math.min(1000, parseInt(maxRedemptions, 10) || 1))

  const mint = async () => {
    try {
      const res = await batch.mutateAsync({
        prefix,
        mode,
        count: countN,
        months,
        campaign: campaign || 'general',
        max_redemptions: maxRedemptionsN,
        expires_at: expiresAt ? new Date(`${expiresAt}T23:59:59+05:30`).toISOString() : undefined,
      })
      toast({
        title: `${res.data.minted} coupon${res.data.minted === 1 ? '' : 's'} minted`,
        description:
          res.data.minted < res.data.requested
            ? `${res.data.requested - res.data.minted} collided with existing codes and were skipped.`
            : undefined,
      })
      onDone(res.data.minted)
    } catch (err) {
      toast({
        title: 'Batch failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const field = { display: 'flex', flexDirection: 'column' as const, gap: 5 }
  return (
    <form
      className="card"
      style={{ padding: 18, marginBottom: 16 }}
      onSubmit={(e) => {
        e.preventDefault()
        if (!batch.isPending && prefix.trim()) void mint()
      }}
    >
      <div className="t-h3" style={{ marginBottom: 12 }}>Mint a batch</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, alignItems: 'end' }}>
        <div style={field}>
          <span className="label">Prefix</span>
          <input
            className="input font-mono uppercase"
            style={{ height: 36, fontSize: 12 }}
            value={prefix}
            maxLength={20}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
          />
        </div>
        <div style={field}>
          <span className="label">Suffix</span>
          <select className="input" style={{ height: 36, fontSize: 12 }} value={mode} onChange={(e) => setMode(e.target.value as never)}>
            <option value="random">Random (XXXXX)</option>
            <option value="sequential">Sequential (001…)</option>
          </select>
        </div>
        <div style={field}>
          <span className="label">Count</span>
          <input
            className="input"
            type="number"
            min={1}
            max={500}
            style={{ height: 36, fontSize: 12 }}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            onBlur={() => setCount(String(countN))}
          />
        </div>
        <div style={field}>
          <span className="label">Free months</span>
          <select className="input" style={{ height: 36, fontSize: 12 }} value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            <option value={2}>2 months</option>
            <option value={3}>3 months</option>
          </select>
        </div>
        <div style={field}>
          <span className="label">Uses per code</span>
          <input
            className="input"
            type="number"
            min={1}
            max={1000}
            style={{ height: 36, fontSize: 12 }}
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            onBlur={() => setMaxRedemptions(String(maxRedemptionsN))}
          />
        </div>
        <div style={field}>
          <span className="label">Expires (IST)</span>
          <input
            className="input"
            type="date"
            style={{ height: 36, fontSize: 12 }}
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'end', marginTop: 12 }}>
        <div style={{ ...field, flex: 1, maxWidth: 320 }}>
          <span className="label">Campaign</span>
          <input
            className="input"
            style={{ height: 36, fontSize: 12 }}
            placeholder="e.g. producthunt, founder, ca-partners"
            value={campaign}
            maxLength={60}
            onChange={(e) => setCampaign(e.target.value)}
          />
        </div>
        <Btn kind="primary" type="submit" disabled={batch.isPending || !prefix.trim()}>
          {batch.isPending ? 'Minting…' : `Mint ${countN} code${countN === 1 ? '' : 's'}`}
        </Btn>
      </div>
    </form>
  )
}

export default function FamCouponsPage() {
  const { toast } = useToast()
  const [campaignF, setCampaignF] = useState('')
  const [csvBusy, setCsvBusy] = useState(false)
  const [activeF, setActiveF] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const list = useFamCoupons({ campaign: campaignF || undefined, active: activeF || undefined })
  const update = useFamCouponUpdate()
  const rows = list.data?.data ?? []
  // Derived, never copied: the drawer always mirrors the refreshed row (a
  // frozen copy showed stale redemption counts / a just-deactivated state).
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null
  const redemptions = useFamCouponRedemptions(selected?.id ?? null)
  const campaigns = list.data?.meta.campaigns ?? []

  const toggle = async (c: FamCoupon) => {
    try {
      await update.mutateAsync({ id: c.id, active: !c.active })
      toast({ title: c.active ? `${c.code} deactivated` : `${c.code} reactivated` })
    } catch (err) {
      toast({
        title: 'Update failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Coupons"
          sub="Free-month codes for founder, community, and partner campaigns · redemptions extend a workspace's trial"
          right={
            <Btn
              kind="secondary"
              icon={<Icon.download size={13} />}
              disabled={csvBusy}
              onClick={async () => {
                setCsvBusy(true)
                try {
                  await downloadCouponCsv(campaignF || undefined)
                } catch (err) {
                  toast({
                    title: 'CSV download failed',
                    description: err instanceof Error ? err.message : undefined,
                    variant: 'destructive',
                  })
                } finally {
                  setCsvBusy(false)
                }
              }}
            >
              {csvBusy ? 'Preparing…' : `Download CSV${campaignF ? ` · ${campaignF}` : ''}`}
            </Btn>
          }
        />

        <OverviewTiles />
        <BatchForm onDone={() => list.refetch()} />

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <select className="input" style={{ height: 34, width: 220, fontSize: 11.5 }} value={campaignF} onChange={(e) => setCampaignF(e.target.value)}>
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.campaign} value={c.campaign}>
                {c.campaign} ({c.n})
              </option>
            ))}
          </select>
          <select className="input" style={{ height: 34, width: 150, fontSize: 11.5 }} value={activeF} onChange={(e) => setActiveF(e.target.value)}>
            <option value="">All states</option>
            <option value="true">Active</option>
            <option value="false">Deactivated</option>
          </select>
          <span className="t-caption" style={{ alignSelf: 'center', marginLeft: 'auto' }}>
            {rows.length} codes
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 320px' : '1fr', gap: 16, alignItems: 'start' }}>
          {/* Table */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {list.isLoading ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
                <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Campaign</th>
                    <th>Months</th>
                    <th>Redeemed</th>
                    <th>Expires</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      style={{ cursor: 'pointer', background: selected?.id === c.id ? 'var(--surf-1)' : 'transparent' }}
                    >
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 12 }}>{c.code}</td>
                      <td style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>{c.campaign}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{c.months}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>
                        {c.redemption_count}/{c.max_redemptions}
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-mute)' }}>{fmtDate(c.expires_at)}</td>
                      <td>
                        {c.active ? (
                          c.redemption_count >= c.max_redemptions ? (
                            <Pill tone="yellow" dot>Exhausted</Pill>
                          ) : (
                            <Pill tone="green" dot>Active</Pill>
                          )
                        ) : (
                          <Pill dot>Off</Pill>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Btn
                          kind="ghost"
                          size="sm"
                          disabled={update.isPending}
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation()
                            void toggle(c)
                          }}
                        >
                          {c.active ? 'Deactivate' : 'Reactivate'}
                        </Btn>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12.5 }}>
                        No coupons yet — mint a batch above or run scripts/seed-coupons.sh for the launch sets.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          {/* Redemption drawer */}
          {selected && (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 13, flex: 1 }}>{selected.code}</span>
                <button
                  onClick={() => setSelectedId(null)}
                  style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                >
                  <Icon.x size={12} />
                </button>
              </div>
              <div className="t-mute" style={{ fontSize: 11.5 }}>
                {selected.campaign} · {selected.months} free month{selected.months === 1 ? '' : 's'} ·{' '}
                {selected.redemption_count}/{selected.max_redemptions} used
              </div>
              <div className="label">Redemptions</div>
              {redemptions.isLoading ? (
                <Skeleton h={40} />
              ) : (redemptions.data?.data.length ?? 0) === 0 ? (
                <p className="t-mute" style={{ fontSize: 12 }}>Not redeemed yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {redemptions.data!.data.map((r) => (
                    <div key={r.id} style={{ padding: '9px 11px', borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)' }}>
                      <div style={{ fontSize: 12, fontWeight: 800 }}>{r.tenant_name}</div>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                        {r.redeemed_by_name ?? 'Unknown'} · {fmtDate(r.redeemed_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
