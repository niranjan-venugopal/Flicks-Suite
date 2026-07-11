'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw, Plus } from 'lucide-react'
import { Btn, Pill, SectionHead, Toggle } from '@/components/proto'
import { InvoPage, InvoTable, InvoRow, invoTh, invoTd, INVO } from '@/components/invoicing/invo'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  useSubscriptions,
  useCreateSubscription,
  useSubscriptionAction,
  useUpdateSeats,
  useCustomers,
  useSubscriptionMandate,
  useChargeAttempts,
  useEnableAutodebit,
  useDisableAutodebit,
  type SubscriptionRow,
  type SubscriptionInput,
} from '@/lib/api/queries/use-invoicing'
import type { PillTone } from '@/components/proto/Pill'

const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)
const inr = (v: string | number, c = 'INR') => `${symbol(c)}${Number(v).toLocaleString('en-IN')}`
const today = () => new Date().toISOString().slice(0, 10)

const STATUS_TONE: Record<string, PillTone> = {
  ACTIVE: 'green',
  TRIALING: 'blue',
  PENDING_MANDATE: 'yellow',
  PAST_DUE: 'coral',
  PAUSED: 'yellow',
  CANCELLED: '',
  EXPIRED: '',
}

function cycleAmount(s: SubscriptionRow): number {
  return s.pricing_model === 'per_seat'
    ? parseFloat(s.seat_rate ?? '0') * (s.seat_count ?? 0)
    : parseFloat(s.flat_amount ?? '0')
}

// D14b mandate chip — explicit label + tone per PRD §8.3 enum. 'green' active,
// 'coral' terminal-bad (halted/revoked/failed), 'yellow' in-progress.
type MandateTone = 'green' | 'coral' | 'yellow' | 'gray'
const MANDATE_CHIP: Record<string, { label: string; tone: MandateTone }> = {
  none: { label: 'None', tone: 'gray' },
  pending_authorization: { label: 'Awaiting authorization', tone: 'yellow' },
  authenticated: { label: 'Active', tone: 'green' },
  active: { label: 'Active', tone: 'green' },
  paused: { label: 'Paused', tone: 'yellow' },
  halted: { label: 'Halted', tone: 'coral' },
  revoked: { label: 'Revoked', tone: 'coral' },
  failed: { label: 'Failed', tone: 'coral' },
}
function mandateChip(status: string): { label: string; bg: string; color: string } {
  const { label, tone } = MANDATE_CHIP[status] ?? {
    label: status.replace(/_/g, ' '),
    tone: 'yellow' as MandateTone,
  }
  const bg =
    tone === 'green' ? 'rgba(39,210,128,.14)'
      : tone === 'coral' ? 'rgba(248,120,107,.14)'
        : tone === 'gray' ? 'rgba(140,140,160,.14)'
          : 'rgba(254,216,0,.12)'
  const color =
    tone === 'green' ? 'var(--green)'
      : tone === 'coral' ? 'var(--coral)'
        : tone === 'gray' ? 'var(--text-2)'
          : 'var(--yellow)'
  return { label, bg, color }
}

