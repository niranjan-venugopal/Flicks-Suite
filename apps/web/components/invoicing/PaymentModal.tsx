'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { InvoBtn } from '@/components/invoicing/invo'
import { useRecordPayment, type InvoiceRow } from '@/lib/api/queries/use-invoicing'
import { DateField } from '@/components/ui/date-picker'

const FIELD: React.CSSProperties = {
  width: '100%',
  height: 44,
  background: 'rgba(255,255,255,0.05)',
  border: '1.5px solid rgba(255,255,255,0.10)',
  borderRadius: 10,
  padding: '0 14px',
  fontWeight: 600,
  fontSize: 14,
  color: '#fff',
  outline: 'none',
  letterSpacing: '-0.02em',
}
const LABEL: React.CSSProperties = {
  display: 'block',
  fontWeight: 700,
  fontSize: 13,
  color: 'rgba(255,255,255,0.6)',
  marginBottom: 6,
  letterSpacing: '-0.02em',
}

const METHODS = [
  ['BANK_TRANSFER', 'Bank transfer'],
  ['UPI_DIRECT', 'UPI'],
  ['CASH', 'Cash'],
  ['CHEQUE', 'Cheque'],
  ['OTHER', 'Other'],
] as const

/** Record a manual payment against an invoice (PRD §6.6). */
export function PaymentModal({
  open,
  onOpenChange,
  invoice,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  invoice: InvoiceRow | null
}) {
  const { toast } = useToast()
  const record = useRecordPayment()
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [method, setMethod] = useState('BANK_TRANSFER')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open && invoice) {
      setAmount(invoice.amount_outstanding ?? invoice.total_amount)
      setDate(new Date().toISOString().slice(0, 10))
      setMethod('BANK_TRANSFER')
      setReference('')
      setNotes('')
    }
  }, [open, invoice])

  const onSubmit = async () => {
    if (!invoice) return
    if (!amount || parseFloat(amount) <= 0) {
      return toast({ title: 'Enter a positive amount', variant: 'destructive' })
    }
    try {
      const res = await record.mutateAsync({
        id: invoice.id,
        amount,
        payment_date: date,
        payment_method: method,
        reference_number: reference || undefined,
        notes: notes || undefined,
      })
      const over = parseFloat(res.meta.overpaid)
      toast({
        title: `Payment ${res.data.payment_number} recorded — ${res.meta.invoice_status.replace(/_/g, ' ').toLowerCase()}`,
        description: over > 0 ? `Overpayment of ${invoice.currency} ${res.meta.overpaid} added to the customer's credit balance.` : undefined,
      })
      onOpenChange(false)
    } catch (err) {
      toast({
        title: 'Could not record payment',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            Record payment {invoice ? `— ${invoice.invoice_number}` : ''}
          </DialogTitle>
        </DialogHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, padding: '4px 0' }}>
          <div>
            <label style={LABEL}>Amount ({invoice?.currency ?? ''}) *</label>
            <input style={FIELD} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label style={LABEL}>Date</label>
            <DateField value={date} onChange={setDate} style={FIELD} />
          </div>
          {/* Catalog: the capture-mode tiles come first — Razorpay is
              auto-captured (manual entry disabled, arrives with auto-debit),
              manual methods require the audit-logged reference below. */}
          <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
            <div
              style={{
                padding: '10px 12px', borderRadius: 10, textAlign: 'left',
                background: 'var(--surf-1)', border: '1px solid var(--bord)', opacity: 0.55,
              }}
              title="Razorpay auto-capture arrives with auto-debit — status updates itself; manual entry is disabled for captured payments"
            >
              <div style={{ fontSize: 12, fontWeight: 800, color: '#fff', marginBottom: 2 }}>
                Razorpay <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--yellow)', marginLeft: 4 }}>COMING SOON</span>
              </div>
              <div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.45 }}>
                auto-captured — status updates itself; manual entry disabled
              </div>
            </div>
            <div
              style={{
                padding: '10px 12px', borderRadius: 10, textAlign: 'left',
                background: 'rgba(62,123,250,.08)', border: '1px solid rgba(62,123,250,.45)',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 800, color: '#fff', marginBottom: 2 }}>Manual entry</div>
              <div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.45 }}>
                bank transfer / UPI / cheque — reference no., audit-logged
              </div>
            </div>
          </div>
          <div>
            <label style={LABEL}>Method</label>
            <select style={FIELD} value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map(([v, l]) => (
                <option key={v} value={v} style={{ color: '#000' }}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={LABEL}>Reference (UTR/cheque #)</label>
            <input style={{ ...FIELD, fontFamily: 'var(--font-mono)' }} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / reference number" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Notes</label>
            <input style={FIELD} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <InvoBtn kind="outline" height={44} onClick={() => onOpenChange(false)}>
            Cancel
          </InvoBtn>
          <InvoBtn kind="primary" height={44} onClick={onSubmit} disabled={record.isPending}>
            {record.isPending ? 'Recording…' : 'Record payment'}
          </InvoBtn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
