'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import { CustomerModal } from '@/components/invoicing/CustomerModal'
import { useOrganization } from '@/lib/api/queries/use-settings'
import { useInvSettings } from '@/lib/api/queries/use-inv-settings'
import {
  useCustomers,
  useSaveInvoice,
  useSendInvoice,
  useBankAccounts,
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
  invoSelect,
  invoLabel,
} from '@/components/invoicing/invo'
import { TDS_CODES, isGstCurrency, taxLabel } from '@/lib/invoicing/constants'
import { DateField } from '@/components/ui/date-picker'

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP']
const emptyLine = (): InvoiceLineInput => ({ item_name: '', quantity: '1', rate: '', gst_rate: '18', cess_rate: '0' })
const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)

// Line-items grid (INR): Description | HSN/SAC | Qty | Rate | GST% | Amount | ✕
const LINE_GRID = '1fr 110px 64px 110px 64px 110px 32px'
// Foreign-currency: no HSN/SAC (India concept), but a single VAT % column:
// Description | Qty | Rate | VAT% | Amount | ✕
const LINE_GRID_INTL = '1fr 64px 110px 64px 110px 32px'

const sumRowLabel: React.CSSProperties = { fontWeight: 600, fontSize: 14, color: INVO.muted50, letterSpacing: '-0.02em' }
const sumRowValue: React.CSSProperties = { fontWeight: 700, fontSize: 14, color: '#fff', letterSpacing: '-0.02em' }

/**
 * Single-column-flow invoice editor in the Invo prototype layout (CreateInvoice
 * screen): breadcrumb → 2-col grid (form cards left, sticky Summary right).
 * Totals are a client-side mirror; the server recomputes authoritatively.
 */
