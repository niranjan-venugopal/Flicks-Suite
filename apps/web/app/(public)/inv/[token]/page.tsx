'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { InvoiceRenderer } from '@/components/invoicing/InvoiceRenderer'
import {
  INVO,
  InvoBtn,
  InvoIcons,
  invoiceTheme,
  type InvoiceThemeName,
} from '@/components/invoicing/invo'
import { Toggle } from '@/components/proto/Toggle'
import { useToast } from '@/components/ui/use-toast'
import {
  usePublicInvoice,
  useDownloadPublicInvoicePdf,
  useCreateRazorpayOrder,
  useAcceptQuote,
  trackPublicView,
  type PublicInvoicePayload,
} from '@/lib/api/queries/use-invoicing'

const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js'

/** Loads the Razorpay Checkout script once; resolves when window.Razorpay exists. */
function loadRazorpayCheckout(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(false)
    if ((window as unknown as { Razorpay?: unknown }).Razorpay) return resolve(true)
    const existing = document.querySelector(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(true))
      existing.addEventListener('error', () => resolve(false))
      return
    }
    const s = document.createElement('script')
    s.src = RAZORPAY_CHECKOUT_SRC
    s.onload = () => resolve(true)
    s.onerror = () => resolve(false)
    document.body.appendChild(s)
  })
}

/**
 * Hosted public invoice page (PRD §9.3) — the customer's view. A slim top bar
 * (Light/Dark switch + PDF download), then the rendered invoice and an
 * interactive payment block (UPI / Razorpay / bank), all re-themeable. Opening
 * the page fires the view-tracking ping (SENT → VIEWED).
 */

