'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { useInvoices, useInvoiceAction, type InvoiceRow } from '@/lib/api/queries/use-invoicing'
import type { PillTone } from '@/components/proto/Pill'

const CELL: React.CSSProperties = { padding: '12px 14px', fontSize: 14, textAlign: 'left' }
const HEAD: React.CSSProperties = { ...CELL, fontSize: 12, color: 'var(--muted)', fontWeight: 600 }

const STATUS_TONE: Record<string, PillTone> = {
  DRAFT: '',
  SENT: 'blue',
  VIEWED: 'blue',
  PARTIALLY_PAID: 'yellow',
  OVERDUE: 'coral',
  PAID: 'green',
  CANCELLED: '',
  VOIDED: '',
  WRITE_OFF: 'coral',
  DISPUTED: 'coral',
  REFUNDED: 'purple',
}

const FILTERS = ['ALL', 'DRAFT', 'SENT', 'OVERDUE', 'PAID', 'CANCELLED'] as const

export default function InvoicesPage() {
  const { toast } = useToast()
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const { data, isLoading, isError } = useInvoices({
    q: q || undefined,
    status: statusFilter === 'ALL' ? undefined : statusFilter,
  })
  const action = useInvoiceAction()
  const rows = data?.data ?? []

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
    <div style={{ padding: '28px 32px', maxWidth: 1150, margin: '0 auto' }}>
      <SectionHead
        eyebrow="Invoicing"
        title="Invoices"
        sub="GST-compliant invoices with live status tracking."
        right={
          <Link href="/invoicing/new">
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />}>
              New invoice
            </Btn>
          </Link>
        }
      />

      <div style={{ display: 'flex', gap: 10, margin: '6px 0 16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 240, maxWidth: 340 }}>
          <span style={{ position: 'absolute', left: 11, top: 9, color: 'var(--muted)' }}>
            <Icon.search size={15} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search number or customer"
            style={{
              width: '100%',
              padding: '9px 11px 9px 32px',
              borderRadius: 9,
              border: '1px solid var(--line)',
              background: 'var(--surface)',
              color: 'var(--text)',
              fontSize: 14,
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatusFilter(f)}
              style={{
                padding: '6px 11px',
                borderRadius: 8,
                border: '1px solid var(--line)',
                background: statusFilter === f ? 'var(--blue)' : 'var(--surface)',
                color: statusFilter === f ? '#fff' : 'var(--muted)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {f.charAt(0) + f.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="glass" style={{ borderRadius: 14, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)' }}>
              <th style={HEAD}>Number</th>
              <th style={HEAD}>Customer</th>
              <th style={HEAD}>Date</th>
              <th style={HEAD}>Due</th>
              <th style={{ ...HEAD, textAlign: 'right' }}>Total</th>
              <th style={{ ...HEAD, textAlign: 'right' }}>Net receivable</th>
              <th style={HEAD}>Status</th>
              <th style={HEAD}></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td style={CELL} colSpan={8}>
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td style={{ ...CELL, color: 'var(--coral, #ff6b6b)' }} colSpan={8}>
                  Couldn’t load invoices. Check you’re signed in.
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td style={{ ...CELL, color: 'var(--muted)' }} colSpan={8}>
                  No invoices {statusFilter !== 'ALL' ? `in ${statusFilter}` : 'yet'} — create your first one.
                </td>
              </tr>
            )}
            {rows.map((inv) => (
              <tr key={inv.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ ...CELL, fontFamily: 'var(--mono, monospace)' }}>
                  {inv.status === 'DRAFT' ? (
                    <Link href={`/invoicing/${inv.id}/edit`} style={{ color: 'var(--blue)' }}>
                      {inv.invoice_number}
                    </Link>
                  ) : (
                    inv.invoice_number
                  )}
                </td>
                <td style={CELL}>{inv.customer_name ?? '—'}</td>
                <td style={{ ...CELL, color: 'var(--muted)' }}>{inv.invoice_date}</td>
                <td style={{ ...CELL, color: 'var(--muted)' }}>{inv.due_date}</td>
                <td style={{ ...CELL, textAlign: 'right', fontFamily: 'var(--mono, monospace)' }}>
                  {inv.currency} {inv.total_amount}
                </td>
                <td style={{ ...CELL, textAlign: 'right', fontFamily: 'var(--mono, monospace)' }}>
                  {inv.net_receivable != null ? `${inv.currency} ${inv.net_receivable}` : '—'}
                </td>
                <td style={CELL}>
                  <Pill tone={STATUS_TONE[inv.status] ?? ''}>{inv.status.replace(/_/g, ' ').toLowerCase()}</Pill>
                </td>
                <td style={{ ...CELL, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {inv.status === 'DRAFT' && (
                    <Link href={`/invoicing/${inv.id}/edit`}>
                      <Btn kind="ghost" size="sm" icon={<Icon.edit size={13} />} />
                    </Link>
                  )}
                  <Btn
                    kind="ghost"
                    size="sm"
                    icon={<Icon.copy size={13} />}
                    onClick={() => onDuplicate(inv)}
                    title="Duplicate"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
