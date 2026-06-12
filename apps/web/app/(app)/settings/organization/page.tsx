'use client'

import { useEffect, useState } from 'react'
import { useToast } from '@/components/ui/use-toast'
import { BankAccountModal } from '@/components/invoicing/BankAccountModal'
import {
  INVO,
  InvoPage,
  InvoTitle,
  InvoCard,
  InvoCardTitle,
  InvoBtn,
  InvoIcons,
  StatusChip,
  invoField,
  invoLabel,
} from '@/components/invoicing/invo'
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
 * Organization → Financial details (PRD §7.2/§8). Single source of truth for
 * legal name / GSTIN / PAN / FY (columns on the tenant) and the company bank
 * accounts that render on invoices.
 */
export default function OrgFinancialPage() {
  const { toast } = useToast()
  const { data: fin } = useOrgFinancial()
  const updateFin = useUpdateOrgFinancial()
  const { data: banks, isLoading } = useBankAccounts()
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

  const onSaveFinancial = async () => {
    try {
      await updateFin.mutateAsync({
        legal_name: legalName || undefined,
        gstin: gstin || undefined,
        pan: pan || undefined,
      })
      toast({ title: 'Financial details saved' })
    } catch (err) {
      toast({
        title: 'Could not save',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const onAction = async (id: string, action: 'set-default' | 'delete') => {
    try {
      await bankAction.mutateAsync({ id, action })
      toast({ title: action === 'delete' ? 'Bank account removed' : 'Default updated' })
    } catch (err) {
      toast({
        title: 'Action failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const onCurrencyDefault = async (currency: string, bankAccountId: string) => {
    if (!bankAccountId) return
    try {
      await setCurrencyDefault.mutateAsync({ currency, bank_account_id: bankAccountId })
      toast({ title: `${currency} invoices will use this account` })
    } catch (err) {
      toast({
        title: 'Could not set currency default',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <InvoPage glow="green">
      <InvoTitle icon={InvoIcons.settings}>Organization · Financial details</InvoTitle>

      {/* Financial details (tenants columns — shared with Payroll later) */}
      <InvoCard style={{ marginBottom: 20 }}>
        <InvoCardTitle>Company financials</InvoCardTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={invoLabel}>Legal name</label>
            <input style={invoField()} value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Acme Private Limited" />
          </div>
          <div>
            <label style={invoLabel}>GSTIN</label>
            <input style={invoField()} value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="29ABCDE1234F1Z5" />
          </div>
          <div>
            <label style={invoLabel}>PAN</label>
            <input style={invoField()} value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} placeholder="ABCDE1234F" />
          </div>
          <div>
            <label style={invoLabel}>Fiscal year</label>
            <input style={{ ...invoField(), opacity: 0.6 }} value={`Starts April (month ${fin?.data?.fiscal_year_start_month ?? 4})`} disabled />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <InvoBtn kind="primary" height={44} onClick={onSaveFinancial} disabled={updateFin.isPending}>
            {updateFin.isPending ? 'Saving…' : 'Save details'}
          </InvoBtn>
        </div>
      </InvoCard>

      {/* Bank accounts */}
      <InvoCard>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <InvoCardTitle>Bank accounts</InvoCardTitle>
          <InvoBtn
            kind="primary"
            height={44}
            icon={InvoIcons.plusSmall}
            onClick={() => {
              setEditing(null)
              setModalOpen(true)
            }}
          >
            Add account
          </InvoBtn>
        </div>

        {isLoading && <div style={{ color: INVO.muted40, fontWeight: 600 }}>Loading…</div>}
        {!isLoading && accounts.length === 0 && (
          <div style={{ color: INVO.muted40, fontWeight: 600, fontSize: 14, padding: '24px 0', textAlign: 'center' }}>
            No bank accounts yet — add one so invoices can show payment details.
          </div>
        )}

        <div style={{ display: 'grid', gap: 14 }}>
          {accounts.map((a) => (
            <div
              key={a.id}
              style={{
                padding: 18,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.04)',
                border: a.is_default ? '1.5px solid rgba(62,123,250,0.5)' : '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: '#fff', letterSpacing: '-0.02em' }}>
                      {a.bank_name} <span style={{ color: INVO.muted40 }}>· {a.account_type}</span>
                    </span>
                    {a.is_default && (
                      <span style={{ padding: '3px 10px', borderRadius: 999, background: 'rgba(62,123,250,0.15)', color: INVO.blue, fontWeight: 700, fontSize: 11 }}>
                        Default
                      </span>
                    )}
                    {!a.is_active && <StatusChip status="archived" />}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 13, color: INVO.muted60, marginBottom: 4 }}>
                    {a.account_number}
                    {a.ifsc && <span> · IFSC {a.ifsc}</span>}
                    {a.swift_bic && <span> · SWIFT {a.swift_bic}</span>}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 12, color: INVO.muted40 }}>
                    {a.beneficiary_name}
                    {a.branch ? ` · ${a.branch}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {!a.is_default && (
                    <InvoBtn kind="chip-blue" onClick={() => onAction(a.id, 'set-default')}>
                      Set default
                    </InvoBtn>
                  )}
                  <InvoBtn
                    kind="chip-blue"
                    onClick={() => {
                      setEditing(a)
                      setModalOpen(true)
                    }}
                  >
                    Edit
                  </InvoBtn>
                  <InvoBtn kind="chip-outline" onClick={() => onAction(a.id, 'delete')}>
                    Remove
                  </InvoBtn>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Per-currency defaults */}
        {accounts.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#fff', letterSpacing: '-0.02em', marginBottom: 10 }}>
              Default account per currency
            </div>
            <div style={{ fontWeight: 600, fontSize: 12, color: INVO.muted40, marginBottom: 12 }}>
              Invoices auto-pick the matching account when their currency changes (§8). Foreign currencies require an
              account with a SWIFT/BIC.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {CURRENCIES.map((cur) => (
                <div key={cur}>
                  <label style={invoLabel}>{cur}</label>
                  <select
                    style={invoField(true)}
                    value={currencyDefaults[cur] ?? ''}
                    onChange={(e) => onCurrencyDefault(cur, e.target.value)}
                  >
                    <option value="" style={{ color: '#000' }}>
                      — overall default —
                    </option>
                    {accounts
                      .filter((a) => a.is_active && (cur === 'INR' || a.swift_bic))
                      .map((a) => (
                        <option key={a.id} value={a.id} style={{ color: '#000' }}>
                          {a.bank_name} …{a.account_number.slice(-4)}
                        </option>
                      ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </InvoCard>

      <BankAccountModal open={modalOpen} onOpenChange={setModalOpen} account={editing} />
    </InvoPage>
  )
}
