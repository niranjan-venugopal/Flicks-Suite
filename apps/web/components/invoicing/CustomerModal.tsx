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
  useSaveCustomer,
  type Customer,
  type CustomerInput,
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
const LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--muted)',
  marginBottom: 5,
}

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP']

export function CustomerModal({
  open,
  onOpenChange,
  customer,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  customer?: Customer | null
}) {
  const { toast } = useToast()
  const save = useSaveCustomer()
  const [form, setForm] = useState<CustomerInput>({ display_name: '' })

  useEffect(() => {
    if (open) {
      setForm(
        customer
          ? {
              display_name: customer.display_name,
              legal_name: customer.legal_name ?? '',
              email: customer.email ?? '',
              phone: customer.phone ?? '',
              gstin: customer.gstin ?? '',
              state_code: customer.state_code ?? '',
              default_currency: customer.default_currency ?? 'INR',
            }
          : { display_name: '', default_currency: 'INR' },
      )
    }
  }, [open, customer])

  const set = (k: keyof CustomerInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const onSubmit = async () => {
    if (!form.display_name.trim()) {
      toast({ title: 'Display name is required', variant: 'destructive' })
      return
    }
    try {
      await save.mutateAsync({ id: customer?.id, ...form })
      toast({ title: customer ? 'Customer updated' : 'Customer created' })
      onOpenChange(false)
    } catch (err) {
      toast({
        title: 'Could not save customer',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{customer ? 'Edit customer' : 'New customer'}</DialogTitle>
        </DialogHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, padding: '4px 0' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Display name *</label>
            <input style={FIELD} value={form.display_name} onChange={set('display_name')} placeholder="Acme Corp" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Legal name</label>
            <input style={FIELD} value={form.legal_name ?? ''} onChange={set('legal_name')} />
          </div>
          <div>
            <label style={LABEL}>Email</label>
            <input style={FIELD} value={form.email ?? ''} onChange={set('email')} type="email" />
          </div>
          <div>
            <label style={LABEL}>Phone</label>
            <input style={FIELD} value={form.phone ?? ''} onChange={set('phone')} />
          </div>
          <div>
            <label style={LABEL}>GSTIN</label>
            <input style={FIELD} value={form.gstin ?? ''} onChange={set('gstin')} placeholder="29ABCDE1234F1Z5" />
          </div>
          <div>
            <label style={LABEL}>State code</label>
            <input style={FIELD} value={form.state_code ?? ''} onChange={set('state_code')} placeholder="KA" />
          </div>
          <div>
            <label style={LABEL}>Default currency</label>
            <select style={FIELD} value={form.default_currency ?? 'INR'} onChange={set('default_currency')}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={onSubmit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : customer ? 'Save changes' : 'Create customer'}
          </Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
