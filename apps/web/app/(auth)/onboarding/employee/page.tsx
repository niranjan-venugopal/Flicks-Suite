'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Pill, type IconKey } from '@/components/proto'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { DateField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCurrentUser } from '@/lib/api/queries/use-auth'
import {
  useEmployeeOnboardingStatus,
  useSubmitOnboardingStep,
  type SubmitOnboardingStepPayload,
} from '@/lib/api/queries/use-employee-onboarding'
import { useMyEmployeeRecord } from '@/lib/api/queries/use-employees'
import { useOrganization } from '@/lib/api/queries/use-settings'
import { PAN_RE, IFSC_RE, BANKS, OTHER_BANK } from '@/lib/employee-details'
import { INDIAN_STATES } from '@flicks/shared/constants'

// ─── Step metadata ───────────────────────────────────────────────────────────

interface StepMeta {
  title: string
  sub: string
}

// PAN/Aadhaar/UAN are Indian statutory documents — employees assigned to a
// location outside India see passport/ID fields instead.
const stepsFor = (isIndia: boolean): StepMeta[] => [
  { title: 'Personal info',     sub: 'Basic details & address' },
  { title: 'Identity',          sub: isIndia ? 'PAN, Aadhaar, contact' : 'Passport / ID, contact' },
  { title: 'Bank & statutory',  sub: isIndia ? 'Salary account & UAN' : 'Salary account details' },
  { title: 'Documents',         sub: 'Upload offer & ID proofs' },
  { title: 'Review',            sub: 'Submit for HR review' },
]


// Whole form state — every step writes into this then submits per-step.
type FormState = {
  // Step 1
  dateOfBirth: string
  gender: 'male' | 'female' | 'other' | 'prefer_not_to_say' | ''
  maritalStatus: string
  bloodGroup: string
  addressLine1: string
  addressLine2: string
  city: string
  stateCode: string
  postalCode: string
  emergencyName: string
  emergencyRelationship: string
  emergencyPhone: string
  // Step 2
  pan: string
  aadhaar: string  // only the last 4 digits are sent — never the full number
  passportNumber: string  // non-India identity document
  personalPhone: string
  personalEmail: string
  nationality: string
  // Step 3
  bankName: string
  bankBranch: string
  bankAccountNumber: string
  bankAccountNumberConfirm: string
  bankIfsc: string
  bankAccountType: 'savings' | 'current' | 'salary' | ''
  bankAccountHolder: string
  pfUan: string
}

