'use client'

import { useEffect, useState } from 'react'
import { InvoBtn, invoSelectReset } from '@/components/invoicing/invo'
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
import { IN_STATE_CODES } from '@/lib/countries'
import { stateName } from '@flicks/shared/constants'

const FIELD: React.CSSProperties = {
  width: '100%',
  height: 44,
  background: 'rgba(255,255,255,0.05)',
  border: '1.5px solid rgba(255,255,255,0.10)',
  borderRadius: 10,
  padding: '0 14px',
  fontWeight: 600,
  fontSize: 14,
  color: '#fff',
  outline: 'none',
  letterSpacing: '-0.02em',
}
const LABEL: React.CSSProperties = {
  display: 'block',
  fontWeight: 700,
  fontSize: 13,
  color: 'rgba(255,255,255,0.6)',
  marginBottom: 6,
  letterSpacing: '-0.02em',
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
            <label style={LABEL}>State</label>
            {/* Code-valued select — free text here used to silently break the
                CGST/SGST-vs-IGST derivation, which compares 2-letter codes. */}
            <select style={{ ...FIELD, ...invoSelectReset }} value={form.state_code ?? ''} onChange={set('state_code')}>
              <option value="">Select…</option>
              {IN_STATE_CODES.map((c) => (
                <option key={c} value={c}>
                  {stateName(c)}
                </option>
              ))}
              {/* Keep a legacy free-text value selectable so old customers stay editable */}
              {form.state_code && !(IN_STATE_CODES as readonly string[]).includes(form.state_code) && (
                <option value={form.state_code}>{stateName(form.state_code)}</option>
              )}
            </select>
          </div>
          <div>
            <label style={LABEL}>Default currency</label>
            <select style={{ ...FIELD, ...invoSelectReset }} value={form.default_currency ?? 'INR'} onChange={set('default_currency')}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <InvoBtn kind="outline" height={44} onClick={() => onOpenChange(false)}>
            Cancel
          </InvoBtn>
          <InvoBtn kind="primary" height={44} onClick={onSubmit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : customer ? 'Save changes' : 'Create client'}
          </InvoBtn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
