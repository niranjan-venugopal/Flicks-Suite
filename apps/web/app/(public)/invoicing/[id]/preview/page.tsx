'use client'

import { useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import { InvoiceRenderer } from '@/components/invoicing/InvoiceRenderer'
import { INVO, InvoBtn } from '@/components/invoicing/invo'
import {
  useInvoice,
  useSendInvoice,
  type InvoiceDetail,
  type PublicInvoicePayload,
} from '@/lib/api/queries/use-invoicing'

/**
 * Full-page, chrome-less invoice preview (PRD §9.2): exactly what the customer
 * sees (same renderer as the hosted page), plus a slim internal action bar:
 * ← Close · Edit (drafts) · Send · Copy link · Download PDF (Sprint 6).
 */

function toPayload(inv: InvoiceDetail): PublicInvoicePayload {
  return {
    invoice: {
      invoice_number: inv.invoice_number,
      status: inv.status,
      invoice_date: inv.invoice_date,
      due_date: inv.due_date,
      currency: inv.currency,
      subtotal: inv.subtotal,
      discount_amount: inv.discount_amount,
      taxable_amount: inv.taxable_amount,
      cgst_amount: inv.cgst_amount,
      sgst_amount: inv.sgst_amount,
      igst_amount: inv.igst_amount,
      cess_amount: inv.cess_amount,
      total_amount: inv.total_amount,
      tds_section: inv.tds_section,
      tds_rate: inv.tds_rate,
      tds_amount: inv.tds_amount,
      net_receivable: inv.net_receivable,
      amount_paid: inv.amount_paid,
      amount_outstanding: inv.amount_outstanding,
      tax_treatment: inv.tax_treatment,
      place_of_supply: inv.place_of_supply,
      reference: inv.reference,
      notes: inv.notes,
      terms_and_conditions: inv.terms_and_conditions,
    },
    line_items: inv.line_items.map((l) => ({
      line_number: l.line_number,
      item_name: l.item_name,
      description: l.description ?? null,
      hsn_sac_code: l.hsn_sac_code ?? null,
      quantity: String(l.quantity),
      unit: l.unit ?? null,
      rate: String(l.rate),
      gst_rate: l.gst_rate != null ? String(l.gst_rate) : null,
      taxable_amount: l.taxable_amount,
      line_total: l.line_total,
    })),
    customer: inv.customer
      ? {
          display_name: inv.customer.display_name,
          legal_name: inv.customer.legal_name ?? null,
          gstin: inv.customer.gstin ?? null,
          billing_address_line1: null,
          billing_address_line2: null,
          billing_city: null,
          billing_state: inv.customer.state_code ?? null,
          billing_postal_code: null,
          billing_country: null,
        }
      : null,
    // The preview runs before/without a public payload, so seller branding is
    // minimal here; the hosted page enriches it from the tenant row.
    seller: null,
    payment_options: { upi: null, razorpay: null, bank_transfer: null, allow_partial: true },
    show_powered_by: false,
  }
}

export default function InvoicePreviewPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { toast } = useToast()
  const { data, isLoading, isError } = useInvoice(params?.id)
  const send = useSendInvoice()
  const [publicUrl, setPublicUrl] = useState<string | null>(null)

  const payload = useMemo(() => (data?.data ? toPayload(data.data) : null), [data])
  const inv = data?.data

  const onSend = async () => {
    if (!inv) return
    try {
      const res = await send.mutateAsync(inv.id)
      setPublicUrl(res.meta.public_url)
      toast({ title: `Invoice ${inv.invoice_number} sent`, description: res.meta.public_url })
    } catch (err) {
      toast({
        title: 'Could not send',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const onCopyLink = async () => {
    const url = publicUrl
    if (!url) return toast({ title: 'Send the invoice first to generate its public link' })
    await navigator.clipboard.writeText(url)
    toast({ title: 'Public link copied' })
  }

  return (
    <div style={{ minHeight: '100vh', background: '#01010D', padding: '0 0 64px' }}>
      {/* Slim action bar */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '14px 24px',
          background: 'rgba(1,1,13,0.9)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <InvoBtn kind="outline" height={40} onClick={() => router.push('/invoicing/invoices')}>
          ← Close
        </InvoBtn>
        <div style={{ display: 'flex', gap: 8 }}>
          {inv?.status === 'DRAFT' && (
            <InvoBtn kind="secondary" height={40} onClick={() => router.push(`/invoicing/${inv.id}/edit`)}>
              Edit
            </InvoBtn>
          )}
          <InvoBtn kind="secondary" height={40} onClick={onCopyLink}>
            Copy link
          </InvoBtn>
          <InvoBtn kind="secondary" height={40} disabled title="PDF arrives in Sprint 6">
            Download PDF
          </InvoBtn>
          {inv && !['PAID', 'CANCELLED', 'VOIDED', 'WRITE_OFF'].includes(inv.status) && (
            <InvoBtn kind="primary" height={40} onClick={onSend} disabled={send.isPending}>
              {send.isPending ? 'Sending…' : inv.status === 'DRAFT' ? 'Send' : 'Resend'}
            </InvoBtn>
          )}
        </div>
      </div>

      <div style={{ padding: '40px 24px' }}>
        {isLoading && <div style={{ textAlign: 'center', color: INVO.muted40, fontWeight: 600 }}>Loading preview…</div>}
        {isError && (
          <div style={{ textAlign: 'center', color: INVO.coral, fontWeight: 600 }}>
            Couldn’t load this invoice. Check you’re signed in.
          </div>
        )}
        {payload && <InvoiceRenderer payload={payload} />}
      </div>
    </div>
  )
}
