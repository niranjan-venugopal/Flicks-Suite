/**
 * GST + TDS calculation engine (PRD §6.1 / §6.2).
 *
 * Pure functions, no I/O. All money flows through integer paise (cents) math to
 * avoid float drift; inputs/outputs are decimal strings matching the
 * NUMERIC(15,2) columns.
 *
 * Rules implemented:
 *  • Place of supply + supplier state decide the split — intra-state →
 *    CGST + SGST (each = rate/2); inter-state / export → IGST (full rate).
 *    Exports are zero-rated by default (LUT) unless an explicit rate is kept.
 *  • Cess applies on top of the taxable amount where set.
 *  • Per-line tax is computed on each line's taxable amount (after discount
 *    allocation); invoice totals are the sum of the lines.
 *  • An invoice-level discount (percent or fixed) is allocated across lines
 *    proportionally to their line amounts (largest-remainder on the last line)
 *    so GST is charged on the post-discount value, per GST valuation rules.
 *  • TDS: tds_rate applied to the taxable base; net_receivable = total − tds.
 */

export type TaxTreatment =
  | 'INTRA_STATE'
  | 'INTER_STATE'
  | 'EXPORT'
  | 'B2C_LARGE'
  | 'B2C_SMALL';

export interface LineInput {
  quantity: string; // NUMERIC(15,4)
  rate: string; // NUMERIC(15,2)
  gst_rate?: string | null; // percent
  cess_rate?: string | null; // percent
}

export interface ComputedLine {
  line_amount: string;
  discount_amount: string;
  taxable_amount: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  cess_amount: string;
  line_total: string;
}

export interface InvoiceTotals {
  subtotal: string;
  discount_amount: string;
  taxable_amount: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  cess_amount: string;
  total_amount: string;
  tds_amount: string;
  net_receivable: string;
}

export interface ComputeInput {
  lines: LineInput[];
  taxTreatment: TaxTreatment;
  discountType?: 'percent' | 'fixed' | null;
  discountValue?: string | null; // percent (0–100) or fixed amount
  tdsRate?: string | null; // percent of taxable base
  /**
   * Invoice currency. GST and TDS are India-domestic taxes — they apply only
   * to INR invoices. Any other currency is treated as international: GST is
   * zero-rated and TDS is not withheld (PRD §6.1/§6.2; matches the editor UI).
   */
  currency?: string | null;
  /** Export route (GST): 'LUT' zero-rates the supply, 'WITH_IGST' charges it. */
  exportRoute?: 'LUT' | 'WITH_IGST' | null;
}

export interface ComputeResult {
  lines: ComputedLine[];
  totals: InvoiceTotals;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const toCents = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '0');
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
};
const fromCents = (c: number): string => (c / 100).toFixed(2);
const pct = (baseCents: number, ratePercent: number): number =>
  Math.round((baseCents * ratePercent) / 100);

/**
 * Derive the tax treatment from supplier/customer geography (PRD §6.1).
 * Caller may override (place_of_supply is user-editable in the editor).
 */
export function deriveTaxTreatment(opts: {
  supplierStateCode?: string | null;
  customerStateCode?: string | null;
  customerCountryCode?: string | null;
}): TaxTreatment {
  const country = (opts.customerCountryCode ?? 'IN').toUpperCase();
  if (country !== 'IN') return 'EXPORT';
  const supplier = (opts.supplierStateCode ?? '').trim().toUpperCase();
  const customer = (opts.customerStateCode ?? '').trim().toUpperCase();
  if (supplier && customer && supplier === customer) return 'INTRA_STATE';
  return 'INTER_STATE';
}

