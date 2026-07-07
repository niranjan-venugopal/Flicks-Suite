'use client'

import { useEffect, useState } from 'react'
import { Btn, Icon, Pill, SectionHead, SkeletonCard, type PillTone } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  useBilling,
  useCancelPlan,
  useRedeemCoupon,
  useResumePlan,
  useSubscribe,
  type BillingState,
} from '@/lib/api/queries/use-billing'

/**
 * D18 — Billing & plan (PRD v4 §8B). Plan card with the four status states,
 * seats line, coupon input, payment history, cancel/resume. Owner/Admin
 * manage; everyone else gets a read-only banner.
 */

const STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  trialing: { label: 'Trial', tone: 'yellow' },
  active: { label: 'Active', tone: 'green' },
  past_due: { label: 'Payment due', tone: 'coral' },
  canceled: { label: 'Canceled', tone: '' },
  unpaid: { label: 'Halted', tone: 'coral' },
  paused: { label: 'Paused', tone: '' },
}

const HISTORY_LABEL: Record<string, string> = {
  'checkout.opened': 'Checkout opened',
  'mandate.authenticated': 'Payment method authorized',
  'subscription.activated': 'Subscription activated',
  'charge.succeeded': 'Payment received',
  'charge.failed': 'Payment failed',
  'subscription.halted': 'Subscription halted',
  'subscription.cancelled': 'Subscription cancelled',
  'cancellation.scheduled': 'Cancellation scheduled',
  'cancellation.reverted': 'Cancellation reverted',
  'coupon.redeemed': 'Coupon applied',
}

const fmtDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—'

function daysLeft(iso: string | null): number | null {
  if (!iso) return null
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
}