/** New subscription — prototype SubscriptionModal (cadence buttons, MRR footer). */
function SubscriptionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast()
  const create = useCreateSubscription()
  const { data: customersData } = useCustomers({})
  const [name, setName] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [model, setModel] = useState<'flat_rate' | 'per_seat'>('flat_rate')
  const [cadence, setCadence] = useState<'monthly' | 'quarterly' | 'annually'>('monthly')
  const [amount, setAmount] = useState('')
  const [seatRate, setSeatRate] = useState('')
  const [seats, setSeats] = useState('5')
  const [start, setStart] = useState(today())
  const [collection, setCollection] = useState<'manual' | 'auto_debit'>('manual')
  const enableAutodebit = useEnableAutodebit()

  const cycle = model === 'per_seat' ? parseFloat(seatRate || '0') * parseInt(seats || '0', 10) : parseFloat(amount || '0')
  const mrr = cadence === 'monthly' ? cycle : cadence === 'quarterly' ? cycle / 3 : cycle / 12
  const canSave = !!name.trim() && !!customerId && cycle > 0

  const save = async () => {
    if (!canSave) return
    const payload: SubscriptionInput = {
      customer_id: customerId,
      name: name.trim(),
      pricing_model: model,
      billing_period: cadence,
      start_date: start,
      ...(model === 'flat_rate'
        ? { flat_amount: parseFloat(amount).toFixed(2) }
        : { seat_rate: parseFloat(seatRate).toFixed(2), seat_count: parseInt(seats, 10) }),
    }
    try {
      const created = await create.mutateAsync(payload)
      if (collection === 'auto_debit') {
        // D14a: auto-debit selected → set up the Razorpay mandate right away.
        // Failure (Razorpay not connected, non-INR) leaves a valid MANUAL
        // profile — never a half-created one.
        try {
          const m = await enableAutodebit.mutateAsync(created.data.id)
          toast({
            title: `"${name.trim()}" created — mandate request sent`,
            description: m.data.public_url
              ? 'Your customer received the authorization link by email; you can copy it from the profile drawer too.'
              : undefined,
          })
        } catch (err) {
          toast({
            title: 'Created as MANUAL — auto-debit setup failed',
            description: err instanceof Error ? err.message : undefined,
            variant: 'destructive',
          })
        }
      } else {
        toast({ title: `Subscription "${name.trim()}" created`, description: 'Invoices will be generated and emailed each cycle.' })
      }
      setName(''); setAmount(''); setSeatRate(''); setCollection('manual')
      onClose()
    } catch (err) {
      toast({ title: 'Could not create subscription', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>New subscription</DialogTitle>
          <p className="t-mute text-xs mt-1">Recurring profile · auto-generates and sends invoices on schedule</p>
        </DialogHeader>
        <div className="py-1">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="label">Profile name</div>
              <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Design retainer" autoFocus />
            </div>
            <div>
              <div className="label">Customer</div>
              <select className="input w-full" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Select…</option>
                {(customersData?.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.display_name}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="label">Pricing model</div>
              <select className="input w-full" value={model} onChange={(e) => setModel(e.target.value as 'flat_rate' | 'per_seat')}>
                <option value="flat_rate">Flat rate</option>
                <option value="per_seat">Per seat</option>
              </select>
            </div>
            {model === 'flat_rate' ? (
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="label">Amount (₹) · per cycle</div>
                <input className="input t-num w-full" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="80000" />
              </div>
            ) : (
              <>
                <div>
                  <div className="label">Rate per seat (₹)</div>
                  <input className="input t-num w-full" type="number" min={0} value={seatRate} onChange={(e) => setSeatRate(e.target.value)} placeholder="1000" />
                </div>
                <div>
                  <div className="label">Seats</div>
                  <input className="input t-num w-full" type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />
                </div>
              </>
            )}
          </div>

          <div className="label">Cadence</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {(['monthly', 'quarterly', 'annually'] as const).map((c) => {
              const sel = cadence === c
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCadence(c)}
                  style={{
                    flex: 1,
                    padding: 10,
                    borderRadius: 10,
                    cursor: 'pointer',
                    background: sel ? 'rgba(62,123,250,.1)' : 'var(--surf-1)',
                    border: `1px solid ${sel ? 'rgba(62,123,250,.4)' : 'var(--bord)'}`,
                    color: sel ? '#fff' : 'var(--text-2)',
                    fontSize: 12.5,
                    fontWeight: 800,
                    textTransform: 'capitalize',
                  }}
                >
                  {c}
                </button>
              )
            })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
            <div>
              <div className="label">First invoice date</div>
              <input className="input w-full" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
          </div>

          {/* D14a — Collection (PRD v4 §8A) */}
          <div className="label">Collection</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {([
              ['manual', 'Manual', 'Send invoices each cycle — customer pays via link/UPI'],
              ['auto_debit', 'Auto-debit', 'Razorpay e-mandate — INR only, charges automatically'],
            ] as const).map(([k, label, hint]) => {
              const sel = collection === k
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setCollection(k)}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRadius: 10,
                    cursor: 'pointer',
                    textAlign: 'left',
                    background: sel ? 'rgba(62,123,250,.1)' : 'var(--surf-1)',
                    border: `1px solid ${sel ? 'rgba(62,123,250,.4)' : 'var(--bord)'}`,
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: sel ? '#fff' : 'var(--text-2)' }}>{label}</div>
                  <div className="t-mute" style={{ fontSize: 10.5, marginTop: 2 }}>{hint}</div>
                </button>
              )
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', borderRadius: 10, background: 'var(--surf-1)', border: '1px solid var(--bord)', marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 800 }}>Auto-send on generation</div>
              <div className="t-mute" style={{ fontSize: 11.5, marginTop: 2 }}>Each cycle emails the hosted invoice link the moment it runs</div>
            </div>
            <Toggle on={true} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: 10, background: 'rgba(39,210,128,.08)', border: '1px solid rgba(39,210,128,.25)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)' }}>Normalised MRR</span>
            <span className="t-num" style={{ fontSize: 17, fontWeight: 800, color: 'var(--green)' }}>{cycle ? inr(Math.round(mrr)) : '—'}</span>
          </div>
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={save} disabled={!canSave || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create subscription'}
          </Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Recurring — prototype ScrRecurring (profiles + MRR + lifecycle actions). */
export default function RecurringPage() {
  const { toast } = useToast()
  const { data, isLoading } = useSubscriptions()
  const action = useSubscriptionAction()
  const updateSeats = useUpdateSeats()
  const [modal, setModal] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const rows = data?.data ?? []
  const detailRow = detailId ? (rows.find((r) => r.id === detailId) ?? null) : null
  const active = rows.filter((s) => ['ACTIVE', 'TRIALING'].includes(s.status))

  const onAction = async (s: SubscriptionRow, act: 'activate' | 'pause' | 'resume' | 'cancel') => {
    try {
      await action.mutateAsync({ id: s.id, action: act })
      toast({ title: `Subscription ${act === 'activate' ? 'started' : `${act}d`}` })
    } catch (err) {
      toast({ title: 'Action failed', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const onSeats = async (s: SubscriptionRow) => {
    const next = window.prompt(`Seats for "${s.name}" (currently ${s.seat_count})`, String(s.seat_count ?? 1))
    if (!next) return
    try {
      const res = await updateSeats.mutateAsync({ id: s.id, seat_count: parseInt(next, 10) })
      toast({
        title: 'Seats updated',
        description: res.meta.proration ? `Proration of ₹${res.meta.proration.amount} applies to the next invoice.` : undefined,
      })
    } catch (err) {
      toast({ title: 'Could not update seats', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <InvoPage glow="green">
      <SectionHead
        title="Recurring"
        sub={isLoading ? 'Loading profiles…' : `${active.length} active profiles · MRR ${inr(data?.meta.mrr ?? '0')}`}
        right={
          <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setModal(true)}>
            New subscription
          </Btn>
        }
      />

      <InvoTable
        head={
          <>
            <th style={invoTh}>Profile</th>
            <th style={invoTh}>Customer</th>
            <th style={invoTh}>Cadence</th>
            <th style={invoTh}>Next run</th>
            <th style={{ ...invoTh, textAlign: 'right' }}>Amount</th>
            <th style={invoTh}>Status</th>
            <th style={invoTh}></th>
          </>
        }
      >
        {isLoading && <tr><td colSpan={7} style={{ ...invoTd, color: INVO.muted40 }}>Loading…</td></tr>}
        {!isLoading && rows.length === 0 && (
          <tr><td colSpan={7} style={{ ...invoTd, color: INVO.muted30 }}>No subscriptions yet — create a recurring profile.</td></tr>
        )}
        {rows.map((s, i) => (
          <InvoRow key={s.id} index={i}>
            <td style={invoTd}>
              <b>{s.name}</b>
              {s.pricing_model === 'per_seat' && <div style={{ ...invoTd, padding: 0, fontSize: 12, color: INVO.muted40 }}>{s.seat_count} seats × {inr(s.seat_rate ?? 0, s.currency)}</div>}
            </td>
            <td style={invoTd}>{s.customer_name ?? '—'}</td>
            <td style={{ ...invoTd, textTransform: 'capitalize' }}>{s.billing_period}</td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{s.next_billing_date ?? '—'}</td>
            <td style={{ ...invoTd, textAlign: 'right', fontWeight: 800 }}>{inr(cycleAmount(s), s.currency)}</td>
            <td style={invoTd}>
              <Pill tone={STATUS_TONE[s.status] ?? ''} dot>{s.status.replace(/_/g, ' ').toLowerCase()}</Pill>
              {/* D14b — mandate chip */}
              {s.collection_mode === 'auto_debit' && (() => {
                const chip = mandateChip(s.mandate_status)
                return (
                <div style={{ marginTop: 4 }}>
                  <span
                    style={{
                      padding: '2px 7px',
                      borderRadius: 99,
                      fontSize: 9.5,
                      fontWeight: 800,
                      textTransform: 'uppercase',
                      letterSpacing: '.04em',
                      background: chip.bg,
                      color: chip.color,
                    }}
                  >
                    ⚡ {chip.label}
                  </span>
                </div>
                )
              })()}
            </td>
            <td style={{ ...invoTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
              <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                <Btn kind="ghost" size="sm" onClick={() => setDetailId(s.id)}>Details</Btn>
                {s.status === 'PENDING_MANDATE' && s.collection_mode !== 'auto_debit' && (
                  <Btn kind="secondary" size="sm" onClick={() => onAction(s, 'activate')}>Start subscription</Btn>
                )}
                {['ACTIVE', 'TRIALING'].includes(s.status) && (
                  <>
                    {s.pricing_model === 'per_seat' && (
                      <Btn kind="ghost" size="sm" onClick={() => onSeats(s)}>Seats</Btn>
                    )}
                    <Btn kind="ghost" size="sm" onClick={() => onAction(s, 'pause')}>Pause</Btn>
                  </>
                )}
                {s.status === 'PAUSED' && (
                  <Btn kind="ghost" size="sm" onClick={() => onAction(s, 'resume')}>Resume</Btn>
                )}
                {!['CANCELLED', 'EXPIRED'].includes(s.status) && (
                  <Btn kind="ghost" size="sm" onClick={() => onAction(s, 'cancel')}>Cancel</Btn>
                )}
              </div>
            </td>
          </InvoRow>
        ))}
      </InvoTable>

      <SubscriptionModal open={modal} onClose={() => setModal(false)} />
      {detailRow && <MandateDrawer sub={detailRow} onClose={() => setDetailId(null)} />}
    </InvoPage>
  )
}

/**
 * D14b — mandate detail drawer: status, copy public link, enable/disable
 * auto-debit, and the charge-attempt timeline.
 */
function MandateDrawer({ sub, onClose }: { sub: SubscriptionRow; onClose: () => void }) {
  const { toast } = useToast()
  const mandate = useSubscriptionMandate(sub.id)
  const attempts = useChargeAttempts(sub.id)
  const enable = useEnableAutodebit()
  const disable = useDisableAutodebit()
  const m = mandate.data?.data

  // Esc closes the drawer, and we freeze the background scroll while it's open.
  // The page body is a scroll container (InvoPage), so without this the panel
  // could get stranded off-screen and the close control scrolled out of reach.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const copyLink = async () => {
    if (!m?.public_url) return
    await navigator.clipboard.writeText(m.public_url)
    toast({ title: 'Authorization link copied' })
  }

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      await mandate.refetch()
      toast({ title: ok })
    } catch (err) {
      toast({ title: 'Action failed', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  // Portal to <body> so the fixed overlay escapes InvoPage's scroll container
  // and covers the true viewport — the same thing the Radix Dialog above does.
  // Rendered in-tree it was trapped in the scrolled content region (backdrop
  // missed the sidebar/topbar, and the header + close button scrolled off).
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(1,1,13,.6)', backdropFilter: 'blur(3px)', display: 'flex', justifyContent: 'flex-end' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ width: 380, maxWidth: '100vw', height: '100%', background: 'rgba(18,18,30,.99)', borderLeft: '1px solid var(--bord-2)', display: 'flex', flexDirection: 'column' }}>
        {/* Pinned header — stays put so the close control can never scroll out of reach */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 20, borderBottom: '1px solid var(--bord)', flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.name}</div>
            <div className="t-mute" style={{ fontSize: 11.5 }}>{sub.customer_name ?? '—'} · {sub.billing_period}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Mandate block */}
        <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, flex: 1 }}>Collection</span>
            {mandate.isLoading ? (
              <span className="t-mute" style={{ fontSize: 11 }}>Loading…</span>
            ) : mandate.isError ? (
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--coral)' }}>Couldn’t load</span>
            ) : (
              <Pill
                tone={
                  m?.collection_mode === 'auto_debit'
                    ? (MANDATE_CHIP[m.mandate_status]?.tone === 'coral'
                        ? 'coral'
                        : MANDATE_CHIP[m.mandate_status]?.tone === 'yellow'
                          ? 'yellow'
                          : MANDATE_CHIP[m.mandate_status]?.tone === 'gray'
                            ? ''
                            : 'green')
                    : ''
                }
                dot
              >
                {m?.collection_mode === 'auto_debit'
                  ? `auto-debit · ${mandateChip(m.mandate_status).label.toLowerCase()}`
                  : 'manual'}
              </Pill>
            )}
          </div>
          {/* Actions only when the mandate state is KNOWN — never offer "Enable"
              on an errored load (that could re-request an existing mandate). */}
          {mandate.isError ? (
            <Btn kind="secondary" size="sm" onClick={() => mandate.refetch()}>Retry</Btn>
          ) : m ? (
            <>
              {m.collection_mode === 'auto_debit' && m.public_url && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn kind="secondary" size="sm" onClick={copyLink}>Copy authorization link</Btn>
                  {m.mandate_short_url && m.mandate_status === 'pending_authorization' && (
                    <a href={m.mandate_short_url} target="_blank" rel="noopener noreferrer">
                      <Btn kind="ghost" size="sm">Open Razorpay page</Btn>
                    </a>
                  )}
                </div>
              )}
              {!['CANCELLED', 'EXPIRED'].includes(sub.status) && (
                <div style={{ display: 'flex', gap: 8 }}>
                  {m.collection_mode !== 'auto_debit' ? (
                    <Btn
                      kind="primary"
                      size="sm"
                      disabled={enable.isPending}
                      onClick={() => act(() => enable.mutateAsync(sub.id), 'Auto-debit mandate requested — customer emailed')}
                    >
                      {enable.isPending ? 'Setting up…' : 'Enable auto-debit'}
                    </Btn>
                  ) : (
                    <Btn
                      kind="ghost"
                      size="sm"
                      disabled={disable.isPending}
                      onClick={() => act(() => disable.mutateAsync(sub.id), 'Back to manual collection')}
                    >
                      {disable.isPending ? 'Disabling…' : 'Disable auto-debit'}
                    </Btn>
                  )}
                </div>
              )}
            </>
          ) : null}
          <p className="t-caption" style={{ margin: 0 }}>
            Auto-debit needs your Razorpay account connected (Invoicing → Settings) · INR profiles only.
          </p>
        </div>

        {/* Charge timeline */}
        <div>
          <div className="label">Charge attempts</div>
          {attempts.isLoading ? (
            <p className="t-mute" style={{ fontSize: 12 }}>Loading…</p>
          ) : attempts.isError ? (
            <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--coral)' }}>
              Couldn’t load charge history.{' '}
              <button onClick={() => attempts.refetch()} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontWeight: 800, padding: 0 }}>Retry</button>
            </p>
          ) : (attempts.data?.data.length ?? 0) === 0 ? (
            <p className="t-mute" style={{ fontSize: 12 }}>No auto-debit charges yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {attempts.data!.data.map((a) => (
                <div key={a.id} style={{ display: 'flex', gap: 10, padding: '9px 11px', borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)', alignItems: 'center' }}>
                  <span
                    style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: a.status === 'succeeded' ? 'var(--green)' : a.status === 'failed' ? 'var(--coral)' : 'var(--yellow)',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 800 }}>
                      {inr(a.amount, a.currency)} · {a.status}
                    </div>
                    <div className="t-mute" style={{ fontSize: 10.5 }}>
                      {new Date(a.attempted_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {a.failure_reason ? ` · ${a.failure_reason}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>,
    document.body,
  )
}