/** Compute per-line tax columns + invoice totals. */
export function computeInvoice(input: ComputeInput): ComputeResult {
  // 1. Line amounts (qty × rate), in cents.
  const lineAmounts = input.lines.map((l) => {
    const qty = parseFloat(l.quantity || '0');
    const rate = parseFloat(l.rate || '0');
    const amount = Number.isFinite(qty * rate) ? qty * rate : 0;
    return Math.round(amount * 100);
  });
  const subtotal = lineAmounts.reduce((a, b) => a + b, 0);

  // 2. Invoice-level discount → total discount in cents, then allocate
  //    proportionally across lines (remainder to the last non-zero line).
  let totalDiscount = 0;
  if (input.discountType === 'percent') {
    totalDiscount = pct(subtotal, parseFloat(input.discountValue ?? '0'));
  } else if (input.discountType === 'fixed') {
    totalDiscount = toCents(input.discountValue);
  }
  totalDiscount = Math.max(0, Math.min(totalDiscount, subtotal));

  const discounts = lineAmounts.map((amt) =>
    subtotal > 0 ? Math.floor((totalDiscount * amt) / subtotal) : 0,
  );
  let allocated = discounts.reduce((a, b) => a + b, 0);
  for (let i = lineAmounts.length - 1; i >= 0 && allocated < totalDiscount; i--) {
    if (lineAmounts[i]! > 0) {
      discounts[i]! += totalDiscount - allocated;
      allocated = totalDiscount;
    }
  }

  // 3. Per-line taxes on the post-discount taxable amount.
  //    INR (domestic): GST — intra → CGST+SGST, inter → IGST, EXPORT → zero-rated
  //      (LUT); cess + TDS apply.
  //    Non-INR (international): a single VAT/sales tax at the line's rate, booked
  //      in the IGST slot (no intra split, no cess, no TDS). The rate field
  //      (`gst_rate`) doubles as the generic per-currency tax rate.
  const isDomestic = (input.currency ?? 'INR') === 'INR';
  // An export is zero-rated only under LUT/bond. On the "with payment of
  // IGST" route the tax IS charged (and refunded later), so the line rate
  // stands. Defaulting to LUT reproduces the previous behaviour exactly.
  const zeroRated =
    isDomestic &&
    input.taxTreatment === 'EXPORT' &&
    (input.exportRoute ?? 'LUT') !== 'WITH_IGST';
  const isIntra = input.taxTreatment === 'INTRA_STATE' && isDomestic;

  const lines: ComputedLine[] = input.lines.map((l, i) => {
    const lineAmount = lineAmounts[i]!;
    const discount = discounts[i]!;
    const taxable = lineAmount - discount;
    // GST rate (INR) or VAT rate (non-INR); zero-rated INR exports charge nothing.
    const taxRate = zeroRated ? 0 : parseFloat(l.gst_rate ?? '0') || 0;
    const cessRate = isDomestic && !zeroRated ? parseFloat(l.cess_rate ?? '0') || 0 : 0;

    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    if (isIntra) {
      cgst = pct(taxable, taxRate / 2);
      sgst = pct(taxable, taxRate / 2);
    } else {
      // Inter-state IGST, or the single VAT line for non-INR invoices.
      igst = pct(taxable, taxRate);
    }
    const cess = pct(taxable, cessRate);
    const lineTotal = taxable + cgst + sgst + igst + cess;

    return {
      line_amount: fromCents(lineAmount),
      discount_amount: fromCents(discount),
      taxable_amount: fromCents(taxable),
      cgst_amount: fromCents(cgst),
      sgst_amount: fromCents(sgst),
      igst_amount: fromCents(igst),
      cess_amount: fromCents(cess),
      line_total: fromCents(lineTotal),
    };
  });

  // 4. Invoice totals = sum of lines.
  const sum = (k: keyof ComputedLine) =>
    lines.reduce((a, l) => a + toCents(l[k]), 0);
  const taxableTotal = sum('taxable_amount');
  const cgstTotal = sum('cgst_amount');
  const sgstTotal = sum('sgst_amount');
  const igstTotal = sum('igst_amount');
  const cessTotal = sum('cess_amount');
  const grandTotal = taxableTotal + cgstTotal + sgstTotal + igstTotal + cessTotal;

  // 5. TDS on the taxable base; net receivable = total − TDS (PRD §6.2).
  //    TDS is India-domestic — never withheld on non-INR invoices.
  const tdsRate = isDomestic ? parseFloat(input.tdsRate ?? '0') || 0 : 0;
  const tds = pct(taxableTotal, tdsRate);

  return {
    lines,
    totals: {
      subtotal: fromCents(subtotal),
      discount_amount: fromCents(totalDiscount),
      taxable_amount: fromCents(taxableTotal),
      cgst_amount: fromCents(cgstTotal),
      sgst_amount: fromCents(sgstTotal),
      igst_amount: fromCents(igstTotal),
      cess_amount: fromCents(cessTotal),
      total_amount: fromCents(grandTotal),
      tds_amount: fromCents(tds),
      net_receivable: fromCents(grandTotal - tds),
    },
  };
}
