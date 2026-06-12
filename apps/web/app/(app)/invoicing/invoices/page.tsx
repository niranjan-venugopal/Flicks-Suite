'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import { useInvoices, useInvoiceAction, type InvoiceRow } from '@/lib/api/queries/use-invoicing'
import {
  INVO,
  InvoPage,
  InvoTitle,
  InvoBtn,
  InvoTable,
  InvoRow,
  InvoTabs,
  InvoAvatar,
  StatusChip,
  InvoIcons,
  invoTh,
  invoTd,
  InvoSearch,
} from '@/components/invoicing/invo'

/** Currency symbol like the prototype's ₹96,000 / $500 cards. */
const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)
const fmt = (amount: string, currency: string) => {
  const n = parseFloat(amount)
  return `${symbol(currency)}${Number.isFinite(n) ? n.toLocaleString('en-IN') : amount}`
}

/** Draft hero card — port of the prototype's DraftCard. */
function DraftCard({ inv, onOpen }: { inv: InvoiceRow; onOpen: () => void }) {
  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: 0,
        height: 200,
        borderRadius: 12,
        background: INVO.cardBgStrong,
        position: 'relative',
        overflow: 'hidden',
        padding: '22px 22px 20px',
      }}
    >
      <div style={{ position: 'absolute', top: 14, right: 14 }}>
        <InvoAvatar name={inv.customer_name ?? '??'} size={40} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 12, color: INVO.muted30, marginBottom: 8, letterSpacing: '-0.02em' }}>
        Amount
      </div>
      <div style={{ fontWeight: 700, fontSize: 32, color: '#fff', letterSpacing: '-0.04em', lineHeight: 1, marginBottom: 24 }}>
        {fmt(inv.total_amount, inv.currency)}
      </div>
      <div style={{ fontWeight: 700, fontSize: 11, color: INVO.muted40, marginBottom: 4, letterSpacing: '-0.01em' }}>
        Billed to
      </div>
      <div style={{ fontWeight: 700, fontSize: 16, color: '#fff', letterSpacing: '-0.02em' }}>
        {inv.customer_name ?? '—'}
      </div>
      <div
        onClick={onOpen}
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: 48,
          height: 48,
          background: 'rgba(255,255,255,0.06)',
          borderRadius: '20px 0 0 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        {InvoIcons.arrow}
      </div>
    </div>
  )
}

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'PAID', label: 'Paid' },
  { id: 'SENT', label: 'Pending' },
  { id: 'OVERDUE', label: 'Overdue' },
  { id: 'DRAFT', label: 'Drafts' },
]

const dateFmt = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export default function InvoicesPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const { data, isLoading, isError } = useInvoices({
    q: q || undefined,
    status: tab === 'all' ? undefined : tab,
  })
  const { data: draftsData } = useInvoices({ status: 'DRAFT' })
  const action = useInvoiceAction()

  const rows = data?.data ?? []
  const drafts = (draftsData?.data ?? []).slice(0, 3)

  const onDuplicate = async (inv: InvoiceRow) => {
    try {
      const res = await action.mutateAsync({ id: inv.id, action: 'duplicate' })
      toast({ title: `Duplicated as ${res.data.invoice_number}` })
    } catch (err) {
      toast({
        title: 'Could not duplicate',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <InvoPage>
      {/* Drafts hero row */}
      {drafts.length > 0 && (
        <>
          <InvoTitle icon={InvoIcons.drafts}>Invoice drafts</InvoTitle>
          <div style={{ display: 'flex', gap: 20, marginBottom: 40 }}>
            {drafts.map((d) => (
              <DraftCard key={d.id} inv={d} onOpen={() => router.push(`/invoicing/${d.id}/edit`)} />
            ))}
          </div>
        </>
      )}

      {/* Invoices header */}
      <InvoTitle
        icon={InvoIcons.invoices}
        right={
          <>
            <InvoSearch value={q} onChange={setQ} placeholder="Search invoices..." />
            <InvoBtn kind="primary" icon={InvoIcons.plus} onClick={() => router.push('/invoicing/new')}>
              Create invoice
            </InvoBtn>
          </>
        }
      >
        Invoices
      </InvoTitle>

      <InvoTabs tabs={TABS} active={tab} onChange={setTab} />

      <InvoTable
        head={
          <>
            <th style={invoTh}>Invoice ID</th>
            <th style={invoTh}>Client</th>
            <th style={invoTh}>Issue date</th>
            <th style={invoTh}>Due date</th>
            <th style={invoTh}>Amount</th>
            <th style={invoTh}>Status</th>
            <th style={invoTh}>Action</th>
          </>
        }
      >
        {isLoading && (
          <tr>
            <td style={{ ...invoTd, color: INVO.muted40 }} colSpan={7}>
              Loading…
            </td>
          </tr>
        )}
        {isError && (
          <tr>
            <td style={{ ...invoTd, color: INVO.coral }} colSpan={7}>
              Couldn’t load invoices. Check you’re signed in.
            </td>
          </tr>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <tr>
            <td style={{ ...invoTd, color: INVO.muted30 }} colSpan={7}>
              No invoices yet — create your first one.
            </td>
          </tr>
        )}
        {rows.map((inv, i) => (
          <InvoRow key={inv.id} index={i}>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{inv.invoice_number}</td>
            <td style={invoTd}>{inv.customer_name ?? '—'}</td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{dateFmt(inv.invoice_date)}</td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{dateFmt(inv.due_date)}</td>
            <td style={invoTd}>{fmt(inv.total_amount, inv.currency)}</td>
            <td style={invoTd}>
              <StatusChip status={inv.status} />
            </td>
            <td style={invoTd}>
              <div style={{ display: 'flex', gap: 8 }}>
                {inv.status === 'DRAFT' ? (
                  <InvoBtn kind="chip-blue" onClick={() => router.push(`/invoicing/${inv.id}/edit`)}>
                    Edit
                  </InvoBtn>
                ) : (
                  <InvoBtn kind="chip-blue" onClick={() => router.push(`/invoicing/${inv.id}/preview`)}>
                    View
                  </InvoBtn>
                )}
                <InvoBtn kind="chip-outline" onClick={() => onDuplicate(inv)}>
                  Duplicate
                </InvoBtn>
              </div>
            </td>
          </InvoRow>
        ))}
      </InvoTable>
    </InvoPage>
  )
}