const EMPTY: FormState = {
  dateOfBirth: '',
  gender: '',
  maritalStatus: '',
  bloodGroup: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  stateCode: '',
  postalCode: '',
  emergencyName: '',
  emergencyRelationship: '',
  emergencyPhone: '',
  pan: '',
  aadhaar: '',
  passportNumber: '',
  personalPhone: '',
  personalEmail: '',
  nationality: 'Indian',
  bankName: '',
  bankBranch: '',
  bankAccountNumber: '',
  bankAccountNumberConfirm: '',
  bankIfsc: '',
  bankAccountType: '',
  bankAccountHolder: '',
  pfUan: '',
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function EmployeeOnboardingPage() {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser, currentTenant } = useAuthStore()
  const me = useCurrentUser()
  const status = useEmployeeOnboardingStatus()
  const submit = useSubmitOnboardingStep()

  // Statutory fields follow the employee's assigned location country, falling
  // back to the organization's country (the org GET is readable by employees).
  const org = useOrganization()
  const myRecord = useMyEmployeeRecord()
  const country =
    myRecord.data?.locationCountryCode ?? org.data?.countryCode ?? 'IN'
  const isIndia = country === 'IN'

  const [stepIdx, setStepIdx] = useState(0) // 0-based
  const [form, setForm] = useState<FormState>(EMPTY)
  // DPDP: required data-processing consent + optional comms consent.
  const [consentData, setConsentData] = useState(false)
  const [consentComms, setConsentComms] = useState(false)

  // Resume on whatever step the user left off on
  useEffect(() => {
    if (status.data) {
      const lastSaved = Math.min(4, Math.max(0, status.data.onboardingStep - 1))
      // Only auto-advance forward — if the user manually clicked back we let
      // them stay there.
      setStepIdx((cur) => Math.max(cur, lastSaved))
    }
  }, [status.data])

  // If already submitted, redirect to dashboard
  useEffect(() => {
    if (status.data?.submittedForReview) {
      router.replace('/dashboard')
    }
  }, [status.data, router])

  const steps = useMemo(() => stepsFor(isIndia), [isIndia])
  const stepMeta = steps[stepIdx]!

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((p) => ({ ...p, [key]: value }))

  // ─── Per-step validation + payload builder ────────────────────────────

  const validateAndBuildPayload = (): SubmitOnboardingStepPayload | null => {
    const step = stepIdx + 1

    if (step === 1) {
      if (!form.emergencyName.trim() || !form.emergencyPhone.trim()) {
        toast({
          title: 'Emergency contact is required',
          description: 'Name and phone are mandatory.',
          variant: 'destructive',
        })
        return null
      }
      return {
        step,
        personalInfo: {
          dateOfBirth: form.dateOfBirth || undefined,
          gender: form.gender || undefined,
          maritalStatus: form.maritalStatus || undefined,
          bloodGroup: form.bloodGroup || undefined,
          addressLine1: form.addressLine1 || undefined,
          addressLine2: form.addressLine2 || undefined,
          city: form.city || undefined,
          stateCode: form.stateCode || undefined,
          postalCode: form.postalCode || undefined,
        },
        emergencyContact: {
          name: form.emergencyName.trim(),
          relationship: form.emergencyRelationship.trim() || 'Family',
          phone: form.emergencyPhone.trim(),
        },
      }
    }

    if (step === 2) {
      if (isIndia && form.pan && !PAN_RE.test(form.pan)) {
        toast({
          title: 'Invalid PAN',
          description: 'Format: 5 letters + 4 digits + 1 letter (e.g. ABCDE1234F).',
          variant: 'destructive',
        })
        return null
      }
      const aadhaarDigits = form.aadhaar.replace(/\D/g, '')
      if (isIndia && form.aadhaar && aadhaarDigits.length !== 12) {
        toast({
          title: 'Invalid Aadhaar',
          description: 'Aadhaar numbers have 12 digits.',
          variant: 'destructive',
        })
        return null
      }
      return {
        step,
        identity: {
          // Only the fields for this location's country are ever sent.
          ...(isIndia
            ? {
                pan: form.pan || undefined,
                // Privacy: the full Aadhaar never leaves the browser.
                aadhaarLast4: form.aadhaar
                  ? aadhaarDigits.slice(-4)
                  : undefined,
              }
            : { passportNumber: form.passportNumber || undefined }),
          personalPhone: form.personalPhone || undefined,
          personalEmail: form.personalEmail || undefined,
          nationality: form.nationality || undefined,
        },
      }
    }

    if (step === 3) {
      if (
        form.bankAccountNumber &&
        form.bankAccountNumberConfirm &&
        form.bankAccountNumber !== form.bankAccountNumberConfirm
      ) {
        toast({
          title: 'Account numbers do not match',
          description: 'Double-check before continuing.',
          variant: 'destructive',
        })
        return null
      }
      if (form.bankIfsc && !IFSC_RE.test(form.bankIfsc)) {
        toast({
          title: 'Invalid IFSC',
          description: 'Format: 4 letters + 0 + 6 alphanumeric (e.g. HDFC0001234).',
          variant: 'destructive',
        })
        return null
      }
      return {
        step,
        bank: {
          bankName: form.bankName || undefined,
          bankBranch: form.bankBranch || undefined,
          bankAccountNumber: form.bankAccountNumber || undefined,
          bankAccountHolder: form.bankAccountHolder || undefined,
          bankIfsc: form.bankIfsc || undefined,
          bankAccountType: form.bankAccountType || undefined,
          pfUan: isIndia ? form.pfUan || undefined : undefined,
        },
      }
    }

    if (step === 4) {
      // Documents are placeholders (R2 hasn't shipped). The step is a no-op
      // server-side; advance through it.
      return { step }
    }

    if (step === 5) {
      if (!consentData) {
        toast({
          title: 'Consent required',
          description:
            'Please agree to the processing of your personal data to submit.',
          variant: 'destructive',
        })
        return null
      }
      return {
        step,
        submitForReview: true,
        consents: [
          {
            type: 'data_processing' as const,
            granted: true,
            purpose: isIndia
              ? 'HR, payroll and statutory compliance (PAN, Aadhaar last-4, bank, attendance).'
              : 'HR, payroll and statutory compliance (identity documents, bank, attendance).',
          },
          {
            type: 'marketing' as const,
            granted: consentComms,
            purpose: 'Product updates and tips via email.',
          },
        ],
      }
    }

    return { step }
  }

  // ─── Navigation ───────────────────────────────────────────────────────

  const handleContinue = async () => {
    const payload = validateAndBuildPayload()
    if (!payload) return
    try {
      const result = await submit.mutateAsync(payload)
      if (result.allStepsComplete) {
        toast({
          title: 'Submitted for review',
          description: 'HR will confirm your details shortly.',
        })
        // Make sure /me reflects the now-complete onboarding before we route.
        await me.refetch()
        router.replace('/dashboard')
        return
      }
      setStepIdx((cur) => Math.min(4, cur + 1))
    } catch (e: any) {
      toast({
        title: 'Could not save',
        description: e?.message ?? 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handleBack = () => setStepIdx((cur) => Math.max(0, cur - 1))

  const handleSaveAndExit = async () => {
    const payload = validateAndBuildPayload()
    if (!payload) return
    try {
      await submit.mutateAsync(payload)
      toast({ title: 'Progress saved', description: "You can pick this up later." })
      router.replace('/dashboard')
    } catch (e: any) {
      toast({
        title: 'Could not save',
        description: e?.message ?? 'Try again',
        variant: 'destructive',
      })
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────

  const workspaceName = currentTenant?.name ?? 'your workspace'
  const userName = currentUser?.name ?? 'there'
  const startDate = useMemo(
    () =>
      new Date().toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    [],
  )

  return (
    <AuthLayout step={stepIdx + 1} total={5} label="Onboarding">
      <div
        style={{
          width: '100%',
          maxWidth: 920,
          display: 'grid',
          gridTemplateColumns: '260px 1fr',
          gap: 24,
        }}
      >
        {/* ─── Left rail ───────────────────────────────────────────────── */}
        <div>
          <div
            style={{
              padding: '18px 16px',
              background: 'var(--surf-1)',
              border: '1px solid var(--bord)',
              borderRadius: 14,
              marginBottom: 14,
            }}
          >
            <div className="t-caption" style={{ marginBottom: 6 }}>
              Welcome to
            </div>
            <div
              style={{
                fontSize: 17,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                marginBottom: 2,
              }}
            >
              {workspaceName}
            </div>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--text-mute)',
              }}
            >
              Hi {userName.split(' ')[0]}, your start date is{' '}
              <strong style={{ color: '#fff' }}>{startDate}</strong>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {steps.map((s, i) => {
              const done = i < stepIdx
              const active = i === stepIdx
              return (
                <button
                  key={i}
                  onClick={() => (done ? setStepIdx(i) : null)}
                  type="button"
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 9,
                    cursor: done ? 'pointer' : 'default',
                    background: active ? 'var(--surf-2)' : 'transparent',
                    border: 'none',
                    color: 'inherit',
                    width: '100%',
                    textAlign: 'left',
                  }}
                >
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: done
                        ? 'var(--green)'
                        : active
                          ? 'var(--blue)'
                          : 'var(--surf-2)',
                      color: done || active ? '#fff' : 'var(--text-mute)',
                      border:
                        done || active ? 'none' : '1px solid var(--bord-2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {done ? <Icon.check size={12} /> : i + 1}
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: active ? 800 : 700,
                        color:
                          active || done ? '#fff' : 'var(--text-2)',
                      }}
                    >
                      {s.title}
                    </div>
                    <div
                      style={{
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: 'var(--text-mute)',
                      }}
                    >
                      {s.sub}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          <div
            style={{
              marginTop: 16,
              padding: 14,
              background: 'rgba(62, 123, 250, 0.06)',
              border: '1px solid rgba(62, 123, 250, 0.2)',
              borderRadius: 10,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Icon.shield
                size={14}
                style={{ color: 'var(--blue)', marginTop: 1, flexShrink: 0 }}
              />
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--text-2)',
                  lineHeight: 1.5,
                }}
              >
                Your data is encrypted and only visible to HR. You can edit
                later from your profile.
              </div>
            </div>
          </div>
        </div>

        {/* ─── Right panel ─────────────────────────────────────────────── */}
        <div
          className="card-glass"
          style={{ borderRadius: 16, padding: 32 }}
        >
          <div style={{ marginBottom: 20 }}>
            <div className="t-caption" style={{ marginBottom: 6 }}>
              Step {stepIdx + 1} of 5
            </div>
            <div className="t-h1" style={{ fontSize: 24, marginBottom: 6 }}>
              {stepMeta.title}
            </div>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--text-2)',
              }}
            >
              {stepMeta.sub}
            </div>
          </div>

          {stepIdx === 0 && (
            <PersonalInfoStep
              form={form}
              set={setField}
              userName={userName}
              isIndia={isIndia}
            />
          )}
          {stepIdx === 1 && (
            <IdentityStep form={form} set={setField} isIndia={isIndia} />
          )}
          {stepIdx === 2 && (
            <BankStep form={form} set={setField} isIndia={isIndia} />
          )}
          {stepIdx === 3 && <DocumentsStep isIndia={isIndia} />}
          {stepIdx === 4 && (
            <ReviewStep
              form={form}
              userName={userName}
              isIndia={isIndia}
              consentData={consentData}
              setConsentData={setConsentData}
              consentComms={consentComms}
              setConsentComms={setConsentComms}
            />
          )}

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              gap: 10,
              marginTop: 24,
              paddingTop: 20,
              borderTop: '1px solid var(--bord)',
            }}
          >
            <Btn
              kind="ghost"
              onClick={handleBack}
              disabled={stepIdx === 0}
              icon={<Icon.arrowL size={14} />}
            >
              Back
            </Btn>
            <div style={{ flex: 1 }} />
            <Btn
              kind="ghost"
              onClick={handleSaveAndExit}
              disabled={submit.isPending}
            >
              Save & exit
            </Btn>
            <Btn
              kind="primary"
              onClick={handleContinue}
              disabled={submit.isPending}
              iconRight={<Icon.arrow size={14} />}
            >
              {submit.isPending
                ? 'Saving…'
                : stepIdx === 4
                  ? 'Submit for review'
                  : 'Continue'}
            </Btn>
          </div>
        </div>
      </div>
    </AuthLayout>
  )
}