export default function BillingPage() {
  const { toast } = useToast()
  const { currentUser } = useAuthStore()
  const canManage = currentUser?.role === 'OWNER' || currentUser?.role === 'HR_ADMIN'
  const [checkoutOpened, setCheckoutOpened] = useState(false)
  const billing = useBilling({ poll: checkoutOpened })
  const subscribe = useSubscribe()
  const redeem = useRedeemCoupon()
  const cancelPlan = useCancelPlan()
  const resumePlan = useResumePlan()
  const [code, setCode] = useState('')

  const b = billing.data?.data
  // Stop polling once the webhook flips us to active.
  const active = b?.status === 'active'
  useEffect(() => {
    if (active && checkoutOpened) setCheckoutOpened(false)
  }, [active, checkoutOpened])

  if (billing.isError) {
    return (
      <SettingsLayout>
        <div className="card p-8 text-center">
          <p className="t-mute mb-4">Couldn&apos;t load your billing details — please try again.</p>
          <Btn kind="secondary" onClick={() => billing.refetch()}>
            Retry
          </Btn>
        </div>
      </SettingsLayout>
    )
  }
  if (billing.isLoading || !b) {
    return (
      <SettingsLayout>
        <div className="flex flex-col gap-6">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={3} />
        </div>
      </SettingsLayout>
    )
  }

  const meta = STATUS_META[b.status] ?? STATUS_META.trialing
  const trialDays = daysLeft(b.trial_ends_at)
  const graceDays = daysLeft(b.grace_ends_at)

  const onSubscribe = async () => {
    try {
      const res = await subscribe.mutateAsync()
      const url = res.data.authorization_url
      if (url) {
        window.open(url, '_blank', 'noopener')
        setCheckoutOpened(true)
        toast({
          title: 'Complete the payment in the Razorpay tab',
          description:
            'This page refreshes automatically once the subscription is live. If no tab opened, use "Resume checkout".',
        })
      } else {
        // Never a silent no-op: the server accepted but has no hosted page.
        toast({
          title: 'Checkout isn’t available right now',
          description: 'Online payment isn’t configured on this server yet.',
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: 'Could not start checkout',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const onRedeem = async () => {
    try {
      const res = await redeem.mutateAsync(code)
      setCode('')
      toast({
        title: `Coupon applied — ${res.data.months} free month${res.data.months === 1 ? '' : 's'}`,
        description: `Your trial now runs until ${fmtDate(res.data.trial_ends_at)}.`,
      })
    } catch (err) {
      toast({
        title: 'Coupon not applied',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const act = async (fn: () => Promise<unknown>, okTitle: string) => {
    try {
      await fn()
      toast({ title: okTitle })
    } catch (err) {
      toast({
        title: 'Action failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <SettingsLayout>
      <SectionHead
        title="Billing & plan"
        sub="₹499 per seat per month after the trial · auditors are never billed."
        right={<Pill tone={meta.tone} dot>{meta.label}</Pill>}
      />

      {!canManage && (
        <div className="card p-4 mb-6 flex items-start gap-3">
          <Icon.lock size={15} style={{ color: 'var(--text-mute)', flexShrink: 0, marginTop: 2 }} />
          <p className="t-mute text-sm leading-relaxed">
            You can see your workspace&apos;s plan here, but only an Owner or Admin can change it.
          </p>
        </div>
      )}

      {/* ─── Plan card ─────────────────────────────────────────────────────── */}
      <div className="card p-6 mb-6">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="t-h3" style={{ marginBottom: 4 }}>
              Flicks Suite · {b.plan.code} plan
            </div>
            <div className="t-mute" style={{ fontSize: 12.5, marginBottom: 14 }}>
              ₹{b.plan.price_rupees}/seat/month (~${b.plan.display_usd}) · billed monthly via Razorpay
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, fontWeight: 600 }}>
              <div>
                <span style={{ color: 'var(--text-2)' }}>{b.seats} billable seat{b.seats === 1 ? '' : 's'}</span>
                <span className="t-mute"> × ₹{b.plan.price_rupees} = </span>
                <span style={{ fontWeight: 800 }}>₹{b.monthly_total_rupees.toLocaleString('en-IN')}/month</span>
              </div>
              {b.status === 'trialing' && (
                <div className="t-mute">
                  Trial ends <strong style={{ color: 'var(--text-2)' }}>{fmtDate(b.trial_ends_at)}</strong>
                  {trialDays !== null && trialDays > 0 && <> · {trialDays} day{trialDays === 1 ? '' : 's'} left</>}
                </div>
              )}
              {b.status === 'active' && (
                <div className="t-mute">
                  Next charge on <strong style={{ color: 'var(--text-2)' }}>{fmtDate(b.current_period_end)}</strong>
                  {b.cancel_at_period_end && (
                    <span style={{ color: 'var(--yellow)' }}> · cancels at period end</span>
                  )}
                </div>
              )}
              {b.status === 'past_due' && (
                <div style={{ color: 'var(--coral)' }}>
                  Last charge failed
                  {graceDays !== null && graceDays > 0
                    ? ` — ${graceDays} day${graceDays === 1 ? '' : 's'} of access left. Update payment to keep the workspace open.`
                    : ' — the workspace is read-only until payment succeeds.'}
                </div>
              )}
              {(b.status === 'canceled' || b.status === 'unpaid') && (
                <div className="t-mute">
                  {b.status === 'canceled'
                    ? `Subscription ended${b.current_period_end ? ` on ${fmtDate(b.current_period_end)}` : ''}. Subscribe again anytime.`
                    : 'Charges are halted after repeated failures — subscribe again to restore billing.'}
                </div>
              )}
              {b.has_razorpay_subscription && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Pill tone={b.status === 'active' ? 'green' : 'yellow'} dot>
                    {b.status === 'active' ? 'Auto-debit mandate active' : 'Mandate pending authorization'}
                  </Pill>
                </div>
              )}
            </div>
          </div>

          {canManage && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
              {(b.status === 'trialing' || b.status === 'canceled' || b.status === 'unpaid') && (
                <Btn
                  kind="primary"
                  onClick={onSubscribe}
                  disabled={subscribe.isPending || !b.payments_configured}
                >
                  {subscribe.isPending ? 'Preparing checkout…' : 'Subscribe now'}
                </Btn>
              )}
              {b.status === 'past_due' && (
                <p className="t-caption" style={{ maxWidth: 220 }}>
                  Razorpay retries the charge automatically — no action needed
                  unless the payment method itself must change.
                </p>
              )}
              {b.authorization_url && b.status !== 'active' && (
                <Btn
                  kind="secondary"
                  onClick={() => {
                    window.open(b.authorization_url!, '_blank', 'noopener')
                    setCheckoutOpened(true)
                  }}
                >
                  Resume checkout
                </Btn>
              )}
              {b.status === 'active' && !b.cancel_at_period_end && (
                <Btn
                  kind="ghost"
                  onClick={() => act(() => cancelPlan.mutateAsync(), 'Cancellation scheduled for the period end')}
                  disabled={cancelPlan.isPending}
                >
                  Cancel at period end
                </Btn>
              )}
              {b.status === 'active' && b.cancel_at_period_end && (
                <Btn
                  kind="secondary"
                  onClick={() => act(() => resumePlan.mutateAsync(), 'Cancellation reverted — the plan continues')}
                  disabled={resumePlan.isPending}
                >
                  Keep my subscription
                </Btn>
              )}
              {!b.payments_configured && (
                <p className="t-caption" style={{ maxWidth: 220 }}>
                  Online payment isn&apos;t configured on this server yet — coupons still work.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ─── Coupon ────────────────────────────────────────────────────────── */}
      <div className="card p-6 mb-6">
        <div className="t-h3" style={{ marginBottom: 4 }}>Coupon</div>
        {b.coupon ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <Pill tone="green" dot>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{b.coupon.code}</span>
            </Pill>
            <span className="t-mute" style={{ fontSize: 12.5 }}>
              {b.coupon.months} free month{b.coupon.months === 1 ? '' : 's'} applied on {fmtDate(b.coupon.redeemed_at)} · one coupon per workspace
            </span>
          </div>
        ) : canManage ? (
          <>
            <p className="t-mute" style={{ fontSize: 12.5, marginBottom: 12 }}>
              Have a founder or community code? It extends your trial — one per workspace.
            </p>
            <div style={{ display: 'flex', gap: 8, maxWidth: 380 }}>
              <input
                className="input font-mono uppercase"
                style={{ flex: 1 }}
                placeholder="FLICKS-XXXX-XXXXX"
                value={code}
                maxLength={40}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && code.trim() && !redeem.isPending && onRedeem()}
              />
              <Btn kind="secondary" onClick={onRedeem} disabled={!code.trim() || redeem.isPending}>
                {redeem.isPending ? 'Checking…' : 'Apply'}
              </Btn>
            </div>
          </>
        ) : (
          <p className="t-mute" style={{ fontSize: 12.5 }}>No coupon applied.</p>
        )}
      </div>

      {/* ─── History ───────────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px 0' }}>
          <div className="t-h3">Billing history</div>
        </div>
        {b.history.length === 0 ? (
          <p className="t-mute" style={{ padding: '14px 20px 20px', fontSize: 12.5 }}>
            Nothing yet — activity appears here once you subscribe or apply a coupon.
          </p>
        ) : (
          <table className="tbl" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Event</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {b.history.map((h) => {
                const paise = (h.metadata as { amount_paise?: number } | null)?.amount_paise
                return (
                  <tr key={h.id}>
                    <td style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', whiteSpace: 'nowrap' }}>
                      {fmtDate(h.created_at)}
                    </td>
                    <td style={{ fontSize: 12.5, fontWeight: 700 }}>
                      {HISTORY_LABEL[h.event_type] ?? h.event_type}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {typeof paise === 'number' ? `₹${(paise / 100).toLocaleString('en-IN')}` : '—'}
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