export function InvoiceEditor({ invoice }: { invoice?: InvoiceDetail }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Quote mode when creating from /invoicing/new?type=quote (existing docs keep
  // their own document_type).
  const isQuote = invoice ? invoice.document_type === 'QUOTE' : searchParams?.get('type') === 'quote'
  const { toast } = useToast()
  const save = useSaveInvoice()
  const send = useSendInvoice()
  // "+ New client" opens the SAME form as Clients → Add client (round 18).
  // The old inline 4-field version asked for no country and no state, so
  // every client born here was treated as inter-state — IGST forever, even
  // for a same-city customer — and a foreign client was never an export.
  const [addingClient, setAddingClient] = useState(false)
  const { data: customersData } = useCustomers({})
  const { data: banksData } = useBankAccounts()

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
  const [bankAccountId, setBankAccountId] = useState<string>(
    ((invoice as unknown as { bank_account_id?: string | null })?.bank_account_id) ?? '',
  )
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

  // The tenant's own state decides intra- vs inter-state; the invoicing
  // settings decide which export route the totals card should assume.
  const org = useOrganization()
  const invSettings = useInvSettings()
  const customers = customersData?.data ?? []
  const customer = customers.find((c) => c.id === customerId)
  const bankAccounts = (banksData?.data ?? []).filter((b) => b.is_active)
  const currencyDefaults = banksData?.meta?.currency_defaults ?? {}
  // Mirror of the §8 server-side selection for display: override → currency
  // default → overall default → first active.
  const resolvedBankId =
    bankAccountId ||
    currencyDefaults[currency] ||
    bankAccounts.find((b) => b.is_default)?.id ||
    bankAccounts[0]?.id ||
    ''
  const resolvedBank = bankAccounts.find((b) => b.id === resolvedBankId)
  const swiftWarning =
    currency !== 'INR' && resolvedBank && !resolvedBank.swift_bic
      ? 'Add a SWIFT/BIC to this account to accept international transfers — Razorpay/UPI are still offered.'
      : currency !== 'INR' && !resolvedBank
        ? 'No bank account yet — add one under Organization → Financial details.'
        : undefined

  // Mirrors the server's deriveTaxTreatment exactly: country first, then the
  // supplier/customer state comparison. Without the state comparison this memo
  // could never return INTRA_STATE, so the pre-save totals card showed one
  // IGST line where the server would save CGST + SGST (round 18).
  const taxTreatment = useMemo(() => {
    if (invoice?.tax_treatment) return invoice.tax_treatment
    const country = (customer?.country_code ?? 'IN').toUpperCase()
    if (country !== 'IN') return 'EXPORT'
    const supplier = (org.data?.stateCode ?? '').trim().toUpperCase()
    const buyer = (customer?.state_code ?? '').trim().toUpperCase()
    if (supplier && buyer && supplier === buyer) return 'INTRA_STATE'
    return 'INTER_STATE'
  }, [invoice?.tax_treatment, customer, org.data?.stateCode])

  // INR → GST (+ TDS); non-INR → a single VAT line. The tax-rate column shows
  // for both (GST %/VAT %); HSN/SAC + TDS stay INR-only.
  const isDomestic = isGstCurrency(currency)
  const taxLbl = taxLabel(currency)
  const lineGrid = isDomestic ? LINE_GRID : LINE_GRID_INTL

  // An export is zero-rated only under LUT; on the with-IGST route the tax is
  // charged and refunded later.
  const exportRoute = invSettings.data?.data?.export_under_lut === false ? 'WITH_IGST' : 'LUT'
  const totals = useMemo(
    () => computeTotals({ lines, taxTreatment, discountType, discountValue, tdsRate, currency, exportRoute }),
    [lines, taxTreatment, discountType, discountValue, tdsRate, currency, exportRoute],
  )

  // Apply a TDS payment code: auto-fill section 393 + its standard rate.
  const applyTdsCode = (code: string) => {
    const found = TDS_CODES.find((c) => c.code === code)
    if (!found) {
      setTdsCode('')
      setTdsSection('')
      setTdsRate('')
      return
    }
    setTdsCode(found.code)
    setTdsSection('393')
    setTdsRate(found.rate)
  }

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

  /** Validate + persist the draft; returns the saved invoice id (or null). */
  const persist = async (): Promise<{ id: string; invoice_number: string } | null> => {
    if (!customerId) {
      toast({ title: 'Pick a client first', variant: 'destructive' })
      return null
    }
    const valid = lines
      .filter((l) => l.item_name.trim() && l.rate)
      // A blank GST/VAT % means 0% — the API's number-string validation
      // rejects '' (bit non-INR invoices where the VAT field was cleared).
      .map((l) => ({
        ...l,
        gst_rate: l.gst_rate?.trim() ? l.gst_rate : '0',
        cess_rate: l.cess_rate?.trim() ? l.cess_rate : '0',
      }))
    if (!valid.length) {
      toast({ title: 'Add at least one line item', variant: 'destructive' })
      return null
    }
    const payload: InvoiceInput = {
      customer_id: customerId,
      invoice_date: invoiceDate,
      due_date: dueDate,
      currency,
      reference: reference || undefined,
      discount_type: discountType || undefined,
      discount_value: discountType ? discountValue || '0' : undefined,
      // TDS is India-only — never send it for non-INR invoices.
      tds_section: isDomestic ? tdsSection || undefined : undefined,
      tds_payment_code: isDomestic ? tdsCode || undefined : undefined,
      tds_rate: isDomestic ? tdsRate || undefined : undefined,
      notes: notes || undefined,
      terms_and_conditions: terms || undefined,
      bank_account_id: bankAccountId || undefined,
      document_type: isQuote ? 'QUOTE' : undefined,
      line_items: valid,
    }
    const res = await save.mutateAsync({ id: invoice?.id, ...payload })
    return { id: res.data.id, invoice_number: res.data.invoice_number }
  }

  const onSave = async (thenSend = false) => {
    let saved: Awaited<ReturnType<typeof persist>> = null
    try {
      saved = await persist()
      if (!saved) return
    } catch (err) {
      toast({
        title: 'Could not save invoice',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
      return
    }
    if (thenSend) {
      try {
        const sent = await send.mutateAsync(saved.id)
        toast({ title: `Invoice ${saved.invoice_number} sent`, description: sent.meta.public_url })
      } catch (err) {
        // The draft persisted — say so, or the user retypes everything.
        toast({
          title: `Saved as ${saved.invoice_number}, but sending failed`,
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        })
        return
      }
    } else {
      const noun = isQuote ? 'Quote' : 'Draft'
      toast({ title: invoice ? `${noun} updated` : `${noun} ${saved.invoice_number} created` })
    }
    router.push(isQuote ? '/invoicing/quotes' : '/invoicing/invoices')
  }

  // Preview the current draft (prototype's editor "Preview" CTA). Saves first so
  // the full-page preview renders exactly what's been entered, then opens it.
  const onPreview = async () => {
    try {
      const saved = await persist()
      if (!saved) return
      router.push(`/invoicing/${saved.id}/preview`)
    } catch (err) {
      toast({
        title: 'Could not open preview',
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <label style={invoLabel}>Client</label>
                  <button
                    type="button"
                    onClick={() => setAddingClient(true)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: INVO.blue, fontSize: 12, fontWeight: 700, padding: 0,
                    }}
                  >
                    + New client
                  </button>
                </div>
                <select style={invoSelect()} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Select a client…</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name} ({c.customer_code})
                    </option>
                  ))}
                </select>
                <CustomerModal
                  open={addingClient}
                  onOpenChange={setAddingClient}
                  onCreated={(c) => setCustomerId(c.id)}
                />
                {customer?.gstin && (
                  <div style={{ marginTop: 8, fontWeight: 600, fontSize: 12, color: INVO.muted40 }}>
                    GSTIN: {customer.gstin}
                  </div>
                )}
              </div>
              <div>
                <label style={invoLabel}>Issue date</label>
                <DateField value={invoiceDate} onChange={setInvoiceDate} style={invoField()} />
              </div>
              <div>
                <label style={invoLabel}>Due date</label>
                <DateField value={dueDate} onChange={setDueDate} style={invoField()} />
              </div>
              <div>
                <label style={invoLabel}>Currency</label>
                <select style={invoSelect()} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c}>
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
            <div style={{ display: 'grid', gridTemplateColumns: lineGrid, gap: 8, marginBottom: 10 }}>
              {[
                { h: 'Description', a: 'left' as const },
                ...(isDomestic ? [{ h: 'HSN/SAC', a: 'left' as const }] : []),
                { h: 'Qty', a: 'right' as const },
                { h: `Rate (${symbol(currency).trim()})`, a: 'right' as const },
                { h: `${taxLbl} %`, a: 'right' as const },
                { h: 'Amount', a: 'right' as const },
                { h: '', a: 'left' as const },
              ].map((c, i) => (
                <div key={i} style={{ fontWeight: 700, fontSize: 12, color: INVO.muted40, letterSpacing: '-0.01em', textAlign: c.a }}>
                  {c.h}
                </div>
              ))}
            </div>
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: lineGrid, gap: 8, marginBottom: 10, alignItems: 'center' }}>
                <input
                  style={invoField(true)}
                  placeholder="Description"
                  value={l.item_name}
                  onChange={(e) => setLine(i, { item_name: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                {isDomestic && (
                  <input
                    style={invoField(true)}
                    placeholder="998314"
                    value={l.hsn_sac_code ?? ''}
                    onChange={(e) => setLine(i, { hsn_sac_code: e.target.value })}
                    onKeyDown={onLineKeyDown}
                  />
                )}
                <input
                  style={{ ...invoField(true), textAlign: 'right' }}
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                <input
                  style={{ ...invoField(true), textAlign: 'right' }}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={l.rate}
                  onChange={(e) => setLine(i, { rate: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                <input
                  style={{ ...invoField(true), textAlign: 'right' }}
                  inputMode="decimal"
                  value={l.gst_rate ?? ''}
                  onChange={(e) => setLine(i, { gst_rate: e.target.value })}
                  onKeyDown={onLineKeyDown}
                />
                <div style={{ fontWeight: 700, fontSize: 14, color: '#fff', letterSpacing: '-0.02em', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
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

          {/* Discount (+ TDS for INR only) */}
          <InvoCard style={{ marginBottom: 20 }}>
            <InvoCardTitle>{isDomestic ? 'Discount & TDS' : 'Discount'}</InvoCardTitle>
            <div style={{ display: 'grid', gridTemplateColumns: isDomestic ? '1fr 1fr' : '1fr', gap: 20 }}>
              {/* Discount */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={invoLabel}>Discount</label>
                  <select
                    style={invoSelect()}
                    value={discountType}
                    onChange={(e) => setDiscountType(e.target.value as 'percent' | 'fixed' | '')}
                  >
                    <option value="">None</option>
                    <option value="percent">Percent %</option>
                    <option value="fixed">Fixed</option>
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
              </div>

              {/* TDS — single Section-393 payment-code dropdown (prototype). */}
              {isDomestic && (
                <div>
                  <label style={invoLabel}>TDS · Section 393 (payment code)</label>
                  <select style={invoSelect()} value={tdsCode} onChange={(e) => applyTdsCode(e.target.value)}>
                    <option value="">No TDS</option>
                    {TDS_CODES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  {parseFloat(tdsRate || '0') > 0 && (
                    <div
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        marginTop: 10, padding: '9px 12px', borderRadius: 9,
                        background: 'rgba(62,123,250,.10)', border: '1px solid rgba(62,123,250,.25)',
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 800, color: INVO.blue }}>Net receivable ({tdsRate}% TDS)</span>
                      <span style={{ fontSize: 14, fontWeight: 800, color: INVO.blue }}>
                        {symbol(currency)}{parseFloat(totals.net_receivable).toLocaleString('en-IN')}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </InvoCard>

          {/* Bank account (§8 — auto-picked by currency, overridable) */}
          <InvoCard style={{ marginBottom: 20 }}>
            <InvoCardTitle>Bank account on invoice</InvoCardTitle>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
              <div>
                <label style={invoLabel}>Account</label>
                <select style={invoSelect()} value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
                  <option value="">
                    Auto ({currency} default)
                  </option>
                  {bankAccounts.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bank_name} …{b.account_number.slice(-4)}
                      {b.is_default ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ paddingTop: 24, fontWeight: 600, fontSize: 12, color: INVO.muted40, lineHeight: 1.5 }}>
                {resolvedBank ? (
                  <>
                    Will render: <span style={{ color: '#fff' }}>{resolvedBank.bank_name}</span> ·{' '}
                    {currency === 'INR'
                      ? `IFSC ${resolvedBank.ifsc ?? '—'}`
                      : `SWIFT ${resolvedBank.swift_bic ?? '—'}`}
                  </>
                ) : (
                  'No bank account — the invoice renders without a bank-transfer block.'
                )}
              </div>
            </div>
            {swiftWarning && (
              <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 10, background: 'rgba(254,216,0,0.08)', border: '1px solid rgba(254,216,0,0.25)', fontWeight: 600, fontSize: 12, color: '#FED800' }}>
                {swiftWarning}
              </div>
            )}
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
              {/* INR → GST rows; non-INR → a single VAT row. */}
              {isDomestic ? (taxTreatment === 'INTRA_STATE' ? (
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
              )) : (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={sumRowLabel}>VAT</span>
                  <span style={sumRowValue}>{money(totals.igst_amount)}</span>
                </div>
              )}
              {isDomestic && parseFloat(totals.cess_amount) > 0 && (
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
              <InvoBtn kind="secondary" full height={44} onClick={onPreview} disabled={save.isPending}>
                Preview
              </InvoBtn>
            </div>
          </InvoCard>
        </div>
      </div>
    </InvoPage>
  )
}
