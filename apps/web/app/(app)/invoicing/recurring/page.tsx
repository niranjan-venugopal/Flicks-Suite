'use client'

import { useState } from 'react'
import { RefreshCw, Plus } from 'lucide-react'
import { Btn, Pill, SectionHead, Toggle } from '@/components/proto'
import { InvoPage } from '@/components/invoicing/invo'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  useSubscriptions,
  useCreateSubscription,
  useSubscriptionAction,
  useUpdateSeats,
  useCustomers,
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
      await create.mutateAsync(payload)
      toast({ title: `Subscription "${name.trim()}" created`, description: 'Authorize the mandate to activate it.' })
      setName(''); setAmount(''); setSeatRate('')
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

  const rows = data?.data ?? []
  const active = rows.filter((s) => ['ACTIVE', 'TRIALING'].includes(s.status))

  const onAction = async (s: SubscriptionRow, act: 'activate' | 'pause' | 'resume' | 'cancel') => {
    try {
      await action.mutateAsync({ id: s.id, action: act })
      toast({ title: `Subscription ${act === 'activate' ? 'activated (mandate authorized)' : `${act}d`}` })
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
        sub={`${active.length} active profiles · MRR ${inr(data?.meta.mrr ?? '0')}`}
        right={
          <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setModal(true)}>
            New subscription
          </Btn>
        }
      />

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl w-full">
          <thead>
            <tr>
              <th>Profile</th>
              <th>Customer</th>
              <th>Cadence</th>
              <th>Next run</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="t-mute">Loading…</td></tr>}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={7} className="t-mute">No subscriptions yet — create a recurring profile.</td></tr>
            )}
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.name}</b>
                  {s.pricing_model === 'per_seat' && <div className="t-mute text-xs">{s.seat_count} seats × {inr(s.seat_rate ?? 0, s.currency)}</div>}
                </td>
                <td>{s.customer_name ?? '—'}</td>
                <td className="capitalize">{s.billing_period}</td>
                <td className="t-mute">{s.next_billing_date ?? '—'}</td>
                <td className="t-num" style={{ textAlign: 'right', fontWeight: 800 }}>{inr(cycleAmount(s), s.currency)}</td>
                <td>
                  <Pill tone={STATUS_TONE[s.status] ?? ''} dot>{s.status.replace(/_/g, ' ').toLowerCase()}</Pill>
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {s.status === 'PENDING_MANDATE' && (
                    <Btn kind="secondary" size="sm" onClick={() => onAction(s, 'activate')}>Authorize mandate</Btn>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SubscriptionModal open={modal} onClose={() => setModal(false)} />
    </InvoPage>
  )
}
