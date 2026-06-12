'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { InvoBtn } from '@/components/invoicing/invo'
import { useSaveBankAccount, type BankAccount, type BankAccountInput } from '@/lib/api/queries/use-invoicing'

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
const HINT: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  color: 'rgba(255,255,255,0.35)',
  marginTop: 4,
  letterSpacing: '-0.01em',
}

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const SWIFT_RE = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/

/**
 * Add/Edit a company bank account (PRD §8). Conditional fields: IFSC for INR
 * use, SWIFT/BIC + bank address when the account is usable internationally.
 */
export function BankAccountModal({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  account?: BankAccount | null
}) {
  const { toast } = useToast()
  const save = useSaveBankAccount()
  const [form, setForm] = useState<BankAccountInput>({
    beneficiary_name: '',
    account_number: '',
    bank_name: '',
  })
  const [intl, setIntl] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(
        account
          ? {
              beneficiary_name: account.beneficiary_name,
              account_number: account.account_number,
              account_type: account.account_type,
              bank_name: account.bank_name,
              branch: account.branch ?? '',
              ifsc: account.ifsc ?? '',
              swift_bic: account.swift_bic ?? '',
              bank_address: account.bank_address ?? '',
            }
          : { beneficiary_name: '', account_number: '', bank_name: '', account_type: 'Current' },
      )
      setIntl(!!account?.swift_bic)
    }
  }, [open, account])

  const set =
    (k: keyof BankAccountInput) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const ifscBad = !!form.ifsc && !IFSC_RE.test(form.ifsc)
  const swiftBad = !!form.swift_bic && !SWIFT_RE.test(form.swift_bic)

  const onSubmit = async () => {
    if (!form.beneficiary_name.trim() || !form.account_number.trim() || !form.bank_name.trim()) {
      return toast({ title: 'Beneficiary, account number and bank name are required', variant: 'destructive' })
    }
    if (!form.ifsc && !form.swift_bic) {
      return toast({ title: 'Provide an IFSC (INR) and/or a SWIFT/BIC (international)', variant: 'destructive' })
    }
    if (ifscBad) return toast({ title: 'IFSC format is invalid (e.g. HDFC0001234)', variant: 'destructive' })
    if (swiftBad) return toast({ title: 'SWIFT/BIC format is invalid (e.g. HDFCINBB or HDFCINBBXXX)', variant: 'destructive' })
    if (intl && form.swift_bic && !form.bank_address?.trim()) {
      return toast({ title: 'Bank address is required for international use', variant: 'destructive' })
    }
    try {
      const payload: BankAccountInput = {
        ...form,
        ifsc: form.ifsc || undefined,
        swift_bic: intl ? form.swift_bic || undefined : undefined,
        bank_address: intl ? form.bank_address || undefined : undefined,
        branch: form.branch || undefined,
      }
      const res = await save.mutateAsync({ id: account?.id, ...payload })
      toast({
        title: account ? 'Bank account updated' : 'Bank account added',
        description: res.warning,
        variant: res.warning ? 'destructive' : undefined,
      })
      onOpenChange(false)
    } catch (err) {
      toast({
        title: 'Could not save bank account',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{account ? 'Edit bank account' : 'Add bank account'}</DialogTitle>
        </DialogHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, padding: '4px 0' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Beneficiary name *</label>
            <input style={FIELD} value={form.beneficiary_name} onChange={set('beneficiary_name')} placeholder="Should match your legal account holder name" />
          </div>
          <div>
            <label style={LABEL}>Account number *</label>
            <input style={FIELD} value={form.account_number} onChange={set('account_number')} inputMode="numeric" />
          </div>
          <div>
            <label style={LABEL}>Account type</label>
            <select style={FIELD} value={form.account_type ?? 'Current'} onChange={set('account_type')}>
              {['Current', 'Savings', 'EEFC'].map((t) => (
                <option key={t} value={t} style={{ color: '#000' }}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={LABEL}>Bank name *</label>
            <input style={FIELD} value={form.bank_name} onChange={set('bank_name')} placeholder="HDFC Bank" />
          </div>
          <div>
            <label style={LABEL}>Branch</label>
            <input style={FIELD} value={form.branch ?? ''} onChange={set('branch')} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>IFSC (for INR transfers)</label>
            <input
              style={{ ...FIELD, borderColor: ifscBad ? '#F8786B' : undefined }}
              value={form.ifsc ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, ifsc: e.target.value.toUpperCase() }))}
              placeholder="HDFC0001234"
            />
            {ifscBad && <div style={{ ...HINT, color: '#F8786B' }}>4 letters, a zero, then 6 alphanumerics</div>}
          </div>

          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              id="intl-toggle"
              checked={intl}
              onChange={(e) => setIntl(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: '#3E7BFA' }}
            />
            <label htmlFor="intl-toggle" style={{ ...LABEL, marginBottom: 0, cursor: 'pointer' }}>
              This account receives international (foreign-currency) transfers
            </label>
          </div>

          {intl && (
            <>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={LABEL}>SWIFT / BIC *</label>
                <input
                  style={{ ...FIELD, borderColor: swiftBad ? '#F8786B' : undefined }}
                  value={form.swift_bic ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, swift_bic: e.target.value.toUpperCase() }))}
                  placeholder="HDFCINBB or HDFCINBBXXX"
                />
                {swiftBad && <div style={{ ...HINT, color: '#F8786B' }}>8 or 11 alphanumerics</div>}
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={LABEL}>Bank address (required for international wires) *</label>
                <textarea
                  style={{ ...FIELD, height: 'auto', minHeight: 56, padding: '12px 14px', resize: 'vertical' }}
                  value={form.bank_address ?? ''}
                  onChange={set('bank_address')}
                  placeholder="Bank branch postal address"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <InvoBtn kind="outline" height={44} onClick={() => onOpenChange(false)}>
            Cancel
          </InvoBtn>
          <InvoBtn kind="primary" height={44} onClick={onSubmit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : account ? 'Save changes' : 'Add account'}
          </InvoBtn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
