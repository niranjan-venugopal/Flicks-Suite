'use client'

import { InvoiceEditor } from '@/components/invoicing/InvoiceEditor'
import { useInvoicingAccess } from '@/lib/api/queries/use-members'

export default function NewInvoicePage() {
  const { canEdit, isLoading } = useInvoicingAccess()
  if (isLoading) return <div style={{ padding: 32, color: 'var(--text-mute)' }}>Loading…</div>
  if (!canEdit)
    return (
      <div style={{ padding: 32, color: 'var(--text-mute)' }}>
        You have view-only access to Invoicing — creating invoices isn’t permitted for your role.
      </div>
    )
  return <InvoiceEditor />
}
