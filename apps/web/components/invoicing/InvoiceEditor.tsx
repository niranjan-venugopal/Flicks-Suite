'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import {
  useCustomers,
  useSaveInvoice,
  useSendInvoice,
  type InvoiceDetail,
  type InvoiceInput,
  type InvoiceLineInput,
} from '@/lib/api/queries/use-invoicing'
import { computeTotals } from '@/lib/invoicing/totals'
import {
  INVO,
  InvoPage,
  InvoCard,
  InvoCardTitle,
  InvoBtn,
  InvoBreadcrumb,
  InvoIcons,
  invoField,
  invoLabel,
} from '@/components/invoicing/invo'

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP']
const emptyLine = (): InvoiceLineInput => ({ item_name: '', quantity: '1', rate: '', gst_rate: '18', cess_rate: '0' })
const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)

// Line-items grid: Description | HSN/SAC | Qty | Rate | GST% | Amount | ✕
const LINE_GRID = '1fr 110px 64px 110px 64px 110px 32px'

const sumRowLabel: React.CSSProperties = { fontWeight: 600, fontSize: 14, color: INVO.muted50, letterSpacing: '-0.02em' }
const sumRowValue: React.CSSProperties = { fontWeight: 700, fontSize: 14, color: '#fff', letterSpacing: '-0.02em' }

/**
 * Single-column-flow invoice editor in the Invo prototype layout (CreateInvoice
 * screen): breadcrumb → 2-col grid (form cards left, sticky Summary right).
 * Totals are a client-side mirror; the server recomputes authoritatively.
 */