// ─── Step 1: Personal info ───────────────────────────────────────────────────

function PersonalInfoStep({
  form,
  set,
  userName,
  isIndia,
}: {
  form: FormState
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void
  userName: string
  isIndia: boolean
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <div style={{ gridColumn: 'span 2' }}>
        <label className="label">Full name (as per PAN)</label>
        <input
          className="input"
          value={userName}
          readOnly
          style={{ opacity: 0.7, cursor: 'not-allowed' }}
        />
        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4 }}>
          Set during signup — contact HR to change.
        </div>
      </div>
      <div>
        <label className="label">Date of birth</label>
        <DateField
          value={form.dateOfBirth}
          onChange={(v) => set('dateOfBirth', v)}
        />
      </div>
      <div>
        <label className="label">Gender</label>
        <select
          className="input"
          value={form.gender}
          onChange={(e) => set('gender', e.target.value as FormState['gender'])}
        >
          <option value="">Select…</option>
          <option value="female">Female</option>
          <option value="male">Male</option>
          <option value="other">Other</option>
          <option value="prefer_not_to_say">Prefer not to say</option>
        </select>
      </div>
      <div>
        <label className="label">Marital status</label>
        <select
          className="input"
          value={form.maritalStatus}
          onChange={(e) => set('maritalStatus', e.target.value)}
        >
          <option value="">Select…</option>
          <option value="single">Single</option>
          <option value="married">Married</option>
          <option value="divorced">Divorced</option>
          <option value="widowed">Widowed</option>
        </select>
      </div>
      <div>
        <label className="label">Blood group</label>
        <select
          className="input"
          value={form.bloodGroup}
          onChange={(e) => set('bloodGroup', e.target.value)}
        >
          <option value="">Select…</option>
          {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </div>
      <div style={{ gridColumn: 'span 2' }}>
        <label className="label">Current address</label>
        <input
          className="input"
          value={form.addressLine1}
          onChange={(e) => set('addressLine1', e.target.value)}
          placeholder="House / flat number, street"
          style={{ marginBottom: 8 }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: 8 }}>
          <input
            className="input"
            value={form.city}
            onChange={(e) => set('city', e.target.value)}
            placeholder="City"
          />
          {isIndia ? (
            <select
              className="input"
              value={form.stateCode}
              onChange={(e) => set('stateCode', e.target.value)}
            >
              <option value="">State…</option>
              {INDIAN_STATES.map((s) => (
                <option key={s.code} value={s.name}>{s.name}</option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              value={form.stateCode}
              onChange={(e) => set('stateCode', e.target.value)}
              placeholder="State / Province / Emirate"
              maxLength={40}
            />
          )}
          <input
            className="input"
            value={form.postalCode}
            onChange={(e) => set('postalCode', e.target.value)}
            placeholder={isIndia ? 'PIN' : 'Postal / ZIP'}
            inputMode="numeric"
          />
        </div>
      </div>
      <div>
        <label className="label">Emergency contact name <span style={{ color: 'var(--coral)' }}>*</span></label>
        <input
          className="input"
          value={form.emergencyName}
          onChange={(e) => set('emergencyName', e.target.value)}
          placeholder="Anita Sharma"
          required
        />
      </div>
      <div>
        <label className="label">Relationship</label>
        <select
          className="input"
          value={form.emergencyRelationship}
          onChange={(e) => set('emergencyRelationship', e.target.value)}
        >
          <option value="">Select…</option>
          <option value="Parent">Parent</option>
          <option value="Spouse">Spouse</option>
          <option value="Sibling">Sibling</option>
          <option value="Child">Child</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div style={{ gridColumn: 'span 2' }}>
        <label className="label">Emergency contact phone <span style={{ color: 'var(--coral)' }}>*</span></label>
        <input
          className="input"
          value={form.emergencyPhone}
          onChange={(e) => set('emergencyPhone', e.target.value)}
          placeholder="+91 98765 43210"
          required
        />
      </div>
    </div>
  )
}

// ─── Step 2: Identity ────────────────────────────────────────────────────────

function IdentityStep({
  form,
  set,
  isIndia,
}: {
  form: FormState
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void
  isIndia: boolean
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      {isIndia ? (
        <>
          <div style={{ gridColumn: 'span 2' }}>
            <label className="label">
              PAN{' '}
              <span style={{ color: 'var(--text-faint)', textTransform: 'none' }}>
                (required for TDS)
              </span>
            </label>
            <input
              className="input"
              value={form.pan}
              onChange={(e) => set('pan', e.target.value.toUpperCase())}
              placeholder="ABCDE1234F"
              style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}
              maxLength={10}
            />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <label className="label">Aadhaar number</label>
            <input
              className="input"
              value={form.aadhaar}
              onChange={(e) => set('aadhaar', e.target.value)}
              placeholder="1234 5678 9012"
              style={{ fontFamily: 'var(--font-mono)' }}
              maxLength={14}
            />
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-mute)',
                marginTop: 6,
                display: 'flex',
                gap: 6,
                alignItems: 'center',
              }}
            >
              <Icon.shield size={11} /> Only the last 4 digits are stored ·
              visible to admin only
            </div>
          </div>
        </>
      ) : (
        <div style={{ gridColumn: 'span 2' }}>
          <label className="label">
            Passport / national ID number{' '}
            <span style={{ color: 'var(--text-faint)', textTransform: 'none' }}>
              (as followed at your location)
            </span>
          </label>
          <input
            className="input"
            value={form.passportNumber}
            onChange={(e) => set('passportNumber', e.target.value.toUpperCase())}
            placeholder="A1234567"
            style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}
            maxLength={20}
          />
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-mute)',
              marginTop: 6,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <Icon.shield size={11} /> Encrypted at rest · visible to HR only
          </div>
        </div>
      )}
      <div>
        <label className="label">Personal phone</label>
        <input
          className="input"
          value={form.personalPhone}
          onChange={(e) => set('personalPhone', e.target.value)}
          placeholder="+91 98765 43210"
        />
      </div>
      <div>
        <label className="label">Personal email</label>
        <input
          className="input"
          type="email"
          value={form.personalEmail}
          onChange={(e) => set('personalEmail', e.target.value)}
          placeholder="you@gmail.com"
        />
      </div>
      <div style={{ gridColumn: 'span 2' }}>
        <label className="label">Nationality</label>
        <select
          className="input"
          value={form.nationality}
          onChange={(e) => set('nationality', e.target.value)}
        >
          <option value="Indian">Indian</option>
          <option value="NRI">NRI (Non-Resident Indian)</option>
          <option value="OCI">OCI</option>
          <option value="Foreign National">Foreign National</option>
        </select>
      </div>
    </div>
  )
}

