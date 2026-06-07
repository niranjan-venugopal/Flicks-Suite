import { ScaffoldPage } from '@/components/invoicing/ScaffoldPage'

/**
 * Hosted public invoice page (PRD §9.3) — the customer's view: rendered invoice
 * + payment block (UPI QR for INR, Razorpay, conditional bank details). Shares
 * the renderer with the in-app preview. Built in Sprint 4. The signed token
 * scopes to exactly one invoice.
 */
export default function PublicInvoicePage() {
  return (
    <ScaffoldPage
      eyebrow="Hosted invoice"
      icon="doc"
      title="View & pay"
      sub="The customer-facing invoice + payment options."
      sprint="Sprint 4"
    />
  )
}
