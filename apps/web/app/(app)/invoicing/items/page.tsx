'use client'

import { useState } from 'react'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { ItemModal } from '@/components/invoicing/ItemModal'
import { useToast } from '@/components/ui/use-toast'
import { useItems, useArchiveItem, type Item } from '@/lib/api/queries/use-invoicing'

const CELL: React.CSSProperties = { padding: '12px 14px', fontSize: 14, textAlign: 'left' }
const HEAD: React.CSSProperties = { ...CELL, fontSize: 12, color: 'var(--muted)', fontWeight: 600 }

export default function ItemsPage() {
  const { toast } = useToast()
  const [q, setQ] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Item | null>(null)
  const { data, isLoading, isError } = useItems({ q })
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
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <SectionHead
        eyebrow="Invoicing"
        title="Items"
        sub="Reusable line items with HSN/SAC and default tax."
        right={
          <Btn
            kind="primary"
            size="sm"
            icon={<Icon.plus size={13} />}
            onClick={() => {
              setEditing(null)
              setModalOpen(true)
            }}
          >
            New item
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
            placeholder="Search by name, code or HSN/SAC"
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
              <th style={HEAD}>HSN/SAC</th>
              <th style={{ ...HEAD, textAlign: 'right' }}>Rate</th>
              <th style={{ ...HEAD, textAlign: 'right' }}>GST %</th>
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
                  Couldn’t load items. Check you’re signed in.
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td style={{ ...CELL, color: 'var(--muted)' }} colSpan={7}>
                  No items yet — add your first one.
                </td>
              </tr>
            )}
            {rows.map((i) => (
              <tr key={i.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ ...CELL, fontFamily: 'var(--mono, monospace)' }}>{i.item_code}</td>
                <td style={CELL}>{i.name}</td>
                <td style={{ ...CELL, color: 'var(--muted)' }}>{i.hsn_sac_code ?? '—'}</td>
                <td style={{ ...CELL, textAlign: 'right' }}>
                  {i.currency} {i.default_rate}
                </td>
                <td style={{ ...CELL, textAlign: 'right' }}>{i.default_gst_rate ?? '—'}</td>
                <td style={CELL}>
                  <Pill tone={i.status === 'archived' ? '' : 'green'}>{i.status}</Pill>
                </td>
                <td style={{ ...CELL, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Btn
                    kind="ghost"
                    size="sm"
                    icon={<Icon.edit size={13} />}
                    onClick={() => {
                      setEditing(i)
                      setModalOpen(true)
                    }}
                  />
                  <Btn kind="ghost" size="sm" icon={<Icon.trash size={13} />} onClick={() => onArchive(i)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ItemModal open={modalOpen} onOpenChange={setModalOpen} item={editing} />
    </div>
  )
}
