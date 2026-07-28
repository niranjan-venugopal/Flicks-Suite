'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import {
  useInvoices,
  useInvoiceAction,
  useSendInvoice,
  useDownloadInvoicePdf,
  useRecordPayment,
  type InvoiceRow,
} from '@/lib/api/queries/use-invoicing'
import { useInvoicingAccess } from '@/lib/api/queries/use-members'
import { Sk } from '@/components/states'
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


// Aging escalation (catalog): the due-date cell escalates with days past due.
function dueTone(inv: { status: string; due_date: string }): { color: string; label?: string } {
  if (['PAID', 'VOID', 'DRAFT'].includes(inv.status)) return { color: INVO.muted60 }
  const days = Math.floor((Date.now() - new Date(`${inv.due_date}T00:00:00`).getTime()) / 86_400_000)
  if (days < 0) return { color: INVO.muted60 }
  if (days === 0) return { color: 'var(--blue)', label: 'due today' }
  if (days <= 7) return { color: 'var(--yellow)', label: `overdue · ${days}d` }
  return { color: 'var(--coral)', label: `overdue · ${days}d` }
}

export default function InvoicesPage() {
  const router = useRouter()
  const { toast } = useToast()
  const access = useInvoicingAccess()
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const { data, isLoading, isError } = useInvoices({
    q: q || undefined,
    status: tab === 'all' ? undefined : tab,
    document_type: 'INVOICE',
  })
  const { data: draftsData } = useInvoices({ status: 'DRAFT', document_type: 'INVOICE' })
  const action = useInvoiceAction()
  const send = useSendInvoice()
  const downloadPdf = useDownloadInvoicePdf()
  const record = useRecordPayment()
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [markingId, setMarkingId] = useState<string | null>(null)

  const rows = data?.data ?? []
  const drafts = (draftsData?.data ?? []).slice(0, 3)

  const onSend = async (inv: InvoiceRow) => {
    try {
      const res = await send.mutateAsync(inv.id)
      toast({ title: `Invoice ${inv.invoice_number} sent`, description: res.meta.public_url })
    } catch (err) {
      toast({
        title: 'Could not send',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const onDownloadPdf = async (inv: InvoiceRow) => {
    setDownloadingId(inv.id)
    try {
      await downloadPdf.mutateAsync({ id: inv.id, invoiceNumber: inv.invoice_number })
    } catch (err) {
      toast({
        title: 'Could not download PDF',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setDownloadingId(null)
    }
  }

  const onMarkPaid = async (inv: InvoiceRow) => {
    const amount = inv.amount_outstanding ?? inv.total_amount
    if (!window.confirm(`Mark ${inv.invoice_number} as paid? This records ${fmt(amount, inv.currency)} as received.`)) {
      return
    }
    setMarkingId(inv.id)
    try {
      const res = await record.mutateAsync({
        id: inv.id,
        amount,
        payment_method: 'OTHER',
        payment_date: new Date().toISOString().slice(0, 10),
      })
      toast({ title: `Invoice ${inv.invoice_number} marked as paid`, description: `Status: ${res.meta.invoice_status}` })
    } catch (err) {
      toast({
        title: 'Could not mark as paid',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setMarkingId(null)
    }
  }

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
            {access.canEdit && (
              <InvoBtn kind="primary" icon={InvoIcons.plus} onClick={() => router.push('/invoicing/new')}>
                Create invoice
              </InvoBtn>
            )}
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
        {isLoading &&
          [0, 1, 2, 3, 4].map((r) => (
            <tr key={`sk-${r}`}>
              <td style={invoTd} colSpan={7}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Sk w={92} h={10} />
                  <Sk w="30%" h={10} />
                  <span style={{ flex: 1 }} />
                  <Sk w={70} h={10} />
                  <Sk w={54} h={18} r={99} />
                </div>
              </td>
            </tr>
          ))}
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
          <InvoRow key={inv.id} index={i} onClick={() => router.push(`/invoicing/${inv.id}/preview`)}>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{inv.invoice_number}</td>
            <td style={invoTd}>{inv.customer_name ?? '—'}</td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{dateFmt(inv.invoice_date)}</td>
            <td style={{ ...invoTd, color: dueTone(inv).color }}>
              {dateFmt(inv.due_date)}
              {dueTone(inv).label && (
                <span style={{ display: 'block', fontSize: 9.5, fontWeight: 800 }}>{dueTone(inv).label}</span>
              )}
            </td>
            <td style={invoTd}>{fmt(inv.total_amount, inv.currency)}</td>
            <td style={invoTd}>
              <StatusChip status={inv.status} />
            </td>
            {/* Actions: stop row-click navigation when a button is pressed */}
            <td style={invoTd} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', gap: 8 }}>
                {inv.status === 'DRAFT' && access.canEdit && (
                  <InvoBtn kind="chip-blue" onClick={() => router.push(`/invoicing/${inv.id}/edit`)}>
                    Edit
                  </InvoBtn>
                )}
                {inv.status === 'DRAFT' && access.canSend && (
                  <InvoBtn kind="chip-blue" onClick={() => onSend(inv)}>
                    Send
                  </InvoBtn>
                )}
                <InvoBtn
                  kind="chip-outline"
                  disabled={downloadingId === inv.id}
                  title="Download a PDF of the hosted invoice"
                  onClick={() => onDownloadPdf(inv)}
                >
                  {downloadingId === inv.id ? 'Preparing…' : 'PDF'}
                </InvoBtn>
                {access.canRecordPayments &&
                  ['SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID'].includes(inv.status) && (
                    <InvoBtn
                      kind="chip-blue"
                      disabled={markingId === inv.id}
                      onClick={() => onMarkPaid(inv)}
                    >
                      {markingId === inv.id ? 'Marking…' : 'Mark as paid'}
                    </InvoBtn>
                  )}
                {access.canEdit && (
                  <InvoBtn kind="chip-outline" onClick={() => onDuplicate(inv)}>
                    Duplicate
                  </InvoBtn>
                )}
              </div>
            </td>
          </InvoRow>
        ))}
      </InvoTable>
    </InvoPage>
  )
}
