'use client'

import { useEffect, useState } from 'react'
import { Loader2, Plus, Landmark, Star } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { BankAccountModal } from '@/components/invoicing/BankAccountModal'
import { OrgDataLegal } from '@/components/consent/OrgDataLegal'
import { useToast } from '@/components/ui/use-toast'
import {
  useOrgFinancial,
  useUpdateOrgFinancial,
  useBankAccounts,
  useBankAccountAction,
  useSetCurrencyDefault,
  type BankAccount,
} from '@/lib/api/queries/use-invoicing'

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP']

/**
 * Organization → Financial details (PRD §7.2/§8) — an org Settings page, so it
 * follows the HRMS settings pattern (SettingsLayout + cards), NOT the Invo
 * module style. Single source of truth for legal name / GSTIN / PAN (columns
 * on the tenant) + the company bank accounts that render on invoices.
 */
export default function OrgFinancialPage() {
  const { toast } = useToast()
  const { data: fin, isLoading: finLoading } = useOrgFinancial()
  const updateFin = useUpdateOrgFinancial()
  const { data: banks, isLoading: banksLoading } = useBankAccounts()
  const bankAction = useBankAccountAction()
  const setCurrencyDefault = useSetCurrencyDefault()

  const [legalName, setLegalName] = useState('')
  const [gstin, setGstin] = useState('')
  const [pan, setPan] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<BankAccount | null>(null)

  useEffect(() => {
    if (fin?.data) {
      setLegalName(fin.data.legal_name ?? '')
      setGstin(fin.data.gstin ?? '')
      setPan(fin.data.pan ?? '')
    }
  }, [fin])

  const accounts = banks?.data ?? []
  const currencyDefaults = banks?.meta?.currency_defaults ?? {}

  const onSaveFinancial = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await updateFin.mutateAsync({
        legal_name: legalName || undefined,
        gstin: gstin || undefined,
        pan: pan || undefined,
      })
      toast({ title: 'Financial details saved' })
    } catch (err: any) {
      toast({
        title: 'Could not save',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const onAction = async (id: string, action: 'set-default' | 'delete') => {
    try {
      await bankAction.mutateAsync({ id, action })
      toast({ title: action === 'delete' ? 'Bank account removed' : 'Default updated' })
    } catch (err: any) {
      toast({
        title: 'Action failed',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const onCurrencyDefault = async (currency: string, bankAccountId: string) => {
    if (!bankAccountId) return
    try {
      await setCurrencyDefault.mutateAsync({ currency, bank_account_id: bankAccountId })
      toast({ title: `${currency} invoices will use this account` })
    } catch (err: any) {
      toast({
        title: 'Could not set currency default',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  return (
    <SettingsLayout>
      <SectionHead
        title="Organization · Financial details"
        sub="Legal identity and bank accounts — read by Invoicing today, Payroll later. Single source of truth."
        right={
          <Btn
            kind="primary"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => {
              setEditing(null)
              setModalOpen(true)
            }}
          >
            Add bank account
          </Btn>
        }
      />

      {/* Company financials (columns on the tenant) */}
      <form className="card p-5 mb-6" onSubmit={onSaveFinancial}>
        <div className="t-h3 mb-4">Company financials</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="t-caption block mb-1.5">Legal name</label>
            <input
              className="input w-full"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Acme Private Limited"
            />
          </div>
          <div>
            <label className="t-caption block mb-1.5">GSTIN</label>
            <input
              className="input w-full"
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="29ABCDE1234F1Z5"
            />
          </div>
          <div>
            <label className="t-caption block mb-1.5">PAN</label>
            <input
              className="input w-full"
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              placeholder="ABCDE1234F"
            />
          </div>
          <div>
            <label className="t-caption block mb-1.5">Fiscal year</label>
            <input
              className="input w-full opacity-60"
              value={`April – March (month ${fin?.data?.fiscal_year_start_month ?? 4})`}
              disabled
            />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <Btn kind="primary" type="submit" disabled={updateFin.isPending || finLoading}>
            {updateFin.isPending ? 'Saving…' : 'Save details'}
          </Btn>
        </div>
      </form>

      {/* Bank accounts */}
      {banksLoading ? (
        <div className="card p-12 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="w-12 h-12 rounded-xl bg-brand-blue/10 flex items-center justify-center mx-auto mb-4">
            <Landmark className="w-5 h-5 text-brand-blue" />
          </div>
          <h3 className="t-h3 mb-1">No bank accounts yet</h3>
          <p className="t-mute mb-4">
            Add one so your invoices can show payment details — IFSC for INR, SWIFT/BIC for international.
          </p>
          <Btn
            kind="primary"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => {
              setEditing(null)
              setModalOpen(true)
            }}
          >
            Add your first account
          </Btn>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden mb-6">
            <table className="tbl w-full">
              <thead>
                <tr>
                  <th>Bank</th>
                  <th>Account number</th>
                  <th>IFSC / SWIFT</th>
                  <th>Beneficiary</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className={a.is_active ? '' : 'opacity-50'}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{a.bank_name}</span>
                        <span className="t-mute text-xs">{a.account_type}</span>
                        {a.is_default && (
                          <Pill tone="blue">
                            <Star className="w-3 h-3" /> Default
                          </Pill>
                        )}
                      </div>
                      {a.branch && <div className="t-mute text-xs mt-0.5">{a.branch}</div>}
                    </td>
                    <td className="font-mono text-sm">{a.account_number}</td>
                    <td className="font-mono text-xs">
                      {a.ifsc && <div>IFSC {a.ifsc}</div>}
                      {a.swift_bic && <div>SWIFT {a.swift_bic}</div>}
                    </td>
                    <td className="t-mute text-sm">{a.beneficiary_name}</td>
                    <td>
                      <Pill tone={a.is_active ? 'green' : ''}>{a.is_active ? 'active' : 'inactive'}</Pill>
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {!a.is_default && (
                        <Btn kind="ghost" size="sm" onClick={() => onAction(a.id, 'set-default')}>
                          Set default
                        </Btn>
                      )}
                      <Btn
                        kind="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing(a)
                          setModalOpen(true)
                        }}
                      >
                        Edit
                      </Btn>
                      <Btn kind="ghost" size="sm" onClick={() => onAction(a.id, 'delete')}>
                        Remove
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Per-currency defaults */}
          <div className="card p-5">
            <div className="t-h3 mb-1">Default account per currency</div>
            <p className="t-mute text-sm mb-4">
              Invoices auto-pick the matching account when their currency changes. Foreign currencies require an
              account with a SWIFT/BIC.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {CURRENCIES.map((cur) => (
                <div key={cur}>
                  <label className="t-caption block mb-1.5">{cur}</label>
                  <select
                    className="input w-full"
                    value={currencyDefaults[cur] ?? ''}
                    onChange={(e) => onCurrencyDefault(cur, e.target.value)}
                  >
                    <option value="">— overall default —</option>
                    {accounts
                      .filter((a) => a.is_active && (cur === 'INR' || a.swift_bic))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.bank_name} …{a.account_number.slice(-4)}
                        </option>
                      ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* D17 (PRD v4 §3.5) — appended; everything above is unchanged */}
      <OrgDataLegal />

      <BankAccountModal open={modalOpen} onOpenChange={setModalOpen} account={editing} />
    </SettingsLayout>
  )
}