// ─── Step 3: Bank & statutory ────────────────────────────────────────────────

function BankStep({
  form,
  set,
  isIndia,
}: {
  form: FormState
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void
  isIndia: boolean
}) {
  // "Other" opens a free-text field; the typed name is what's stored in the
  // single bankName string (nothing new is POSTed — the API takes free text).
  const [otherBank, setOtherBank] = useState(false)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <div style={{ gridColumn: otherBank ? 'span 1' : 'span 2' }}>
        <label className="label">Bank name</label>
        <select
          className="input"
          value={otherBank ? OTHER_BANK : form.bankName}
          onChange={(e) => {
            const v = e.target.value
            if (v === OTHER_BANK) {
              setOtherBank(true)
              set('bankName', '')
            } else {
              setOtherBank(false)
              set('bankName', v)
            }
          }}
        >
          <option value="">Select…</option>
          {BANKS.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>
      {otherBank && (
        <div>
          <label className="label">Bank name (type it in)</label>
          <input
            className="input"
            value={form.bankName}
            onChange={(e) => set('bankName', e.target.value)}
            placeholder="Enter your bank's name"
            maxLength={80}
            autoFocus
          />
        </div>
      )}
      <div>
        <label className="label">Account number</label>
        <input
          className="input"
          value={form.bankAccountNumber}
          onChange={(e) => set('bankAccountNumber', e.target.value)}
          placeholder="50100123456789"
          style={{ fontFamily: 'var(--font-mono)' }}
          inputMode="numeric"
        />
      </div>
      <div>
        <label className="label">Confirm account number</label>
        <input
          className="input"
          value={form.bankAccountNumberConfirm}
          onChange={(e) => set('bankAccountNumberConfirm', e.target.value)}
          placeholder="50100123456789"
          style={{ fontFamily: 'var(--font-mono)' }}
          inputMode="numeric"
        />
      </div>
      <div>
        <label className="label">IFSC code</label>
        <input
          className="input"
          value={form.bankIfsc}
          onChange={(e) => set('bankIfsc', e.target.value.toUpperCase())}
          placeholder="HDFC0001234"
          style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}
          maxLength={11}
        />
      </div>
      <div>
        <label className="label">Account type</label>
        <select
          className="input"
          value={form.bankAccountType}
          onChange={(e) =>
            set('bankAccountType', e.target.value as FormState['bankAccountType'])
          }
        >
          <option value="">Select…</option>
          <option value="savings">Savings</option>
          <option value="current">Current</option>
          <option value="salary">Salary</option>
        </select>
      </div>
      {isIndia && (
        <div
          style={{
            gridColumn: 'span 2',
            padding: 14,
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            borderRadius: 10,
            marginTop: 6,
          }}
        >
          <div className="t-h3" style={{ fontSize: 13, marginBottom: 10 }}>
            Statutory{' '}
            <span
              style={{
                color: 'var(--text-faint)',
                fontWeight: 600,
                fontSize: 11,
              }}
            >
              (optional, can be added later)
            </span>
          </div>
          <div>
            <label className="label">UAN (Universal Account Number)</label>
            <input
              className="input"
              value={form.pfUan}
              onChange={(e) => set('pfUan', e.target.value)}
              placeholder="100123456789"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-mute)',
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              Your PF account is linked through your UAN — HR completes PF
              setup on the employer portal. No document needed from you.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Step 4: Documents ───────────────────────────────────────────────────────

const docsFor = (
  isIndia: boolean,
): Array<{ name: string; required: boolean; sub: string }> => [
  { name: 'Signed offer letter', required: true, sub: 'PDF · max 10 MB' },
  ...(isIndia
    ? [
        { name: 'PAN card', required: true, sub: 'PDF, JPG, or PNG · max 10 MB' },
        { name: 'Aadhaar card (front + back)', required: true, sub: 'PDF or JPG · max 10 MB' },
        { name: 'Cancelled cheque or bank statement', required: true, sub: 'PDF or JPG · max 10 MB' },
      ]
    : [
        { name: 'Passport or national ID (front + back)', required: true, sub: 'PDF or JPG · max 10 MB' },
        { name: 'Bank statement or account proof', required: true, sub: 'PDF or JPG · max 10 MB' },
      ]),
  { name: 'Educational certificates', required: false, sub: 'PDF · max 10 MB' },
  { name: 'Previous employment relieving letter', required: false, sub: 'PDF · max 10 MB' },
]

function DocumentsStep({ isIndia }: { isIndia: boolean }) {
  const docs = docsFor(isIndia)
  return (
    <>
      <div
        style={{
          padding: 14,
          background: 'rgba(254, 216, 0, 0.07)',
          border: '1px solid rgba(254, 216, 0, 0.2)',
          borderRadius: 10,
          marginBottom: 16,
          display: 'flex',
          gap: 10,
        }}
      >
        <Icon.info
          size={16}
          style={{ color: 'var(--yellow)', marginTop: 1, flexShrink: 0 }}
        />
        <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          <strong style={{ color: '#fff' }}>Uploads coming soon.</strong> You can
          finish onboarding without them — HR will collect your documents over
          email in the meantime.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {docs.map((d, i) => (
          <div
            key={i}
            style={{
              padding: '14px 16px',
              background: 'var(--surf-1)',
              border: '1px solid var(--bord)',
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              opacity: 0.7,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 9,
                background: 'var(--surf-2)',
                color: 'var(--text-mute)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon.upload size={15} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 800 }}>{d.name}</span>
                {d.required && <Pill tone="coral">Required</Pill>}
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--text-mute)',
                  marginTop: 2,
                }}
              >
                {d.sub}
              </div>
            </div>
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.upload size={12} />}
              disabled
            >
              Upload (soon)
            </Btn>
          </div>
        ))}
      </div>
    </>
  )
}

