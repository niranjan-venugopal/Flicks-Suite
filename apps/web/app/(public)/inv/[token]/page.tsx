'use client'

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { InvoiceRenderer } from '@/components/invoicing/InvoiceRenderer'
import { INVO, InvoBtn, InvoCard } from '@/components/invoicing/invo'
import { usePublicInvoice, trackPublicView, type PublicInvoicePayload } from '@/lib/api/queries/use-invoicing'

/**
 * Hosted public invoice page (PRD §9.3) — the customer's view. No app chrome:
 * the rendered invoice, then the payment block (UPI for INR, Razorpay when the
 * tenant connected an account, bank details arriving with Sprint 5), then T&C.
 * Opening the page fires the view-tracking ping (SENT → VIEWED).
 */

function PaymentBlock({ payload }: { payload: PublicInvoicePayload }) {
  const { invoice, payment_options: opts } = payload
  const outstanding = parseFloat(invoice.amount_outstanding ?? invoice.total_amount)
  if (['PAID', 'CANCELLED', 'VOIDED', 'WRITE_OFF', 'REFUNDED'].includes(invoice.status) || outstanding <= 0) {
    return (
      <InvoCard strong style={{ maxWidth: 820, margin: '24px auto 0', textAlign: 'center' }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: INVO.green, letterSpacing: '-0.02em' }}>
          {invoice.status === 'PAID' ? '✓ This invoice is fully paid — thank you!' : 'No payment is due on this invoice.'}
        </div>
      </InvoCard>
    )
  }

  const upiLink = opts.upi
    ? `upi://pay?pa=${encodeURIComponent(opts.upi.upi_id)}&pn=${encodeURIComponent(
        opts.upi.display_name ?? payload.seller?.name ?? 'Payee',
      )}&am=${outstanding.toFixed(2)}&cu=INR&tn=${encodeURIComponent(invoice.invoice_number)}`
    : null

  return (
    <InvoCard strong style={{ maxWidth: 820, margin: '24px auto 0' }}>
      <div style={{ fontWeight: 700, fontSize: 18, color: '#fff', letterSpacing: '-0.02em', marginBottom: 18 }}>
        Pay this invoice
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* UPI — INR only (§9.3) */}
        {upiLink && (
          <div style={{ padding: 18, borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#fff', marginBottom: 8 }}>UPI</div>
            <div style={{ fontWeight: 600, fontSize: 13, color: INVO.muted50, marginBottom: 12 }}>
              Pay {payload.seller?.name ?? 'the seller'} directly via any UPI app.
            </div>
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 13,
                color: '#fff',
                background: 'rgba(255,255,255,0.06)',
                borderRadius: 8,
                padding: '8px 12px',
                marginBottom: 12,
                wordBreak: 'break-all',
              }}
            >
              {opts.upi!.upi_id}
            </div>
            <a href={upiLink} style={{ textDecoration: 'none' }}>
              <InvoBtn kind="primary" full height={44}>
                Pay via UPI app
              </InvoBtn>
            </a>
          </div>
        )}

        {/* Razorpay */}
        <div style={{ padding: 18, borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#fff', marginBottom: 8 }}>Card / Netbanking / Wallet</div>
          <div style={{ fontWeight: 600, fontSize: 13, color: INVO.muted50, marginBottom: 12 }}>
            {opts.razorpay
              ? 'Secure checkout powered by Razorpay.'
              : 'Online checkout is not enabled for this seller yet.'}
          </div>
          <InvoBtn
            kind={opts.razorpay ? 'primary' : 'outline'}
            full
            height={44}
            disabled={!opts.razorpay}
            title={opts.razorpay ? undefined : 'The seller has not connected Razorpay'}
          >
            Pay with Razorpay
          </InvoBtn>
        </div>

        {/* Bank transfer (§8): INR ⇒ IFSC; foreign currency ⇒ SWIFT + bank address */}
        {opts.bank_transfer ? (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: 18,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, color: '#fff', marginBottom: 12 }}>Bank transfer</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              {(
                [
                  ['Beneficiary', opts.bank_transfer.beneficiary_name],
                  ['Account number', opts.bank_transfer.account_number],
                  ['Bank', `${opts.bank_transfer.bank_name}${opts.bank_transfer.branch ? ` · ${opts.bank_transfer.branch}` : ''}`],
                  ...(opts.bank_transfer.ifsc ? [['IFSC', opts.bank_transfer.ifsc] as [string, string]] : []),
                  ...(opts.bank_transfer.swift_bic ? [['SWIFT / BIC', opts.bank_transfer.swift_bic] as [string, string]] : []),
                  ...(opts.bank_transfer.bank_address ? [['Bank address', opts.bank_transfer.bank_address] as [string, string]] : []),
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label}>
                  <div style={{ fontWeight: 700, fontSize: 11, color: INVO.muted40, textTransform: 'uppercase', letterSpacing: '-0.01em', marginBottom: 4 }}>
                    {label}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 13, color: '#fff', wordBreak: 'break-word' }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: 18,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.03)',
              border: '1px dashed rgba(255,255,255,0.12)',
              fontWeight: 600,
              fontSize: 13,
              color: INVO.muted40,
            }}
          >
            Bank transfer details are not available for this invoice.
          </div>
        )}
      </div>
    </InvoCard>
  )
}

export default function PublicInvoicePage() {
  const params = useParams<{ token: string }>()
  const token = params?.token
  const { data, isLoading, isError } = usePublicInvoice(token)

  useEffect(() => {
    if (token && data?.data) trackPublicView(token)
    // ping once per load, after the invoice resolves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, !!data?.data])

  return (
    <div style={{ minHeight: '100vh', background: '#01010D', padding: '48px 24px 64px' }}>
      {isLoading && (
        <div style={{ textAlign: 'center', color: INVO.muted40, fontWeight: 600, paddingTop: 80 }}>Loading invoice…</div>
      )}
      {isError && (
        <div style={{ textAlign: 'center', color: INVO.coral, fontWeight: 600, paddingTop: 80 }}>
          This invoice link is invalid or has expired.
        </div>
      )}
      {data?.data && (
        <>
          <InvoiceRenderer payload={data.data} />
          <PaymentBlock payload={data.data} />
          {data.data.show_powered_by && (
            <div style={{ textAlign: 'center', marginTop: 32, fontWeight: 600, fontSize: 12, color: INVO.muted30 }}>
              Powered by Flicks Suite
            </div>
          )}
        </>
      )}
    </div>
  )
}
