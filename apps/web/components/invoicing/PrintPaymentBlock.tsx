'use client'

import { QRCodeSVG } from 'qrcode.react'
import { INVO } from '@/components/invoicing/invo'
import type { PublicInvoicePayload } from '@/lib/api/queries/use-invoicing'

/**
 * Print/PDF payment block — the static counterpart to the hosted page's
 * interactive PaymentBlock. A PDF can't have working buttons, so this drops the
 * "Pay with Razorpay" / UPI-app buttons and instead shows what's useful on a
 * printed/forwarded invoice: a scannable UPI QR (INR only, amount + invoice
 * prefilled) and the seller's bank-transfer details. Renders nothing when the
 * invoice is already settled or no payment rails are configured, so the PDF
 * stays clean. Same dark theme as InvoiceRenderer.
 */

const symbol = (c: string) =>
  c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `
const money = (v: string | null | undefined, c: string) => {
  const n = parseFloat(v ?? '0')
  return `${symbol(c)}${Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : v}`
}

const cap: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 11,
  color: INVO.muted40,
  letterSpacing: '-0.01em',
  textTransform: 'uppercase',
  marginBottom: 4,
}

export function PrintPaymentBlock({ payload }: { payload: PublicInvoicePayload }) {
  const { invoice, payment_options: opts, seller } = payload
  const cur = invoice.currency
  const outstanding = parseFloat(invoice.amount_outstanding ?? invoice.total_amount)
  const settled =
    ['PAID', 'CANCELLED', 'VOIDED', 'WRITE_OFF', 'REFUNDED'].includes(invoice.status) ||
    outstanding <= 0

  const card: React.CSSProperties = {
    maxWidth: 820,
    margin: '16px auto 0',
    background: INVO.cardBgStrong,
    borderRadius: 16,
    padding: '28px 32px',
    border: '1px solid rgba(255,255,255,0.06)',
    breakInside: 'avoid',
  }

  if (settled) {
    return (
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 15, color: INVO.green, letterSpacing: '-0.02em' }}>
          {invoice.status === 'PAID'
            ? '✓ Paid in full — thank you.'
            : 'No payment is due on this invoice.'}
        </div>
      </div>
    )
  }

  const upiLink = opts.upi
    ? `upi://pay?pa=${encodeURIComponent(opts.upi.upi_id)}&pn=${encodeURIComponent(
        opts.upi.display_name ?? seller?.name ?? 'Payee',
      )}&am=${outstanding.toFixed(2)}&cu=INR&tn=${encodeURIComponent(invoice.invoice_number)}`
    : null
  const bank = opts.bank_transfer

  // Nothing actionable to show — omit the block entirely (no empty "not available").
  if (!upiLink && !bank) return null

  const bankRows: [string, string][] = bank
    ? [
        ['Beneficiary', bank.beneficiary_name],
        ['Account number', bank.account_number],
        ...(bank.ifsc ? ([['IFSC', bank.ifsc]] as [string, string][]) : []),
        ...(bank.swift_bic ? ([['SWIFT / BIC', bank.swift_bic]] as [string, string][]) : []),
        ['Bank', `${bank.bank_name}${bank.branch ? ` · ${bank.branch}` : ''}`],
        ...(bank.bank_address ? ([['Bank address', bank.bank_address]] as [string, string][]) : []),
      ]
    : []

  return (
    <div style={card}>
      <div
        style={{
          fontWeight: 700,
          fontSize: 16,
          color: '#fff',
          letterSpacing: '-0.02em',
          marginBottom: 18,
        }}
      >
        Payment
      </div>
      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
        {upiLink && opts.upi && (
          <div style={{ textAlign: 'center', flexShrink: 0 }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: 10, width: 150, height: 150 }}>
              <QRCodeSVG value={upiLink} size={130} bgColor="#ffffff" fgColor="#01010D" level="M" />
            </div>
            <div style={{ ...cap, marginTop: 10 }}>Scan to pay · UPI</div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#fff', marginTop: 4 }}>
              {opts.upi.upi_id}
            </div>
          </div>
        )}
        <div style={{ flex: 1 }}>
          {bank ? (
            <>
              <div style={cap}>Bank transfer</div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '14px 20px',
                  marginTop: 8,
                }}
              >
                {bankRows.map(([l, v]) => (
                  <div key={l}>
                    <div style={cap}>{l}</div>
                    <div
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 13,
                        color: '#fff',
                        wordBreak: 'break-word',
                      }}
                    >
                      {v}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ fontWeight: 600, fontSize: 13, color: INVO.muted50, lineHeight: 1.6 }}>
              Pay {seller?.name ?? 'the seller'} directly by scanning the UPI code with any UPI app
              (GPay, PhonePe, Paytm, etc.).
            </div>
          )}
          <div style={{ fontWeight: 600, fontSize: 12, color: INVO.muted50, marginTop: 16 }}>
            Amount payable:{' '}
            <span style={{ color: '#fff', fontWeight: 700 }}>
              {money(invoice.amount_outstanding ?? invoice.total_amount, cur)}
            </span>{' '}
            · Ref {invoice.invoice_number}
          </div>
        </div>
      </div>
    </div>
  )
}
