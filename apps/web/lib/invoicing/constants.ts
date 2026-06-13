/**
 * Invoicing currency + TDS constants (web).
 *
 * GST and TDS are India-domestic taxes — they appear only on INR invoices.
 * `isGstCurrency` is the single gate used across the editor, renderer and
 * reports so the UI matches the server (tax.util.computeInvoice).
 */

export interface CurrencyMeta {
  name: string
  symbol: string
  precision: number
}

export const SUPPORTED_CURRENCIES: Record<string, CurrencyMeta> = {
  INR: { name: 'Indian Rupee', symbol: '₹', precision: 2 },
  USD: { name: 'US Dollar', symbol: '$', precision: 2 },
  EUR: { name: 'Euro', symbol: '€', precision: 2 },
  GBP: { name: 'British Pound', symbol: '£', precision: 2 },
}

export const SUPPORTED_CURRENCY_CODES = Object.keys(SUPPORTED_CURRENCIES)

export function currencySymbol(code: string | null | undefined): string {
  return SUPPORTED_CURRENCIES[code ?? 'INR']?.symbol ?? `${code} `
}

/** Format a numeric/string amount with the right currency symbol (en-IN grouping). */
export function formatMoney(amount: string | number, code: string | null | undefined): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  const sym = currencySymbol(code)
  return `${sym}${Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : amount}`
}

/** GST/TDS apply only to INR (India domestic). */
export function isGstCurrency(code: string | null | undefined): boolean {
  return (code ?? 'INR') === 'INR'
}

/**
 * TDS payment codes (Income-Tax Act 2025, Section 393). Illustrative / seed
 * per PRD §13.3 Q8 — pending CFO sign-off. Each carries its standard rate;
 * selecting a code auto-fills section 393 + rate in the editor.
 */
export interface TdsCode {
  code: string
  label: string
  rate: string
}

export const TDS_CODES: TdsCode[] = [
  { code: '194C', label: '194C · Contractor / sub-contractor', rate: '2' },
  { code: '194J', label: '194J · Professional / technical fees', rate: '10' },
  { code: '194H', label: '194H · Commission or brokerage', rate: '5' },
  { code: '194I', label: '194I · Rent', rate: '10' },
  { code: '194Q', label: '194Q · Purchase of goods', rate: '0.1' },
]
