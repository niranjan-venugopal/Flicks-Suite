'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Btn, SectionHead } from '@/components/proto'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useNotes, useIssueNote, useInvoices, type NoteRow } from '@/lib/api/queries/use-invoicing'

const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)
const fmt = (v: string, c: string) => `${symbol(c)}${parseFloat(v).toLocaleString('en-IN')}`

// Prototype NoteModal reason sets (screens-flows.jsx).
const CREDIT_REASONS: [string, string][] = [
  ['sales_return', 'Goods returned'],
  ['post_supply_discount', 'Post-sale discount'],
  ['service_deficiency', 'Deficiency in service'],
  ['invoice_cancellation', 'Cancellation'],
  ['price_revision', 'Price correction'],
]
const DEBIT_REASONS: [string, string][] = [
  ['under_billing_correction', 'Under-billing'],
  ['additional_charges', 'Additional charges'],
  ['price_revision_upward', 'Price escalation'],
  ['reverse_charge_adjustment', 'Interest on delay'],
]

function NoteModal({
  open,
  kind,
  onClose,
}: {
  open: boolean
  kind: 'credit' | 'debit'
  onClose: () => void
}) {
  const { toast } = useToast()
  const issue = useIssueNote()
  const { data: invoicesData } = useInvoices({})
  const [invoiceId, setInvoiceId] = useState('')
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')

  const isCredit = kind === 'credit'
  const reasons = isCredit ? CREDIT_REASONS : DEBIT_REASONS
  const eligible = (invoicesData?.data ?? []).filter((i) => !['DRAFT', 'CANCELLED', 'VOIDED'].includes(i.status))
  const canSave = !!invoiceId && !!reason && parseFloat(amount) > 0

  const save = async () => {
    if (!canSave) return
    try {
      const res = await issue.mutateAsync({ kind, invoice_id: invoiceId, reason, amount })
      toast({ title: `${isCredit ? 'Credit' : 'Debit'} note ${(res.data as { credit_note_number?: string; debit_note_number?: string }).credit_note_number ?? (res.data as { debit_note_number?: string }).debit_note_number ?? ''} issued` })
      setInvoiceId('')
      setReason('')
      setAmount('')
      onClose()
    } catch (err) {
      toast({
        title: 'Could not issue note',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{isCredit ? 'New credit note' : 'New debit note'}</DialogTitle>
          <p className="t-mute text-xs mt-1">
            {isCredit ? 'Reduce a previously-issued invoice · GSTR-1 §9B' : 'Increase a previously-issued invoice'}
          </p>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <div className="label">Against invoice</div>
            <select className="input w-full" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">Select an invoice…</option>
              {eligible.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoice_number} · {i.customer_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">Reason</div>
            <select className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Select a reason…</option>
              {reasons.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">{isCredit ? 'Credit' : 'Debit'} amount (₹)</div>
            <input
              className="input t-num w-full"
              type="number"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="12000"
            />
          </div>
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" onClick={save} disabled={!canSave || issue.isPending}>
            {issue.isPending ? 'Issuing…' : `Issue ${isCredit ? 'credit' : 'debit'} note`}
          </Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NotesTable({ rows, tone }: { rows: NoteRow[]; tone: 'credit' | 'debit' }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <table className="tbl w-full">
        <thead>
          <tr>
            <th>Note no</th>
            <th>Against</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="t-mute">None yet</td>
            </tr>
          )}
          {rows.map((n) => (
            <tr key={n.id}>
              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{n.number}</td>
              <td>
                {n.customer_name ?? '—'}
                {n.invoice_number ? ` · ${n.invoice_number}` : ''}
              </td>
              <td
                className="t-num"
                style={{ textAlign: 'right', fontWeight: 800, color: tone === 'credit' ? 'var(--coral)' : 'var(--green)' }}
              >
                {tone === 'credit' ? '−' : '+'}
                {fmt(n.total_amount, n.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Credit & Debit notes — prototype ScrNotes (two columns + issue CTAs). */
export default function NotesPage() {
  const { data, isLoading } = useNotes()
  const [modal, setModal] = useState<'credit' | 'debit' | null>(null)

  return (
    <div style={{ padding: '26px 28px 72px' }}>
      <SectionHead
        title="Credit & Debit notes"
        sub="GST CDNR documents with their own numbering series — credit notes book into the customer's credit balance."
      />
      {isLoading ? (
        <div className="t-mute">Loading…</div>
      ) : (
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="t-caption">Credit notes</div>
              <Btn kind="secondary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setModal('credit')}>
                New credit note
              </Btn>
            </div>
            <NotesTable rows={data?.data.credit ?? []} tone="credit" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="t-caption">Debit notes</div>
              <Btn kind="secondary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setModal('debit')}>
                New debit note
              </Btn>
            </div>
            <NotesTable rows={data?.data.debit ?? []} tone="debit" />
          </div>
        </div>
      )}
      <NoteModal open={!!modal} kind={modal ?? 'credit'} onClose={() => setModal(null)} />
    </div>
  )
}
