'use client'

import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import { useInvoices, useInvoiceAction } from '@/lib/api/queries/use-invoicing'
import { useInvoicingAccess } from '@/lib/api/queries/use-members'
import {
  INVO,
  InvoPage,
  InvoTitle,
  InvoBtn,
  InvoTable,
  InvoRow,
  StatusChip,
  InvoIcons,
  invoTh,
  invoTd,
} from '@/components/invoicing/invo'

const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)
const fmt = (amount: string, currency: string) => {
  const n = parseFloat(amount)
  return `${symbol(currency)}${Number.isFinite(n) ? n.toLocaleString('en-IN') : amount}`
}
const dateFmt = (d: string) => (d ? new Date(d).toLocaleDateString('en-IN') : '—')

export default function QuotesPage() {
  const router = useRouter()
  const { toast } = useToast()
  const access = useInvoicingAccess()
  const { data, isLoading, isError } = useInvoices({ document_type: 'QUOTE' })
  const action = useInvoiceAction()
  const rows = data?.data ?? []

  const onConvert = async (id: string) => {
    try {
      const res = await action.mutateAsync({ id, action: 'convert-to-invoice' })
      toast({ title: `Converted to invoice ${res.data.invoice_number}`, description: 'Opened as a draft invoice.' })
      router.push(`/invoicing/${res.data.id}/edit`)
    } catch (err) {
      toast({ title: 'Could not convert', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <InvoPage>
      <InvoTitle
        icon={InvoIcons.invoices}
        right={
          access.canEdit ? (
            <InvoBtn kind="primary" icon={InvoIcons.plus} onClick={() => router.push('/invoicing/new?type=quote')}>
              New quote
            </InvoBtn>
          ) : null
        }
      >
        Quotes / Estimates
      </InvoTitle>

      <InvoTable
        head={
          <>
            <th style={invoTh}>Quote ID</th>
            <th style={invoTh}>Client</th>
            <th style={invoTh}>Date</th>
            <th style={invoTh}>Valid until</th>
            <th style={invoTh}>Amount</th>
            <th style={invoTh}>Status</th>
            <th style={invoTh}>Action</th>
          </>
        }
      >
        {isLoading && (
          <tr><td style={{ ...invoTd, color: INVO.muted40 }} colSpan={7}>Loading…</td></tr>
        )}
        {isError && (
          <tr><td style={{ ...invoTd, color: INVO.coral }} colSpan={7}>Couldn’t load quotes.</td></tr>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <tr>
            <td style={{ ...invoTd, color: INVO.muted30 }} colSpan={7}>
              No quotes yet{access.canEdit ? ' — create one to send an estimate before invoicing.' : '.'}
            </td>
          </tr>
        )}
        {rows.map((q, i) => (
          <InvoRow key={q.id} index={i}>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{q.invoice_number}</td>
            <td style={invoTd}>{q.customer_name ?? '—'}</td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{dateFmt(q.invoice_date)}</td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{dateFmt(q.due_date)}</td>
            <td style={invoTd}>{fmt(q.total_amount, q.currency)}</td>
            <td style={invoTd}><StatusChip status={q.status} /></td>
            <td style={invoTd}>
              <div style={{ display: 'flex', gap: 8 }}>
                {q.status === 'DRAFT' && access.canEdit && (
                  <InvoBtn kind="chip-blue" onClick={() => router.push(`/invoicing/${q.id}/edit`)}>Edit</InvoBtn>
                )}
                <InvoBtn kind="chip-blue" onClick={() => router.push(`/invoicing/${q.id}/preview`)}>View</InvoBtn>
                {access.canEdit && !['CANCELLED', 'VOIDED'].includes(q.status) && (
                  <InvoBtn kind="chip-outline" onClick={() => onConvert(q.id)}>Convert to invoice</InvoBtn>
                )}
              </div>
            </td>
          </InvoRow>
        ))}
      </InvoTable>
    </InvoPage>
  )
}
