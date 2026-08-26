'use client'

import { useState } from 'react'
import { Btn, Pill } from '@/components/proto'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DateField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import {
  useAdminSubmitEmployeeDetails,
  useEmployeeChangeRequests,
} from '@/lib/api/queries/use-employee-onboarding'
import type { EmployeeDetail } from '@/lib/api/queries/use-employees'
import { useOrganization } from '@/lib/api/queries/use-settings'
import {
  PAN_RE,
  IFSC_RE,
  BLOOD_GROUPS,
  MARITAL_STATUSES,
  GENDERS,
  BANK_ACCOUNT_TYPES,
  BANKS,
  OTHER_BANK,
} from '@/lib/employee-details'
import { INDIAN_STATES } from '@flicks/shared/constants'

const TABS = ['Personal', 'Identity', 'Bank & statutory'] as const

/**
 * Admin (owner/HR) editor for the detail groups the self-onboarding wizard
 * collects — personal, identity and bank/statutory — writing through the same
 * validated server pipeline (POST /employees/:id/onboarding/:step).
 * Sensitive values (PAN, account number) are write-only: when one is on file
 * the field shows a placeholder and an empty input means "keep as is".
 */
export function EditDetailsDialog({
  e,
  open,
  onClose,
}: {
  e: EmployeeDetail
  open: boolean
  onClose: () => void
}) {
  const { toast } = useToast()
  const submit = useAdminSubmitEmployeeDetails()
  const changeRequests = useEmployeeChangeRequests(e.id, open)
  const hasPending = (changeRequests.data?.requests ?? []).some(
    (r) => r.status === 'pending',
  )
  const [tab, setTab] = useState<(typeof TABS)[number]>('Personal')

  // PAN/Aadhaar/UAN are Indian statutory fields — follow the employee's
  // assigned location country, falling back to the organization's country.
  const org = useOrganization()
  const country = e.locationCountryCode ?? org.data?.countryCode ?? 'IN'
  const isIndia = country === 'IN'

  // Personal (step 1)
  const [dateOfBirth, setDateOfBirth] = useState(e.dateOfBirth ?? '')
  const [gender, setGender] = useState(e.gender ?? '')
  const [maritalStatus, setMaritalStatus] = useState(e.maritalStatus ?? '')
  const [bloodGroup, setBloodGroup] = useState(e.bloodGroup ?? '')
  const [addressLine1, setAddressLine1] = useState(e.currentAddress?.line1 ?? '')
  const [addressLine2, setAddressLine2] = useState(e.currentAddress?.line2 ?? '')
  const [city, setCity] = useState(e.currentAddress?.city ?? '')
  const [stateCode, setStateCode] = useState(e.currentAddress?.state ?? '')
  const [postalCode, setPostalCode] = useState(e.currentAddress?.postal_code ?? '')

  // Identity (step 2) — sensitive fields are write-only: blank means "keep".
  const [pan, setPan] = useState('')
  const [aadhaarLast4, setAadhaarLast4] = useState('')
  const [passportNumber, setPassportNumber] = useState('')
  const [personalEmail, setPersonalEmail] = useState(e.personalEmail ?? '')
  const [nationality, setNationality] = useState(e.nationality ?? '')

  // Bank & statutory (step 3). The select maps onto the shared BANKS list;
  // a stored value that's not on the list (legacy free-typed names) shows as
  // "Other" with the text pre-filled, so an untouched save round-trips the
  // identical string — never blanks it.
  const savedBank = e.bankName ?? ''
  const savedBankListed =
    savedBank !== '' &&
    savedBank !== OTHER_BANK &&
    (BANKS as readonly string[]).includes(savedBank)
  const [bankSelect, setBankSelect] = useState(
    savedBank === '' ? '' : savedBankListed ? savedBank : OTHER_BANK,
  )
  const [bankName, setBankName] = useState(savedBank)
  const [bankBranch, setBankBranch] = useState(e.bankBranch ?? '')
  const [bankAccountNumber, setBankAccountNumber] = useState('')
  const [bankAccountHolder, setBankAccountHolder] = useState(e.bankAccountHolder ?? '')
  const [bankIfsc, setBankIfsc] = useState(e.bankIfsc ?? '')
  const [bankAccountType, setBankAccountType] = useState(e.bankAccountType ?? '')
  const [pfUan, setPfUan] = useState(e.pfUan ?? '')

  const saveTab = async () => {
    try {
      let res: { pendingConfirmation?: boolean } | undefined
      if (tab === 'Personal') {
        res = await submit.mutateAsync({
          employeeId: e.id,
          step: 1,
          personalInfo: {
            dateOfBirth: dateOfBirth || undefined,
            gender: (gender || undefined) as 'male' | 'female' | 'other' | 'prefer_not_to_say' | undefined,
            maritalStatus: maritalStatus || undefined,
            bloodGroup: bloodGroup || undefined,
            addressLine1: addressLine1 || undefined,
            addressLine2: addressLine2 || undefined,
            city: city || undefined,
            stateCode: stateCode || undefined,
            postalCode: postalCode || undefined,
          },
        })
      } else if (tab === 'Identity') {
        if (isIndia && pan && !PAN_RE.test(pan)) {
          toast({ title: 'PAN looks invalid', description: 'Format: AAAAA9999A', variant: 'destructive' })
          return
        }
        if (isIndia && aadhaarLast4 && !/^\d{4}$/.test(aadhaarLast4)) {
          toast({ title: 'Aadhaar last 4 looks invalid', description: 'Exactly 4 digits', variant: 'destructive' })
          return
        }
        res = await submit.mutateAsync({
          employeeId: e.id,
          step: 2,
          identity: {
            pan: isIndia ? pan || undefined : undefined,
            aadhaarLast4: isIndia ? aadhaarLast4 || undefined : undefined,
            passportNumber: passportNumber || undefined,
            personalEmail: personalEmail || undefined,
            nationality: nationality || undefined,
          },
        })
      } else {
        if (bankIfsc && !IFSC_RE.test(bankIfsc)) {
          toast({ title: 'IFSC looks invalid', description: 'Format: AAAA0XXXXXX', variant: 'destructive' })
          return
        }
        res = await submit.mutateAsync({
          employeeId: e.id,
          step: 3,
          bank: {
            bankName: bankName || undefined,
            bankBranch: bankBranch || undefined,
            bankAccountNumber: bankAccountNumber || undefined,
            bankAccountHolder: bankAccountHolder || undefined,
            bankIfsc: bankIfsc || undefined,
            bankAccountType: (bankAccountType || undefined) as 'savings' | 'current' | 'salary' | undefined,
            pfUan: isIndia ? pfUan || undefined : undefined,
          },
        })
      }
      if (res?.pendingConfirmation) {
        toast({
          title: `Sent to ${e.firstName || 'the employee'} for confirmation`,
          description: 'Nothing changes on the record until they confirm it.',
        })
      } else {
        toast({ title: `${tab} details saved` })
      }
    } catch (err) {
      toast({
        title: 'Could not save',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const field = (label: string, node: React.ReactNode) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <label className="label" style={{ display: 'block', marginBottom: 6 }}>{label}</label>
      {node}
    </div>
  )
  const input = (
    value: string,
    onChange: (v: string) => void,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <input
      className="input"
      value={value}
      onChange={(ev) => onChange(ev.target.value)}
      style={{ width: '100%' }}
      {...props}
    />
  )
  const select = (value: string, onChange: (v: string) => void, options: readonly string[]) => (
    <select className="input" value={value} onChange={(ev) => onChange(ev.target.value)} style={{ width: '100%' }}>
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>
      ))}
    </select>
  )

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Edit personal &amp; statutory details
            {hasPending && (
              <Pill tone="yellow" style={{ marginLeft: 10, verticalAlign: 'middle' }}>
                Awaiting employee confirmation
              </Pill>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '7px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 700,
                cursor: 'pointer',
                background: tab === t ? 'var(--surf-2)' : 'transparent',
                border: tab === t ? '1px solid var(--bord-2)' : '1px solid transparent',
                color: tab === t ? '#fff' : 'var(--text-2)',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
          {tab === 'Personal' && (
            <>
              <div style={{ display: 'flex', gap: 12 }}>
                {field('Date of birth', <DateField value={dateOfBirth} onChange={setDateOfBirth} />)}
                {field('Gender', select(gender, setGender, GENDERS))}
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                {field('Marital status', select(maritalStatus, setMaritalStatus, MARITAL_STATUSES))}
                {field('Blood group', select(bloodGroup, setBloodGroup, BLOOD_GROUPS))}
              </div>
              {field('Address line 1', input(addressLine1, setAddressLine1, { maxLength: 200 }))}
              {field('Address line 2', input(addressLine2, setAddressLine2, { maxLength: 200 }))}
              <div style={{ display: 'flex', gap: 12 }}>
                {field('City', input(city, setCity, { maxLength: 80 }))}
                {field(
                  'State',
                  isIndia ? (
                    <select
                      className="input"
                      value={stateCode}
                      onChange={(ev) => setStateCode(ev.target.value)}
                      style={{ width: '100%' }}
                    >
                      <option value="">—</option>
                      {/* Legacy free-typed values (e.g. "TA" from the old
                          wizard) stay selectable so an untouched save
                          round-trips the identical string. */}
                      {stateCode &&
                        !INDIAN_STATES.some((s) => s.name === stateCode) && (
                          <option value={stateCode}>{stateCode}</option>
                        )}
                      {INDIAN_STATES.map((s) => (
                        <option key={s.code} value={s.name}>{s.name}</option>
                      ))}
                    </select>
                  ) : (
                    input(stateCode, setStateCode, { maxLength: 40 })
                  ),
                )}
                {field(
                  isIndia ? 'PIN code' : 'Postal / ZIP code',
                  input(postalCode, setPostalCode, { maxLength: 12, inputMode: 'numeric' }),
                )}
              </div>
            </>
          )}

          {tab === 'Identity' && (
            <>
              {isIndia && (
                <div style={{ display: 'flex', gap: 12 }}>
                  {field(
                    'PAN',
                    input(pan, (v) => setPan(v.toUpperCase()), {
                      maxLength: 10,
                      placeholder: e.hasPan ? '•••• on file — leave blank to keep' : 'AAAAA9999A',
                    }),
                  )}
                  {field(
                    'Aadhaar (last 4)',
                    input(aadhaarLast4, (v) => setAadhaarLast4(v.replace(/\D/g, '')), {
                      maxLength: 4,
                      inputMode: 'numeric',
                      placeholder: e.aadhaarLast4
                        ? `•••• ${e.aadhaarLast4} on file — leave blank to keep`
                        : 'Last 4 digits only',
                    }),
                  )}
                </div>
              )}
              {field(
                'Passport / national ID number',
                input(passportNumber, (v) => setPassportNumber(v.toUpperCase()), {
                  maxLength: 20,
                  placeholder: e.hasPassport ? '•••• on file — leave blank to keep' : 'A1234567',
                }),
              )}
              <div style={{ display: 'flex', gap: 12 }}>
                {field('Personal email', input(personalEmail, setPersonalEmail, { type: 'email', maxLength: 120 }))}
                {field('Nationality', input(nationality, setNationality, { maxLength: 60 }))}
              </div>
            </>
          )}

          {tab === 'Bank & statutory' && (
            <>
              <div style={{ display: 'flex', gap: 12 }}>
                {field(
                  'Bank name',
                  select(bankSelect, (v) => {
                    setBankSelect(v)
                    if (v === OTHER_BANK) {
                      // Keep whatever's typed (legacy value stays pre-filled).
                    } else {
                      setBankName(v)
                    }
                  }, BANKS),
                )}
                {field('Branch', input(bankBranch, setBankBranch, { maxLength: 80 }))}
              </div>
              {bankSelect === OTHER_BANK &&
                field(
                  'Bank name (type it in)',
                  input(bankName, setBankName, {
                    maxLength: 80,
                    placeholder: "Enter the bank's name",
                  }),
                )}
              <div style={{ display: 'flex', gap: 12 }}>
                {field(
                  'Account number',
                  input(bankAccountNumber, setBankAccountNumber, {
                    maxLength: 24,
                    inputMode: 'numeric',
                    placeholder: e.hasBankAccount ? '•••• on file — leave blank to keep' : '',
                  }),
                )}
                {field('Account holder', input(bankAccountHolder, setBankAccountHolder, { maxLength: 120 }))}
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                {field('IFSC', input(bankIfsc, (v) => setBankIfsc(v.toUpperCase()), { maxLength: 11 }))}
                {field('Account type', select(bankAccountType, setBankAccountType, BANK_ACCOUNT_TYPES))}
              </div>
              {isIndia &&
                field('PF UAN', input(pfUan, setPfUan, { maxLength: 20, inputMode: 'numeric' }))}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn kind="ghost" onClick={onClose} disabled={submit.isPending}>
            Close
          </Btn>
          <Btn kind="primary" onClick={saveTab} disabled={submit.isPending}>
            {submit.isPending ? 'Saving…' : `Save ${tab.toLowerCase()}`}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