// ─── Step 5: Review ──────────────────────────────────────────────────────────

function ReviewStep({
  form,
  userName,
  isIndia,
  consentData,
  setConsentData,
  consentComms,
  setConsentComms,
}: {
  form: FormState
  userName: string
  isIndia: boolean
  consentData: boolean
  setConsentData: (v: boolean) => void
  consentComms: boolean
  setConsentComms: (v: boolean) => void
}) {
  const summary: Array<{ title: string; value: string }> = [
    {
      title: 'Personal info',
      value: [
        userName,
        form.dateOfBirth,
        form.city || form.addressLine1,
      ]
        .filter(Boolean)
        .join(' · ') || 'Not provided',
    },
    {
      title: 'Identity',
      value: isIndia
        ? form.pan
          ? `PAN ${form.pan}${
              form.aadhaar
                ? ` · Aadhaar •••• ${form.aadhaar.replace(/\D/g, '').slice(-4)}`
                : ''
            }`
          : 'Not provided'
        : form.passportNumber
          ? `Passport / ID ••••${form.passportNumber.slice(-4)}`
          : 'Not provided',
    },
    {
      title: 'Bank',
      value:
        form.bankName
          ? `${form.bankName}${
              form.bankAccountNumber
                ? ` · ••••${form.bankAccountNumber.slice(-4)}`
                : ''
            }${form.bankIfsc ? ` · IFSC ${form.bankIfsc}` : ''}`
          : 'Not provided',
    },
    {
      title: 'Documents',
      value: `0 of ${docsFor(isIndia).length} uploaded · HR will collect these over email`,
    },
  ]

  return (
    <div>
      <div
        style={{
          padding: 14,
          background: 'rgba(39, 210, 128, 0.06)',
          border: '1px solid rgba(39, 210, 128, 0.25)',
          borderRadius: 10,
          display: 'flex',
          gap: 12,
          marginBottom: 18,
        }}
      >
        <Icon.check
          size={18}
          style={{ color: 'var(--green)', marginTop: 1, flexShrink: 0 }}
        />
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 2 }}>
            Everything looks good
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-2)',
              lineHeight: 1.5,
            }}
          >
            You can still go back and edit any section. After submitting, HR
            will review and confirm your start date.
          </div>
        </div>
      </div>

      {summary.map((s, i) => (
        <div
          key={i}
          style={{
            padding: '14px 16px',
            borderTop: i ? '1px solid var(--bord)' : 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div style={{ flex: 1 }}>
            <div className="t-caption" style={{ marginBottom: 3 }}>
              {s.title}
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-2)',
              }}
            >
              {s.value}
            </div>
          </div>
        </div>
      ))}

      {/* DPDP consent */}
      <div
        style={{
          marginTop: 20,
          paddingTop: 18,
          borderTop: '1px solid var(--bord)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div className="t-caption">Data &amp; privacy consent</div>
        <ConsentRow
          checked={consentData}
          onChange={setConsentData}
          required
        >
          I consent to Flicks Suite processing my personal and statutory data
          ({isIndia ? 'PAN, Aadhaar last-4' : 'identity documents'}, bank
          details, attendance) for HR, payroll and compliance, as described in
          the{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--blue)', fontWeight: 700 }}
          >
            Privacy Policy
          </a>
          .
        </ConsentRow>
        <ConsentRow checked={consentComms} onChange={setConsentComms}>
          I&apos;d like to receive occasional product updates and tips by email
          (optional).
        </ConsentRow>
        <div style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>
          You can withdraw consent any time from your profile. Withdrawing the
          first consent may limit payroll and statutory features.
        </div>
      </div>
    </div>
  )
}

function ConsentRow({
  checked,
  onChange,
  required,
  children,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--text-2)',
        lineHeight: 1.5,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0, width: 16, height: 16, accentColor: 'var(--blue)' }}
      />
      <span>
        {children}
        {required && <span style={{ color: 'var(--coral)' }}> *</span>}
      </span>
    </label>
  )
}
