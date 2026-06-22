'use client'

import { useState } from 'react'
import { useToast } from '@/components/ui/use-toast'
import { ItemModal } from '@/components/invoicing/ItemModal'
import { useItems, useArchiveItem, type Item } from '@/lib/api/queries/use-invoicing'
import {
  INVO,
  InvoPage,
  InvoTitle,
  InvoBtn,
  InvoTable,
  InvoRow,
  InvoSearch,
  StatusChip,
  InvoIcons,
  invoTh,
  invoTd,
} from '@/components/invoicing/invo'

const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)

export default function ItemsPage() {
  const { toast } = useToast()
  const [q, setQ] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Item | null>(null)
  const { data, isLoading, isError } = useItems({ q: q || undefined })
  const archive = useArchiveItem()

  const rows = data?.data ?? []

  const onArchive = async (i: Item) => {
    const archived = i.status !== 'archived'
    try {
      await archive.mutateAsync({ id: i.id, archived })
      toast({ title: archived ? 'Item archived' : 'Item restored' })
    } catch {
      toast({ title: 'Action failed', variant: 'destructive' })
    }
  }

  return (
    <InvoPage>
      <InvoTitle
        icon={InvoIcons.drafts}
        right={
          <>
            <InvoSearch value={q} onChange={setQ} placeholder="Search items..." />
            <InvoBtn
              kind="primary"
              height={44}
              icon={InvoIcons.plusSmall}
              onClick={() => {
                setEditing(null)
                setModalOpen(true)
              }}
            >
              Add item
            </InvoBtn>
          </>
        }
      >
        Items
      </InvoTitle>

      <InvoTable
        head={
          <>
            <th style={invoTh}>Item</th>
            <th style={invoTh}>HSN/SAC</th>
            <th style={invoTh}>Rate</th>
            <th style={invoTh}>Tax %</th>
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
              Couldn’t load items. Check you’re signed in.
            </td>
          </tr>
        )}
        {rows.map((it, i) => (
          <InvoRow key={it.id} index={i}>
            <td style={invoTd}>
              <div>
                {it.name}
                {it.description && (
                  <div style={{ fontWeight: 600, fontSize: 12, color: INVO.muted40, marginTop: 2 }}>{it.description}</div>
                )}
              </div>
            </td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{it.hsn_sac_code ?? '—'}</td>
            <td style={invoTd}>
              {symbol(it.currency)}
              {parseFloat(it.default_rate).toLocaleString('en-IN')}
              <span style={{ color: INVO.muted40, fontSize: 12 }}> / {it.unit}</span>
            </td>
            <td style={{ ...invoTd, color: INVO.muted60 }}>{it.default_gst_rate ?? '—'}</td>
            <td style={invoTd}>
              <StatusChip status={it.status} />
            </td>
            <td style={invoTd}>
              <div style={{ display: 'flex', gap: 8 }}>
                <InvoBtn
                  kind="chip-blue"
                  onClick={() => {
                    setEditing(it)
                    setModalOpen(true)
                  }}
                >
                  Edit
                </InvoBtn>
                <InvoBtn kind="chip-outline" onClick={() => onArchive(it)}>
                  {it.status === 'archived' ? 'Restore' : 'Archive'}
                </InvoBtn>
              </div>
            </td>
          </InvoRow>
        ))}
      </InvoTable>

      {!isLoading && !isError && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: INVO.muted30, fontWeight: 600, fontSize: 16, letterSpacing: '-0.02em' }}>
          No items found
        </div>
      )}

      <ItemModal open={modalOpen} onOpenChange={setModalOpen} item={editing} />
    </InvoPage>
  )
}
