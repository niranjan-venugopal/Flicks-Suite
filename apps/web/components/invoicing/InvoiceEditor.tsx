'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useCustomers,
  useSaveInvoice,
  type InvoiceDetail,
  type InvoiceInput,
  type InvoiceLineInput,
} from '@/lib/api/queries/use-invoicing'
import { computeTotals } from '@/lib/invoicing/totals'

const FIELD: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 9,
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 14,
}
const LABEL: React.CSSProperties = { display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 5 }
const CELL_INPUT: React.CSSProperties = { ...FIELD, padding: '7px 9px', fontSize: 13, borderRadius: 7 }
const SECTION: React.CSSProperties = { borderRadius: 14, padding: 18, marginBottom: 16 }

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP']
const emptyLine = (): InvoiceLineInput => ({ item_name: '', quantity: '1', rate: '', gst_rate: '18', cess_rate: '0' })
const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Single-column invoice editor (PRD §9.1): Customer → Meta → Line items
 * (Enter adds a row) → Discount → TDS → Notes/T&C, with a live totals card.
 * The bank-account selector slots in here in Sprint 5. Totals are display-only —
 * the API recomputes authoritatively on save.
 */
export function InvoiceEditor({ invoice }: { invoice?: InvoiceDetail }) {
  const router = useRouter()
  const { toast } = useToast()
  const save = useSaveInvoice()
  const { data: customersData } = useCustomers({})

  const [customerId, setCustomerId] = useState(invoice?.customer_id ?? '')
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoice_date ?? today())
  const [dueDate, setDueDate] = useState(invoice?.due_date ?? plusDays(today(), 30))
  const [currency, setCurrency] = useState(invoice?.currency ?? 'INR')
  const [reference, setReference] = useState(invoice?.reference ?? '')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed' | ''>(
    (invoice?.discount_type as 'percent' | 'fixed') ?? '',
  )
  const [discountValue, setDiscountValue] = useState(invoice?.discount_value ?? '')
  const [tdsSection, setTdsSection] = useState(invoice?.tds_section ?? '')
  const [tdsCode, setTdsCode] = useState(invoice?.tds_payment_code ?? '')
  const [tdsRate, setTdsRate] = useState(invoice?.tds_rate ?? '')
  const [notes, setNotes] = useState(invoice?.notes ?? '')
  const [terms, setTerms] = useState(invoice?.terms_and_conditions ?? '')
  const [lines, setLines] = useState<InvoiceLineInput[]>(
    invoice?.line_items?.map((l) => ({
      item_id: l.item_id ?? undefined,
      item_name: l.item_name,
      description: l.description ?? undefined,
      hsn_sac_code: l.hsn_sac_code ?? undefined,
      quantity: String(l.quantity),
      unit: l.unit ?? undefined,
      rate: String(l.rate),
      gst_rate: l.gst_rate != null ? String(l.gst_rate) : '18',
      cess_rate: l.cess_rate != null ? String(l.cess_rate) : '0',
    })) ?? [emptyLine()],
  )

  const customers = customersData?.data ?? []
  const customer = customers.find((c) => c.id === customerId)

  // Live treatment mirror: the server derives authoritatively from tenant +
  // customer state; here we approximate from the selected customer for display.
  const taxTreatment = useMemo(() => {
    if (invoice?.tax_treatment) return invoice.tax_treatment
    if (customer && (customer as { country_code?: string }).country_code && (customer as { country_code?: string }).country_code !== 'IN') return 'EXPORT'
    return 'INTER_STATE'
  }, [invoice?.tax_treatment, customer])

  const totals = useMemo(
    () =>
      computeTotals({
        lines,
        taxTreatment,
        discountType,
        discountValue,
        tdsRate,
      }),
    [lines, taxTreatment, discountType, discountValue, tdsRate],
  )

  useEffect(() => {
    if (!invoice && customer?.default_currency) setCurrency(customer.default_currency)
  }, [customer, invoice])

  const setLine = (i: number, patch: Partial<InvoiceLineInput>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLine = () => setLines((ls) => [...ls, emptyLine()])
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))
  const onLineKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addLine()
    }
  }

  const onSave = async () => {
    if (!customerId) return toast({ title: 'Pick a customer first', variant: 'destructive' })
    const valid = lines.filter((l) => l.item_name.trim() && l.rate)
    if (!valid.length) return toast({ title: 'Add at least one line item', variant: 'destructive' })
    const payload: InvoiceInput = {
      customer_id: customerId,
      invoice_date: invoiceDate,
      due_date: dueDate,
      currency,
      reference: reference || undefined,
      discount_type: discountType || undefined,
      discount_value: discountType ? discountValue || '0' : undefined,
      tds_section: tdsSection || undefined,
      tds_payment_code: tdsCode || undefined,
      tds_rate: tdsRate || undefined,
      notes: notes || undefined,
      terms_and_conditions: terms || undefined,
      line_items: valid,
    }
    try {
      const res = await save.mutateAsync({ id: invoice?.id, ...payload })
      toast({ title: invoice ? 'Draft updated' : `Draft ${res.data.invoice_number} created` })
      router.push('/invoicing/invoices')
    } catch (err) {
      toast({
        title: 'Could not save invoice',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const money = (v: string) => `${currency} ${v}`

  return (
    <div style={{ padding: '28px 32px', maxWidth: 980, margin: '0 auto' }}>
      <SectionHead
        eyebrow="Invoicing"
        title={invoice ? `Edit ${invoice.invoice_number}` : 'New invoice'}
        sub="Single-column editor — totals update live; the server recomputes on save."
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="ghost" onClick={() => router.back()}>
              Back
            </Btn>
            <Btn kind="primary" onClick={onSave} disabled={save.isPending} icon={<Icon.check size={13} />}>
              {save.isPending ? 'Saving…' : 'Save draft'}
            </Btn>
          </div>
        }
      />

      {/* Customer */}
      <div className="glass" style={SECTION}>
        <label style={LABEL}>Customer *</label>
        <select style={FIELD} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">Select a customer…</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name} ({c.customer_code})
            </option>
          ))}
        </select>
        {customer?.gstin && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>GSTIN: {customer.gstin}</div>
        )}
      </div>

      {/* Meta */}
      <div className="glass" style={{ ...SECTION, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <div>
          <label style={LABEL}>Invoice date</label>
          <input type="date" style={FIELD} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </div>
        <div>
          <label style={LABEL}>Due date</label>
          <input type="date" style={FIELD} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div>
          <label style={LABEL}>Currency</label>
          <select style={FIELD} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={LABEL}>Reference / PO</label>
          <input style={FIELD} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>

      {/* Line items */}
      <div className="glass" style={SECTION}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Line items</div>
          <Pill tone="blue">{taxTreatment.replace('_', '-').toLowerCase()}</Pill>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'left' }}>
              <th style={{ padding: 4, width: '34%' }}>Item</th>
              <th style={{ padding: 4 }}>HSN/SAC</th>
              <th style={{ padding: 4, width: 70 }}>Qty</th>
              <th style={{ padding: 4 }}>Rate</th>
              <th style={{ padding: 4, width: 70 }}>GST %</th>
              <th style={{ padding: 4, width: 70 }}>Cess %</th>
              <th style={{ padding: 4, width: 36 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td style={{ padding: 4 }}>
                  <input
                    style={CELL_INPUT}
                    placeholder="Item or service"
                    value={l.item_name}
                    onChange={(e) => setLine(i, { item_name: e.target.value })}
                    onKeyDown={onLineKeyDown}
                  />
                </td>
                <td style={{ padding: 4 }}>
                  <input
                    style={CELL_INPUT}
                    placeholder="998314"
                    value={l.hsn_sac_code ?? ''}
                    onChange={(e) => setLine(i, { hsn_sac_code: e.target.value })}
                    onKeyDown={onLineKeyDown}
                  />
                </td>
                <td style={{ padding: 4 }}>
                  <input
                    style={CELL_INPUT}
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => setLine(i, { quantity: e.target.value })}
                    onKeyDown={onLineKeyDown}
                  />
                </td>
                <td style={{ padding: 4 }}>
                  <input
                    style={CELL_INPUT}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={l.rate}
                    onChange={(e) => setLine(i, { rate: e.target.value })}
                    onKeyDown={onLineKeyDown}
                  />
                </td>
                <td style={{ padding: 4 }}>
                  <input
                    style={CELL_INPUT}
                    inputMode="decimal"
                    value={l.gst_rate ?? ''}
                    onChange={(e) => setLine(i, { gst_rate: e.target.value })}
                    onKeyDown={onLineKeyDown}
                  />
                </td>
                <td style={{ padding: 4 }}>
                  <input
                    style={CELL_INPUT}
                    inputMode="decimal"
                    value={l.cess_rate ?? ''}
                    onChange={(e) => setLine(i, { cess_rate: e.target.value })}
                    onKeyDown={onLineKeyDown}
                  />
                </td>
                <td style={{ padding: 4 }}>
                  <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} onClick={() => removeLine(i)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 8 }}>
          <Btn kind="ghost" size="sm" icon={<Icon.plus size={12} />} onClick={addLine}>
            Add line (Enter)
          </Btn>
        </div>
      </div>

      {/* Discount + TDS */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="glass" style={SECTION}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Discount</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={LABEL}>Type</label>
              <select
                style={FIELD}
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as 'percent' | 'fixed' | '')}
              >
                <option value="">None</option>
                <option value="percent">Percent %</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </div>
            <div>
              <label style={LABEL}>{discountType === 'percent' ? 'Percent' : 'Amount'}</label>
              <input
                style={FIELD}
                inputMode="decimal"
                disabled={!discountType}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="glass" style={SECTION}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>
            TDS <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)' }}>(Section 393 — codes pending CFO sign-off)</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={LABEL}>Section</label>
              <input style={FIELD} placeholder="393" value={tdsSection} onChange={(e) => setTdsSection(e.target.value)} />
            </div>
            <div>
              <label style={LABEL}>Payment code</label>
              <input style={FIELD} placeholder="10XX" value={tdsCode} onChange={(e) => setTdsCode(e.target.value)} />
            </div>
            <div>
              <label style={LABEL}>Rate %</label>
              <input style={FIELD} inputMode="decimal" placeholder="10" value={tdsRate} onChange={(e) => setTdsRate(e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      {/* Bank selector placeholder (Sprint 5) + Notes/T&C */}
      <div className="glass" style={SECTION}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          <Icon.bank size={12} /> Bank account selection (auto-picked by currency) arrives with Organization → Financial details in Sprint 5.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <label style={LABEL}>Notes (visible to customer)</label>
            <textarea style={{ ...FIELD, minHeight: 70, resize: 'vertical' }} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div>
            <label style={LABEL}>Terms & conditions</label>
            <textarea style={{ ...FIELD, minHeight: 70, resize: 'vertical' }} value={terms} onChange={(e) => setTerms(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Live totals card */}
      <div className="glass" style={{ ...SECTION, maxWidth: 420, marginLeft: 'auto' }}>
        {[
          ['Subtotal', totals.subtotal],
          ...(discountType ? ([['Discount', `− ${totals.discount_amount}`]] as [string, string][]) : []),
          ['Taxable amount', totals.taxable_amount],
          ...(taxTreatment === 'INTRA_STATE'
            ? ([
                ['CGST', totals.cgst_amount],
                ['SGST', totals.sgst_amount],
              ] as [string, string][])
            : ([['IGST', totals.igst_amount]] as [string, string][])),
          ...(parseFloat(totals.cess_amount) > 0 ? ([['Cess', totals.cess_amount]] as [string, string][]) : []),
        ].map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
            <span style={{ color: 'var(--muted)' }}>{label}</span>
            <span style={{ fontFamily: 'var(--mono, monospace)' }}>{money(value)}</span>
          </div>
        ))}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '8px 0 4px',
            borderTop: '1px solid var(--line)',
            marginTop: 6,
            fontWeight: 600,
            fontSize: 15,
          }}
        >
          <span>Total</span>
          <span style={{ fontFamily: 'var(--mono, monospace)' }}>{money(totals.total_amount)}</span>
        </div>
        {parseFloat(totals.tds_amount) > 0 && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
              <span style={{ color: 'var(--muted)' }}>TDS ({tdsRate}%)</span>
              <span style={{ fontFamily: 'var(--mono, monospace)' }}>− {money(totals.tds_amount)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontWeight: 600, fontSize: 14, color: 'var(--blue)' }}>
              <span>Net receivable</span>
              <span style={{ fontFamily: 'var(--mono, monospace)' }}>{money(totals.net_receivable)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
