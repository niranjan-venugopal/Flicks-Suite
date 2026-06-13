/**
 * Client-side mirror of the API's GST/TDS engine (apps/api …/tax.util.ts) so
 * the editor's totals card updates live without a round-trip. The server
 * recomputes authoritatively on save — this is display-only. Keep the math in
 * sync with the API (integer paise, proportional discount, intra split).
 */

export interface EditorLine {
  quantity: string
  rate: string
  gst_rate?: string
  cess_rate?: string
}

export interface EditorTotals {
  subtotal: string
  discount_amount: string
  taxable_amount: string
  cgst_amount: string
  sgst_amount: string
  igst_amount: string
  cess_amount: string
  total_amount: string
  tds_amount: string
  net_receivable: string
}

const toCents = (v: string | undefined | null): number => {
  const n = parseFloat(v ?? '0')
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}
const fromCents = (c: number): string => (c / 100).toFixed(2)
const pct = (base: number, rate: number): number => Math.round((base * rate) / 100)

export function computeTotals(opts: {
  lines: EditorLine[]
  taxTreatment: string
  discountType?: 'percent' | 'fixed' | ''
  discountValue?: string
  tdsRate?: string
  // GST/TDS are India-only — non-INR invoices carry neither (mirrors the
  // backend tax.util.computeInvoice gate).
  currency?: string
}): EditorTotals {
  const lineAmounts = opts.lines.map((l) => {
    const qty = parseFloat(l.quantity || '0')
    const rate = parseFloat(l.rate || '0')
    return Number.isFinite(qty * rate) ? Math.round(qty * rate * 100) : 0
  })
  const subtotal = lineAmounts.reduce((a, b) => a + b, 0)

  let discount = 0
  if (opts.discountType === 'percent') discount = pct(subtotal, parseFloat(opts.discountValue || '0'))
  else if (opts.discountType === 'fixed') discount = toCents(opts.discountValue)
  discount = Math.max(0, Math.min(discount, subtotal))

  const discounts = lineAmounts.map((amt) => (subtotal > 0 ? Math.floor((discount * amt) / subtotal) : 0))
  let allocated = discounts.reduce((a, b) => a + b, 0)
  for (let i = lineAmounts.length - 1; i >= 0 && allocated < discount; i--) {
    if (lineAmounts[i]! > 0) {
      discounts[i]! += discount - allocated
      allocated = discount
    }
  }

  const isDomestic = (opts.currency ?? 'INR') === 'INR'
  const isExport = opts.taxTreatment === 'EXPORT' || !isDomestic
  const isIntra = opts.taxTreatment === 'INTRA_STATE' && isDomestic
  let cgst = 0,
    sgst = 0,
    igst = 0,
    cess = 0,
    taxable = 0
  opts.lines.forEach((l, i) => {
    const t = lineAmounts[i]! - discounts[i]!
    taxable += t
    const g = isExport ? 0 : parseFloat(l.gst_rate || '0') || 0
    const c = isExport ? 0 : parseFloat(l.cess_rate || '0') || 0
    if (isIntra) {
      cgst += pct(t, g / 2)
      sgst += pct(t, g / 2)
    } else {
      igst += pct(t, g)
    }
    cess += pct(t, c)
  })
  const total = taxable + cgst + sgst + igst + cess
  const tds = isDomestic ? pct(taxable, parseFloat(opts.tdsRate || '0') || 0) : 0

  return {
    subtotal: fromCents(subtotal),
    discount_amount: fromCents(discount),
    taxable_amount: fromCents(taxable),
    cgst_amount: fromCents(cgst),
    sgst_amount: fromCents(sgst),
    igst_amount: fromCents(igst),
    cess_amount: fromCents(cess),
    total_amount: fromCents(total),
    tds_amount: fromCents(tds),
    net_receivable: fromCents(total - tds),
  }
}
