'use client'

import { useState } from 'react'
import { useToast } from '@/components/ui/use-toast'
import { CustomerModal } from '@/components/invoicing/CustomerModal'
import { useCustomers, useArchiveCustomer, type Customer } from '@/lib/api/queries/use-invoicing'
import {
  INVO,
  InvoPage,
  InvoTitle,
  InvoBtn,
  InvoTable,
  InvoRow,
  InvoAvatar,
  InvoSearch,
  StatusChip,
  InvoIcons,
  invoTh,
  invoTd,
} from '@/components/invoicing/invo'

export default function CustomersPage() {
  const { toast } = useToast()
  const [q, setQ] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const { data, isLoading, isError } = useCustomers({ q: q || undefined })
  const archive = useArchiveCustomer()

  const rows = data?.data ?? []

  const onArchive = async (c: Customer) => {
    const archived = c.status !== 'archived'
    try {
      await archive.mutateAsync({ id: c.id, archived })
      toast({ title: archived ? 'Customer archived' : 'Customer restored' })
    } catch {
      toast({ title: 'Action failed', variant: 'destructive' })
    }
  }

  return (
    <InvoPage glow="green">
      <InvoTitle
        icon={InvoIcons.clients}
        right={
          <>
            <InvoSearch value={q} onChange={setQ} placeholder="Search clients..." />
            <InvoBtn
              kind="primary"
              height={44}
              icon={InvoIcons.plusSmall}
              onClick={() => {
                setEditing(null)
                setModalOpen(true)
              }}
            >
              Add client
            </InvoBtn>
          </>
        }
      >
        Clients
      </InvoTitle>

      <InvoTable
        head={
          <>
            <th style={invoTh}>Client</th>
            <th style={invoTh}>Email</th>
            <th style={invoTh}>GSTIN</th>
            <th style={invoTh}>Currency</th>
            <th style={invoTh}>Status</th>
            <th style={invoTh}>Action</th>
          </>
        }
      >
        {isLoading && (
          <tr>
            <td style={{ ...invoTd, color: INVO.muted40 }} colSpan={6}>
              Loading…
            </td>
          </tr>
        )}
        {isError && (
          <tr>
            <td style={{ ...invoTd, color: INVO.coral }} colSpan={6}>
              Couldn’t load clients. Check you’re signed in.
            </td>
          </tr>
        )}
        {rows.map((c, i) => (
          <InvoRow key={c.id} index={i}>
            <td style={invoTd}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <InvoAvatar name={c.display_name} />
                {c.display_name}
              </div>
            </td>
            <td style={{ ...invoTd, color: INVO.muted50, fontSize: 13 }}>{c.email ?? '—'}</td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{c.gstin ?? '—'}</td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{c.default_currency}</td>
            <td style={invoTd}>
              <StatusChip status={c.status} />
            </td>
            <td style={invoTd}>
              <div style={{ display: 'flex', gap: 8 }}>
                <InvoBtn
                  kind="chip-blue"
                  onClick={() => {
                    setEditing(c)
                    setModalOpen(true)
                  }}
                >
                  Edit
                </InvoBtn>
                <InvoBtn kind="chip-outline" onClick={() => onArchive(c)}>
                  {c.status === 'archived' ? 'Restore' : 'Archive'}
                </InvoBtn>
              </div>
            </td>
          </InvoRow>
        ))}
      </InvoTable>

      {!isLoading && !isError && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: INVO.muted30, fontWeight: 600, fontSize: 16, letterSpacing: '-0.02em' }}>
          No clients found
        </div>
      )}

      <CustomerModal open={modalOpen} onOpenChange={setModalOpen} customer={editing} />
    </InvoPage>
  )
}
