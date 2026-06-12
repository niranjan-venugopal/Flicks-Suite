'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { PaymentModal } from '@/components/invoicing/PaymentModal'
import { usePayments, useInvoices, type InvoiceRow } from '@/lib/api/queries/use-invoicing'
import type { PillTone } from '@/components/proto/Pill'

const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)
const fmt = (v: string, c: string) => `${symbol(c)}${parseFloat(v).toLocaleString('en-IN')}`
const dateFmt = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

const methodLabel: Record<string, string> = {
  BANK_TRANSFER: 'Bank transfer',
  UPI_DIRECT: 'UPI',
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  RAZORPAY_UPI: 'Razorpay',
  RAZORPAY_CARD: 'Razorpay',
  RAZORPAY_NETBANKING: 'Razorpay',
  RAZORPAY_WALLET: 'Razorpay',
  OTHER: 'Other',
}
const methodTone = (m: string): PillTone =>
  m.startsWith('RAZORPAY') ? 'blue' : m === 'UPI_DIRECT' ? '' : m === 'BANK_TRANSFER' ? 'purple' : 'green'

/** Payments ledger — prototype ScrPayments (+ Record payment with invoice picker). */
export default function PaymentsPage() {
  const { data, isLoading } = usePayments()
  const { data: invoicesData } = useInvoices({})
  const [pickerOpen, setPickerOpen] = useState(false)
  const [paying, setPaying] = useState<InvoiceRow | null>(null)

  const rows = data?.data ?? []
  const openInvoices = (invoicesData?.data ?? []).filter((i) =>
    ['SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID'].includes(i.status),
  )

  return (
    <div style={{ padding: '26px 28px 72px' }}>
      <SectionHead
        title="Payments"
        sub={`${rows.length} payments recorded · manual and Razorpay in one ledger`}
        right={
          <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setPickerOpen(true)}>
            Record payment
          </Btn>
        }
      />

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl w-full">
          <thead>
            <tr>
              <th>Date</th>
              <th>Payment #</th>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Method</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="t-mute">Loading…</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={6} className="t-mute">No payments yet — record one against an open invoice.</td></tr>
            )}
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="t-mute">{dateFmt(p.payment_date)}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.payment_number}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.invoice_number ?? '—'}</td>
                <td>{p.customer_name ?? '—'}</td>
                <td>
                  <Pill tone={methodTone(p.payment_method)}>
                    {methodLabel[p.payment_method] ?? p.payment_method}
                    {p.currency !== 'INR' ? ` · ${p.currency}` : ''}
                  </Pill>
                </td>
                <td className="t-num" style={{ textAlign: 'right', fontWeight: 800 }}>
                  {fmt(p.amount, p.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Invoice picker → existing PaymentModal */}
      {pickerOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setPickerOpen(false)}
        >
          <div className="card" style={{ width: 460, padding: 22 }} onClick={(e) => e.stopPropagation()}>
            <div className="t-h3" style={{ marginBottom: 4 }}>Record a payment</div>
            <div className="t-mute" style={{ fontSize: 12, marginBottom: 14 }}>Pick the invoice the money came in against.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
              {openInvoices.length === 0 && <div className="t-mute text-sm">No open invoices.</div>}
              {openInvoices.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="card"
                  style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => {
                    setPaying(i)
                    setPickerOpen(false)
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{i.invoice_number}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>{i.customer_name}</span>
                  <span className="t-num" style={{ fontSize: 12.5, fontWeight: 800 }}>
                    {fmt(i.amount_outstanding ?? i.total_amount, i.currency)} due
                  </span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <Btn kind="ghost" onClick={() => setPickerOpen(false)}>Cancel</Btn>
            </div>
          </div>
        </div>
      )}

      <PaymentModal open={!!paying} onOpenChange={(v) => !v && setPaying(null)} invoice={paying} />
    </div>
  )
}
