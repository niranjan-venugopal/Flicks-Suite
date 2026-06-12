'use client'

import { useParams } from 'next/navigation'
import { InvoiceEditor } from '@/components/invoicing/InvoiceEditor'
import { useInvoice } from '@/lib/api/queries/use-invoicing'

export default function EditInvoicePage() {
  const params = useParams<{ id: string }>()
  const { data, isLoading, isError } = useInvoice(params?.id)

  if (isLoading) return <div style={{ padding: 32, color: 'var(--muted)' }}>Loading invoice…</div>
  if (isError || !data?.data)
    return <div style={{ padding: 32, color: 'var(--coral, #ff6b6b)' }}>Couldn’t load this invoice.</div>
  if (data.data.status !== 'DRAFT')
    return (
      <div style={{ padding: 32, color: 'var(--muted)' }}>
        Only DRAFT invoices can be edited — {data.data.invoice_number} is {data.data.status}.
      </div>
    )
  return <InvoiceEditor invoice={data.data} />
}
