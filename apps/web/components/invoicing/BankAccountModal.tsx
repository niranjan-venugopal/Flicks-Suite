'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { Btn } from '@/components/proto'
import { useSaveBankAccount, type BankAccount, type BankAccountInput } from '@/lib/api/queries/use-invoicing'


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
            <label className="t-caption block mb-1.5">Beneficiary name *</label>
            <input className="input w-full" value={form.beneficiary_name} onChange={set('beneficiary_name')} placeholder="Should match your legal account holder name" />
          </div>
          <div>
            <label className="t-caption block mb-1.5">Account number *</label>
            <input className="input w-full" value={form.account_number} onChange={set('account_number')} inputMode="numeric" />
          </div>
          <div>
            <label className="t-caption block mb-1.5">Account type</label>
            <select className="input w-full" value={form.account_type ?? 'Current'} onChange={set('account_type')}>
              {['Current', 'Savings', 'EEFC'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="t-caption block mb-1.5">Bank name *</label>
            <input className="input w-full" value={form.bank_name} onChange={set('bank_name')} placeholder="HDFC Bank" />
          </div>
          <div>
            <label className="t-caption block mb-1.5">Branch</label>
            <input className="input w-full" value={form.branch ?? ''} onChange={set('branch')} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="t-caption block mb-1.5">IFSC (for INR transfers)</label>
            <input
              className={`input w-full ${ifscBad ? "border-red-400" : ""}`}
              value={form.ifsc ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, ifsc: e.target.value.toUpperCase() }))}
              placeholder="HDFC0001234"
            />
            {ifscBad && <div className="text-xs text-red-400 mt-1">4 letters, a zero, then 6 alphanumerics</div>}
          </div>

          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              id="intl-toggle"
              checked={intl}
              onChange={(e) => setIntl(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: '#3E7BFA' }}
            />
            <label htmlFor="intl-toggle" className="t-caption cursor-pointer">
              This account receives international (foreign-currency) transfers
            </label>
          </div>

          {intl && (
            <>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="t-caption block mb-1.5">SWIFT / BIC *</label>
                <input
                  className={`input w-full ${swiftBad ? "border-red-400" : ""}`}
                  value={form.swift_bic ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, swift_bic: e.target.value.toUpperCase() }))}
                  placeholder="HDFCINBB or HDFCINBBXXX"
                />
                {swiftBad && <div className="text-xs text-red-400 mt-1">8 or 11 alphanumerics</div>}
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="t-caption block mb-1.5">Bank address (required for international wires) *</label>
                <textarea
                  className="input w-full min-h-[56px] py-2.5 resize-y"
                  value={form.bank_address ?? ''}
                  onChange={set('bank_address')}
                  placeholder="Bank branch postal address"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={onSubmit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : account ? 'Save changes' : 'Add account'}
          </Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
