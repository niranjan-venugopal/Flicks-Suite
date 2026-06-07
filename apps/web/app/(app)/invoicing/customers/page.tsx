'use client'

import { useState } from 'react'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { CustomerModal } from '@/components/invoicing/CustomerModal'
import { useToast } from '@/components/ui/use-toast'
import {
  useCustomers,
  useArchiveCustomer,
  type Customer,
} from '@/lib/api/queries/use-invoicing'

const CELL: React.CSSProperties = { padding: '12px 14px', fontSize: 14, textAlign: 'left' }
const HEAD: React.CSSProperties = { ...CELL, fontSize: 12, color: 'var(--muted)', fontWeight: 600 }

export default function CustomersPage() {
  const { toast } = useToast()
  const [q, setQ] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const { data, isLoading, isError } = useCustomers({ q })
  const archive = useArchiveCustomer()

  const rows = data?.data ?? []

  const onNew = () => {
    setEditing(null)
    setModalOpen(true)
  }
  const onEdit = (c: Customer) => {
    setEditing(c)
    setModalOpen(true)
  }
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
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <SectionHead
        eyebrow="Invoicing"
        title="Customers"
        sub="Your customer ledger, contacts and tax details."
        right={
          <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={onNew}>
            New customer
          </Btn>
        }
      />

      <div style={{ display: 'flex', gap: 10, margin: '6px 0 16px' }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <span style={{ position: 'absolute', left: 11, top: 9, color: 'var(--muted)' }}>
            <Icon.search size={15} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, code or email"
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
      </div>

      <div className="glass" style={{ borderRadius: 14, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)' }}>
              <th style={HEAD}>Code</th>
              <th style={HEAD}>Name</th>
              <th style={HEAD}>Email</th>
              <th style={HEAD}>GSTIN</th>
              <th style={HEAD}>Currency</th>
              <th style={HEAD}>Status</th>
              <th style={HEAD}></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td style={CELL} colSpan={7}>
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td style={{ ...CELL, color: 'var(--coral, #ff6b6b)' }} colSpan={7}>
                  Couldn’t load customers. Check you’re signed in.
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td style={{ ...CELL, color: 'var(--muted)' }} colSpan={7}>
                  No customers yet — create your first one.
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ ...CELL, fontFamily: 'var(--mono, monospace)' }}>{c.customer_code}</td>
                <td style={CELL}>{c.display_name}</td>
                <td style={{ ...CELL, color: 'var(--muted)' }}>{c.email ?? '—'}</td>
                <td style={{ ...CELL, color: 'var(--muted)' }}>{c.gstin ?? '—'}</td>
                <td style={CELL}>{c.default_currency}</td>
                <td style={CELL}>
                  <Pill tone={c.status === 'archived' ? '' : 'green'}>{c.status}</Pill>
                </td>
                <td style={{ ...CELL, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Btn kind="ghost" size="sm" icon={<Icon.edit size={13} />} onClick={() => onEdit(c)} />
                  <Btn
                    kind="ghost"
                    size="sm"
                    icon={<Icon.trash size={13} />}
                    onClick={() => onArchive(c)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CustomerModal open={modalOpen} onOpenChange={setModalOpen} customer={editing} />
    </div>
  )
}