export function InvoiceEditor({ invoice }: { invoice?: InvoiceDetail }) {
  const router = useRouter()
  const { toast } = useToast()
  const save = useSaveInvoice()
  const send = useSendInvoice()
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

  const taxTreatment = useMemo(() => {
    if (invoice?.tax_treatment) return invoice.tax_treatment
    if (customer && (customer as { country_code?: string }).country_code && (customer as { country_code?: string }).country_code !== 'IN') return 'EXPORT'
    return 'INTER_STATE'
  }, [invoice?.tax_treatment, customer])

  const totals = useMemo(
    () => computeTotals({ lines, taxTreatment, discountType, discountValue, tdsRate }),
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
  const lineAmount = (l: InvoiceLineInput) => {
    const n = parseFloat(l.quantity || '0') * parseFloat(l.rate || '0')
    return Number.isFinite(n) ? n : 0
  }

  const onSave = async (thenSend = false) => {
    if (!customerId) return toast({ title: 'Pick a client first', variant: 'destructive' })
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
      if (thenSend) {
        const sent = await send.mutateAsync(res.data.id)
        toast({ title: `Invoice ${res.data.invoice_number} sent`, description: sent.meta.public_url })
      } else {
        toast({ title: invoice ? 'Draft updated' : `Draft ${res.data.invoice_number} created` })
      }
      router.push('/invoicing/invoices')
    } catch (err) {
      toast({
        title: 'Could not save invoice',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const money = (v: string) => `${symbol(currency)}${parseFloat(v).toLocaleString('en-IN')}`

  return (
    <InvoPage>
      <InvoBreadcrumb
        items={[
          { label: 'Invoices', onClick: () => router.push('/invoicing/invoices') },
          { label: invoice ? `Edit ${invoice.invoice_number}` : 'Create Invoice' },
        ]}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 32 }}>
        {/* ── Left: form cards ─────────────────────────────────────────────── */}
        <div>
          {/* Invoice details */}
          <InvoCard style={{ marginBottom: 20 }}>
            <InvoCardTitle>Invoice details</InvoCardTitle>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={invoLabel}>Client</label>
                <select style={invoField()} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Select a client…</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id} style={{ color: '#000' }}>
                      {c.display_name} ({c.customer_code})
                    </option>
                  ))}
                </select>
                {customer?.gstin && (
                  <div style={{ marginTop: 8, fontWeight: 600, fontSize: 12, color: INVO.muted40 }}>
                    GSTIN: {customer.gstin}
                  </div>
                )}
              </div>
              <div>
                <label style={invoLabel}>Issue date</label>
                <input type="date" style={invoField()} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </div>
              <div>
                <label style={invoLabel}>Due date</label>
                <input type="date" style={invoField()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
              <div>
                <label style={invoLabel}>Currency</label>
                <select style={invoField()} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c} style={{ color: '#000' }}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={invoLabel}>Reference / PO</label>
                <input style={invoField()} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
              </div>
            </div>
          </InvoCard>

          {/* Line items */}
          <InvoCard style={{ marginBottom: 20 }}>
            <InvoCardTitle>Line items</InvoCardTitle>
            <div style={{ display: 'grid', gridTemplateColumns: LINE_GRID, gap: 8, marginBottom: 10 }}>
              {['Description', 'HSN/SAC', 'Qty', `Rate (${symbol(currency).trim()})`, 'GST %', 'Amount', ''].map((h) => (
                <div key={h} style={{ fontWeight: 700, fontSize: 12, color: INVO.muted40, letterSpacing: '-0.01em' }}>
                  {h}
                </div>
              ))}
            </div>
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: LINE_GRID, gap: 8, marginBottom: 10, alignItems: 'center' }}>
                <input
                  style={invoField(true)}
                  placeholder="Description"
                  value={l.item_name}
                  onChange={(e) => setLine(i, { item_name: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                <input
                  style={invoField(true)}
                  placeholder="998314"
                  value={l.hsn_sac_code ?? ''}
                  onChange={(e) => setLine(i, { hsn_sac_code: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                <input
                  style={invoField(true)}
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                <input
                  style={invoField(true)}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={l.rate}
                  onChange={(e) => setLine(i, { rate: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                <input
                  style={invoField(true)}
                  inputMode="decimal"
                  value={l.gst_rate ?? ''}
                  onChange={(e) => setLine(i, { gst_rate: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                <div style={{ fontWeight: 700, fontSize: 14, color: '#fff', letterSpacing: '-0.02em' }}>
                  {symbol(currency)}
                  {lineAmount(l).toLocaleString('en-IN')}
                </div>
                <div
                  onClick={() => removeLine(i)}
                  style={{ cursor: 'pointer', color: INVO.muted30, display: 'flex', alignItems: 'center' }}
                >
                  {InvoIcons.trash}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <InvoBtn kind="dashed" icon={InvoIcons.plusSmall} onClick={addLine}>
                Add item
              </InvoBtn>
            </div>
          </InvoCard>

          {/* Discount + TDS */}
          <InvoCard style={{ marginBottom: 20 }}>
            <InvoCardTitle>Discount & TDS</InvoCardTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
              <div>
                <label style={invoLabel}>Discount</label>
                <select
                  style={invoField()}
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value as 'percent' | 'fixed' | '')}
                >
                  <option value="" style={{ color: '#000' }}>
                    None
                  </option>
                  <option value="percent" style={{ color: '#000' }}>
                    Percent %
                  </option>
                  <option value="fixed" style={{ color: '#000' }}>
                    Fixed
                  </option>
                </select>
              </div>
              <div>
                <label style={invoLabel}>{discountType === 'percent' ? 'Percent' : 'Amount'}</label>
                <input
                  style={{ ...invoField(), opacity: discountType ? 1 : 0.4 }}
                  inputMode="decimal"
                  disabled={!discountType}
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                />
              </div>
              <div>
                <label style={invoLabel}>TDS section</label>
                <input style={invoField()} placeholder="393" value={tdsSection} onChange={(e) => setTdsSection(e.target.value)} />
              </div>
              <div>
                <label style={invoLabel}>Payment code</label>
                <input style={invoField()} placeholder="10XX" value={tdsCode} onChange={(e) => setTdsCode(e.target.value)} />
              </div>
              <div>
                <label style={invoLabel}>TDS rate %</label>
                <input style={invoField()} inputMode="decimal" placeholder="10" value={tdsRate} onChange={(e) => setTdsRate(e.target.value)} />
              </div>
            </div>
          </InvoCard>

          {/* Notes */}
          <InvoCard>
            <label style={invoLabel}>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Payment terms, bank details, thank you note..."
              style={{ ...invoField(), height: 90, resize: 'none', paddingTop: 14, lineHeight: 1.5 }}
            />
            <div style={{ height: 14 }} />
            <label style={invoLabel}>Terms & conditions</label>
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Late fees, jurisdiction, warranty..."
              style={{ ...invoField(), height: 70, resize: 'none', paddingTop: 14, lineHeight: 1.5 }}
            />
          </InvoCard>
        </div>

        {/* ── Right: sticky summary ────────────────────────────────────────── */}
        <div>
          <InvoCard strong style={{ position: 'sticky', top: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 18, color: '#fff', letterSpacing: '-0.02em', marginBottom: 24 }}>Summary</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={sumRowLabel}>Subtotal</span>
                <span style={sumRowValue}>{money(totals.subtotal)}</span>
              </div>
              {discountType && parseFloat(totals.discount_amount) > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={sumRowLabel}>Discount</span>
                  <span style={{ ...sumRowValue, color: INVO.coral }}>− {money(totals.discount_amount)}</span>
                </div>
              )}
              {taxTreatment === 'INTRA_STATE' ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={sumRowLabel}>CGST</span>
                    <span style={sumRowValue}>{money(totals.cgst_amount)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={sumRowLabel}>SGST</span>
                    <span style={sumRowValue}>{money(totals.sgst_amount)}</span>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={sumRowLabel}>{taxTreatment === 'EXPORT' ? 'IGST (export — zero-rated)' : 'IGST'}</span>
                  <span style={sumRowValue}>{money(totals.igst_amount)}</span>
                </div>
              )}
              {parseFloat(totals.cess_amount) > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={sumRowLabel}>Cess</span>
                  <span style={sumRowValue}>{money(totals.cess_amount)}</span>
                </div>
              )}
              <div style={{ height: 1, background: 'rgba(255,255,255,0.1)' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 700, fontSize: 16, color: '#fff', letterSpacing: '-0.02em' }}>Total</span>
                <span style={{ fontWeight: 700, fontSize: 24, color: '#fff', letterSpacing: '-0.04em' }}>
                  {money(totals.total_amount)}
                </span>
              </div>
              {parseFloat(totals.tds_amount) > 0 && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={sumRowLabel}>TDS ({tdsRate}%)</span>
                    <span style={{ ...sumRowValue, color: INVO.coral }}>− {money(totals.tds_amount)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ ...sumRowLabel, color: INVO.blue, fontWeight: 700 }}>Net receivable</span>
                    <span style={{ ...sumRowValue, color: INVO.blue, fontSize: 16 }}>{money(totals.net_receivable)}</span>
                  </div>
                </>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InvoBtn
                kind="primary"
                full
                height={52}
                onClick={() => onSave(true)}
                disabled={save.isPending || send.isPending}
              >
                {send.isPending ? 'Sending…' : 'Send invoice'}
              </InvoBtn>
              <InvoBtn kind="outline" full height={52} onClick={() => onSave(false)} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : invoice ? 'Save changes' : 'Save as draft'}
              </InvoBtn>
            </div>
          </InvoCard>
        </div>
      </div>
    </InvoPage>
  )
}
