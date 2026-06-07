'use client'

import { useEffect, useState } from 'react'
import { Btn } from '@/components/proto'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  useSaveItem,
  useHsnSacSearch,
  type Item,
  type ItemInput,
} from '@/lib/api/queries/use-invoicing'

const FIELD: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 9,
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 14,
}
const LABEL: React.CSSProperties = { display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 5 }

export function ItemModal({
  open,
  onOpenChange,
  item,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  item?: Item | null
}) {
  const { toast } = useToast()
  const save = useSaveItem()
  const [form, setForm] = useState<ItemInput>({ name: '', default_rate: '' })
  const [hsnQuery, setHsnQuery] = useState('')
  const { data: hsnResults } = useHsnSacSearch(hsnQuery)

  useEffect(() => {
    if (open) {
      setHsnQuery('')
      setForm(
        item
          ? {
              name: item.name,
              default_rate: item.default_rate,
              unit: item.unit ?? 'units',
              hsn_sac_code: item.hsn_sac_code ?? '',
              default_gst_rate: item.default_gst_rate ?? '18',
              currency: item.currency ?? 'INR',
              description: item.description ?? '',
            }
          : { name: '', default_rate: '', unit: 'units', default_gst_rate: '18', currency: 'INR' },
      )
    }
  }, [open, item])

  const set =
    (k: keyof ItemInput) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const onSubmit = async () => {
    if (!form.name.trim() || !form.default_rate) {
      toast({ title: 'Name and rate are required', variant: 'destructive' })
      return
    }
    try {
      await save.mutateAsync({ id: item?.id, ...form })
      toast({ title: item ? 'Item updated' : 'Item created' })
      onOpenChange(false)
    } catch (err) {
      toast({
        title: 'Could not save item',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{item ? 'Edit item' : 'New item'}</DialogTitle>
        </DialogHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, padding: '4px 0' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Name *</label>
            <input style={FIELD} value={form.name} onChange={set('name')} placeholder="Consulting hour" />
          </div>
          <div>
            <label style={LABEL}>Default rate *</label>
            <input style={FIELD} value={form.default_rate} onChange={set('default_rate')} placeholder="2500.00" inputMode="decimal" />
          </div>
          <div>
            <label style={LABEL}>Unit</label>
            <input style={FIELD} value={form.unit ?? ''} onChange={set('unit')} placeholder="units" />
          </div>
          <div>
            <label style={LABEL}>GST rate %</label>
            <input style={FIELD} value={form.default_gst_rate ?? ''} onChange={set('default_gst_rate')} placeholder="18" inputMode="decimal" />
          </div>
          <div>
            <label style={LABEL}>Currency</label>
            <select style={FIELD} value={form.currency ?? 'INR'} onChange={set('currency')}>
              {['INR', 'USD', 'EUR', 'GBP'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1', position: 'relative' }}>
            <label style={LABEL}>HSN / SAC code</label>
            <input
              style={FIELD}
              value={form.hsn_sac_code ?? ''}
              onChange={(e) => {
                setForm((f) => ({ ...f, hsn_sac_code: e.target.value }))
                setHsnQuery(e.target.value)
              }}
              placeholder="Search code or description…"
            />
            {hsnQuery.length >= 2 && (hsnResults?.data?.length ?? 0) > 0 && (
              <div
                className="glass"
                style={{
                  position: 'absolute',
                  zIndex: 20,
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: 4,
                  borderRadius: 9,
                  maxHeight: 200,
                  overflowY: 'auto',
                  border: '1px solid var(--line)',
                }}
              >
                {hsnResults!.data.slice(0, 8).map((r) => (
                  <button
                    key={`${r.source}-${r.code}`}
                    type="button"
                    onClick={() => {
                      setForm((f) => ({
                        ...f,
                        hsn_sac_code: r.code,
                        default_gst_rate: r.default_gst_rate ?? f.default_gst_rate,
                      }))
                      setHsnQuery('')
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 11px',
                      fontSize: 13,
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text)',
                      cursor: 'pointer',
                    }}
                  >
                    <strong>{r.code}</strong>{' '}
                    <span style={{ color: 'var(--muted)' }}>· {r.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Description</label>
            <textarea style={{ ...FIELD, minHeight: 60, resize: 'vertical' }} value={form.description ?? ''} onChange={set('description')} />
          </div>
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={onSubmit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : item ? 'Save changes' : 'Create item'}
          </Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