function PaymentBlock({
  payload,
  theme,
  token,
}: {
  payload: PublicInvoicePayload
  theme: InvoiceThemeName
  token: string
}) {
  const { invoice, payment_options: opts } = payload
  const t = invoiceTheme(theme)
  const { toast } = useToast()
  const qc = useQueryClient()
  const createOrder = useCreateRazorpayOrder()

  const payWithRazorpay = async () => {
    try {
      const { data: order } = await createOrder.mutateAsync({ token })
      const ready = await loadRazorpayCheckout()
      const Razorpay = (window as unknown as { Razorpay?: new (o: unknown) => { open: () => void; on: (e: string, cb: () => void) => void } }).Razorpay
      if (!ready || !Razorpay || !order.key) {
        toast({ title: 'Could not open Razorpay checkout', variant: 'destructive' })
        return
      }
      const rzp = new Razorpay({
        key: order.key,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name: payload.seller?.name ?? 'Payment',
        description: `Invoice ${invoice.invoice_number}`,
        theme: { color: INVO.blue },
        handler: () => {
          toast({ title: 'Payment received', description: 'Confirming with the seller…' })
          // The webhook is the source of truth; refresh shortly after.
          setTimeout(() => qc.invalidateQueries({ queryKey: ['public-invoice', token] }), 3000)
        },
      })
      rzp.on('payment.failed', () =>
        toast({ title: 'Payment failed', description: 'Please try again.', variant: 'destructive' }),
      )
      rzp.open()
    } catch (err) {
      toast({
        title: 'Could not start the payment',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }
  const panelBg = theme === 'light' ? '#f9fafb' : 'rgba(255,255,255,0.04)'
  const panelBorder = theme === 'light' ? '1px solid #eef0f4' : '1px solid rgba(255,255,255,0.08)'
  const card: React.CSSProperties = {
    maxWidth: 820,
    margin: '24px auto 0',
    background: t.cardBg,
    border: t.cardBorder,
    boxShadow: t.cardShadow,
    borderRadius: 16,
    padding: 28,
  }
  const outstanding = parseFloat(invoice.amount_outstanding ?? invoice.total_amount)
  if (['PAID', 'CANCELLED', 'VOIDED', 'WRITE_OFF', 'REFUNDED'].includes(invoice.status) || outstanding <= 0) {
    return (
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: INVO.green, letterSpacing: '-0.02em' }}>
          {invoice.status === 'PAID' ? '✓ This invoice is fully paid — thank you!' : 'No payment is due on this invoice.'}
        </div>
      </div>
    )
  }

  const upiLink = opts.upi
    ? `upi://pay?pa=${encodeURIComponent(opts.upi.upi_id)}&pn=${encodeURIComponent(
        opts.upi.display_name ?? payload.seller?.name ?? 'Payee',
      )}&am=${outstanding.toFixed(2)}&cu=INR&tn=${encodeURIComponent(invoice.invoice_number)}`
    : null

  return (
    <div style={card}>
      <div style={{ fontWeight: 700, fontSize: 18, color: t.text, letterSpacing: '-0.02em', marginBottom: 18 }}>
        Pay this invoice
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* UPI — INR only (§9.3) */}
        {upiLink && (
          <div style={{ padding: 18, borderRadius: 12, background: panelBg, border: panelBorder }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: t.text, marginBottom: 8 }}>UPI</div>
            <div style={{ fontWeight: 600, fontSize: 13, color: t.muted50, marginBottom: 12 }}>
              Pay {payload.seller?.name ?? 'the seller'} directly via any UPI app.
            </div>
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 13,
                color: t.text,
                background: theme === 'light' ? '#eef0f4' : 'rgba(255,255,255,0.06)',
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
        <div style={{ padding: 18, borderRadius: 12, background: panelBg, border: panelBorder }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: t.text, marginBottom: 8 }}>Card / Netbanking / Wallet</div>
          <div style={{ fontWeight: 600, fontSize: 13, color: t.muted50, marginBottom: 12 }}>
            {opts.razorpay
              ? 'Secure checkout powered by Razorpay.'
              : 'Online card/UPI checkout is coming soon.'}
          </div>
          <InvoBtn
            kind="primary"
            full
            height={44}
            disabled={!opts.razorpay || createOrder.isPending}
            title={opts.razorpay ? undefined : 'Online checkout is coming soon'}
            onClick={opts.razorpay ? payWithRazorpay : undefined}
          >
            {createOrder.isPending ? 'Opening…' : 'Pay with Razorpay'}
          </InvoBtn>
        </div>

        {/* Bank transfer (§8): INR ⇒ IFSC; foreign currency ⇒ SWIFT + bank address */}
        {opts.bank_transfer ? (
          <div style={{ gridColumn: '1 / -1', padding: 18, borderRadius: 12, background: panelBg, border: panelBorder }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: t.text, marginBottom: 12 }}>Bank transfer</div>
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
                  <div style={{ fontWeight: 700, fontSize: 11, color: t.muted40, textTransform: 'uppercase', letterSpacing: '-0.01em', marginBottom: 4 }}>
                    {label}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 13, color: t.text, wordBreak: 'break-word' }}>{value}</div>
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
              background: theme === 'light' ? '#fbfcfd' : 'rgba(255,255,255,0.03)',
              border: theme === 'light' ? '1px dashed #e3e6eb' : '1px dashed rgba(255,255,255,0.12)',
              fontWeight: 600,
              fontSize: 13,
              color: t.muted40,
            }}
          >
            Bank transfer details are not available for this invoice.
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Quote acceptance block (§19.3) — shown instead of the payment block when the
 * document is a QUOTE. A sent/viewed quote can be accepted with one click; once
 * accepted it shows a confirmation (and the seller's deal auto-advances).
 */
function QuoteBlock({
  payload,
  theme,
  token,
}: {
  payload: PublicInvoicePayload
  theme: InvoiceThemeName
  token: string
}) {
  const { invoice } = payload
  const t = invoiceTheme(theme)
  const { toast } = useToast()
  const accept = useAcceptQuote(token)
  const card: React.CSSProperties = {
    maxWidth: 820,
    margin: '24px auto 0',
    background: t.cardBg,
    border: t.cardBorder,
    boxShadow: t.cardShadow,
    borderRadius: 16,
    padding: 28,
    textAlign: 'center',
  }

  if (invoice.status === 'ACCEPTED') {
    return (
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 18, color: INVO.green, letterSpacing: '-0.02em' }}>
          ✓ You’ve accepted this quote — thank you! The seller has been notified.
        </div>
      </div>
    )
  }
  if (['CANCELLED', 'VOIDED', 'EXPIRED'].includes(invoice.status)) {
    return (
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 16, color: t.muted50 }}>This quote is no longer available.</div>
      </div>
    )
  }

  const onAccept = async () => {
    try {
      await accept.mutateAsync()
      toast({ title: 'Quote accepted', description: 'The seller has been notified.' })
    } catch (err) {
      toast({ title: 'Could not accept', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <div style={card}>
      <div style={{ fontWeight: 700, fontSize: 18, color: t.text, letterSpacing: '-0.02em', marginBottom: 8 }}>
        Ready to proceed?
      </div>
      <div style={{ fontWeight: 600, fontSize: 13, color: t.muted50, marginBottom: 18 }}>
        Accepting confirms the quoted scope and pricing{invoice.valid_until ? ` (valid until ${invoice.valid_until})` : ''}.
      </div>
      <div style={{ maxWidth: 320, margin: '0 auto' }}>
        <InvoBtn kind="primary" full height={46} disabled={accept.isPending} onClick={onAccept}>
          {accept.isPending ? 'Accepting…' : 'Accept quote'}
        </InvoBtn>
      </div>
    </div>
  )
}

export default function PublicInvoicePage() {
  const params = useParams<{ token: string }>()
  const token = params?.token
  const { toast } = useToast()
  const { data, isLoading, isError } = usePublicInvoice(token)
  const download = useDownloadPublicInvoicePdf()
  const [theme, setTheme] = useState<InvoiceThemeName>('dark')
  const t = invoiceTheme(theme)
  const isLight = theme === 'light'

  useEffect(() => {
    if (token && data?.data) trackPublicView(token)
    // ping once per load, after the invoice resolves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, !!data?.data])

  const onDownload = async () => {
    if (!token || !data?.data) return
    try {
      await download.mutateAsync({ token, invoiceNumber: data.data.invoice.invoice_number, theme })
    } catch (err) {
      toast({
        title: 'Could not download PDF',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: isLight ? '#f4f5f7' : '#01010D' }}>
      {/* Top bar — Light/Dark switch + PDF download (matches the hosted-page design) */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 14,
          padding: '16px 24px',
          maxWidth: 868,
          margin: '0 auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Toggle on={isLight} onChange={(v) => setTheme(v ? 'light' : 'dark')} />
          <span style={{ fontWeight: 700, fontSize: 13, color: t.muted60, width: 38 }}>
            {isLight ? 'Light' : 'Dark'}
          </span>
        </div>
        {/* Themed PDF button — readable on both the light and dark page bg */}
        <button
          type="button"
          onClick={onDownload}
          disabled={!data?.data || download.isPending}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            height: 40,
            padding: '0 16px',
            borderRadius: 10,
            cursor: !data?.data || download.isPending ? 'default' : 'pointer',
            fontWeight: 700,
            fontSize: 14,
            background: 'transparent',
            color: t.text,
            border: `1.5px solid ${isLight ? '#d4d7de' : 'rgba(255,255,255,0.2)'}`,
            opacity: !data?.data || download.isPending ? 0.5 : 1,
          }}
        >
          {InvoIcons.download}
          {download.isPending ? 'Preparing…' : 'PDF'}
        </button>
      </div>

      <div style={{ padding: '8px 24px 64px' }}>
        {isLoading && (
          <div style={{ textAlign: 'center', color: t.muted40, fontWeight: 600, paddingTop: 80 }}>Loading invoice…</div>
        )}
        {isError && (
          <div style={{ textAlign: 'center', color: INVO.coral, fontWeight: 600, paddingTop: 80 }}>
            This invoice link is invalid or has expired.
          </div>
        )}
        {data?.data && (
          <>
            <InvoiceRenderer payload={data.data} theme={theme} />
            {data.data.invoice.document_type === 'QUOTE' ? (
              <QuoteBlock payload={data.data} theme={theme} token={token!} />
            ) : (
              <PaymentBlock payload={data.data} theme={theme} token={token!} />
            )}
            {data.data.show_powered_by && (
              <div style={{ textAlign: 'center', marginTop: 32, fontWeight: 600, fontSize: 12, color: t.muted30 }}>
                Powered by Flicks Suite
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
