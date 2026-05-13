'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { useToast } from '@/components/ui/use-toast'
import { useDebounce } from '@/lib/hooks/use-debounce'
import { useRequestOtp, useVerifyOtp } from '@/lib/api/queries/use-auth'
import { useCheckSlug, useCreateTenant } from '@/lib/api/queries/use-onboarding'

// ─── Static option sets ─────────────────────────────────────────────────────

const SIZE_BANDS = ['1–10', '11–50', '51–200', '201–500', '500+'] as const

const INDUSTRIES = [
  'SaaS / Software',
  'Technology',
  'Manufacturing',
  'Retail',
  'Financial Services',
  'Healthcare',
  'Education',
  'Media & Entertainment',
  'Consulting',
  'Logistics',
  'Other',
] as const

// ─── Helpers ────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

// ─── Page ───────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3

export default function OnboardingWizardPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [step, setStep] = useState<Step>(1)

  // Step 1 state
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [acceptedTerms, setAcceptedTerms] = useState(true)

  // Step 2 state
  const [otp, setOtp] = useState(['', '', '', '', '', ''])

  // Step 3 state
  const [workspaceName, setWorkspaceName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null)
  const [sizeBand, setSizeBand] = useState<string>('11–50')
  const [industry, setIndustry] = useState<string>('SaaS / Software')
  const [primaryLocation, setPrimaryLocation] = useState('')

  // Mutations
  const requestOtp = useRequestOtp()
  const verifyOtp = useVerifyOtp()
  const checkSlug = useCheckSlug()
  const createTenant = useCreateTenant()

  const fullName = `${firstName} ${lastName}`.trim()

  // Live slug check
  const debouncedSlug = useDebounce(slug, 300)
  useEffect(() => {
    if (debouncedSlug.length >= 3) {
      checkSlug.mutate(
        { slug: debouncedSlug },
        {
          onSuccess: (data) => setSlugAvailable(data.available),
          onError: () => setSlugAvailable(null),
        },
      )
    } else {
      setSlugAvailable(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSlug])

  // Auto-suggest slug from workspace name (until the user edits it manually)
  useEffect(() => {
    if (!slugEdited) setSlug(toSlug(workspaceName))
  }, [workspaceName, slugEdited])

  // ─── Step 1: Send OTP ─────────────────────────────────────────────────
  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !firstName.trim()) {
      toast({
        title: 'Email and first name are required',
        variant: 'destructive',
      })
      return
    }
    if (!acceptedTerms) {
      toast({ title: 'Please accept the terms to continue', variant: 'destructive' })
      return
    }
    try {
      await requestOtp.mutateAsync({ email: email.trim().toLowerCase() })
      toast({
        title: 'Check your inbox',
        description: 'We sent a 6-digit code. It expires in 10 minutes.',
      })
      setStep(2)
    } catch (e: any) {
      toast({
        title: 'Could not send OTP',
        description: e?.message ?? 'Try again',
        variant: 'destructive',
      })
    }
  }

  // ─── Step 2: Verify OTP ───────────────────────────────────────────────
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    const code = otp.join('')
    if (code.length !== 6) {
      toast({ title: 'Enter all 6 digits', variant: 'destructive' })
      return
    }
    try {
      await verifyOtp.mutateAsync({
        email: email.trim().toLowerCase(),
        code,
      })
      setStep(3)
    } catch (e: any) {
      toast({
        title: 'Invalid code',
        description: e?.message ?? 'Try again or request a new code',
        variant: 'destructive',
      })
    }
  }

  // ─── Step 3: Create workspace ─────────────────────────────────────────
  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!workspaceName.trim()) {
      toast({ title: 'Enter a workspace name', variant: 'destructive' })
      return
    }
    if (!slug || slug.length < 3) {
      toast({ title: 'Workspace URL is too short', variant: 'destructive' })
      return
    }
    if (slugAvailable === false) {
      toast({
        title: 'That URL is taken',
        description: 'Choose a different slug.',
        variant: 'destructive',
      })
      return
    }
    if (!primaryLocation.trim()) {
      toast({ title: 'Add a primary location', variant: 'destructive' })
      return
    }
    try {
      await createTenant.mutateAsync({
        name: workspaceName.trim(),
        slug,
        fullName,
        industry,
        sizeBand,
        primaryLocation: {
          name: primaryLocation.trim(),
          timezone: 'Asia/Kolkata',
        },
      })
      toast({
        title: 'Workspace ready',
        description: `Welcome to ${workspaceName.trim()}!`,
      })
      router.replace('/dashboard')
    } catch (e: any) {
      toast({
        title: 'Could not create workspace',
        description: e?.message ?? 'Try again',
        variant: 'destructive',
      })
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <AuthLayout
      step={step >= 2 ? step + 1 : undefined}
      total={4}
      label={step === 2 ? 'OTP' : step === 3 ? 'Workspace' : undefined}
    >
      {step === 1 && (
        <SignupStep
          email={email}
          setEmail={setEmail}
          firstName={firstName}
          setFirstName={setFirstName}
          lastName={lastName}
          setLastName={setLastName}
          acceptedTerms={acceptedTerms}
          setAcceptedTerms={setAcceptedTerms}
          onSubmit={handleSendOtp}
          submitting={requestOtp.isPending}
        />
      )}

      {step === 2 && (
        <OtpStep
          email={email}
          otp={otp}
          setOtp={setOtp}
          onSubmit={handleVerifyOtp}
          onBack={() => setStep(1)}
          onResend={() => {
            requestOtp.mutate({ email: email.trim().toLowerCase() })
            toast({ title: 'New code sent', description: 'Check your inbox.' })
          }}
          submitting={verifyOtp.isPending}
        />
      )}

      {step === 3 && (
        <WorkspaceStep
          workspaceName={workspaceName}
          setWorkspaceName={setWorkspaceName}
          slug={slug}
          setSlug={(v) => {
            setSlugEdited(true)
            setSlug(toSlug(v))
          }}
          slugAvailable={slugAvailable}
          slugChecking={checkSlug.isPending}
          sizeBand={sizeBand}
          setSizeBand={setSizeBand}
          industry={industry}
          setIndustry={setIndustry}
          primaryLocation={primaryLocation}
          setPrimaryLocation={setPrimaryLocation}
          onSubmit={handleCreateWorkspace}
          onBack={() => setStep(2)}
          submitting={createTenant.isPending}
        />
      )}
    </AuthLayout>
  )
}

// ─── Step 1: Sign-up (build your workspace) ─────────────────────────────────

function SignupStep(props: {
  email: string
  setEmail: (v: string) => void
  firstName: string
  setFirstName: (v: string) => void
  lastName: string
  setLastName: (v: string) => void
  acceptedTerms: boolean
  setAcceptedTerms: (v: boolean) => void
  onSubmit: (e: React.FormEvent) => void
  submitting: boolean
}) {
  return (
    <AuthCard>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div className="t-display" style={{ fontSize: 32, marginBottom: 10 }}>
          Build your workspace
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-2)',
            lineHeight: 1.5,
          }}
        >
          HR for India&apos;s modern startups. Free for 14 days, no card needed.
        </div>
      </div>

      <form onSubmit={props.onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className="label">Work email</label>
          <input
            className="input"
            type="email"
            placeholder="you@company.com"
            value={props.email}
            onChange={(e) => props.setEmail(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label className="label">First name</label>
            <input
              className="input"
              placeholder="Asha"
              value={props.firstName}
              onChange={(e) => props.setFirstName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Last name</label>
            <input
              className="input"
              placeholder="Patel"
              value={props.lastName}
              onChange={(e) => props.setLastName(e.target.value)}
            />
          </div>
        </div>

        <label
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            marginTop: 4,
            fontSize: 12,
            color: 'var(--text-2)',
            lineHeight: 1.5,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={props.acceptedTerms}
            onChange={(e) => props.setAcceptedTerms(e.target.checked)}
            style={{ marginTop: 2, accentColor: 'var(--blue)' }}
          />
          <span>
            I agree to the{' '}
            <a href="#" style={{ color: 'var(--blue)', fontWeight: 700 }}>
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="#" style={{ color: 'var(--blue)', fontWeight: 700 }}>
              DPDP-aligned Privacy Policy
            </a>
            .
          </span>
        </label>

        <Btn
          kind="primary"
          type="submit"
          disabled={props.submitting}
          style={{ height: 48, fontSize: 14, marginTop: 6, width: '100%', justifyContent: 'center' }}
          iconRight={<Icon.arrow size={16} />}
        >
          {props.submitting ? 'Sending OTP…' : 'Send OTP & continue'}
        </Btn>
      </form>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          margin: '22px 0 16px',
        }}
      >
        <div style={{ flex: 1, height: 1, background: 'var(--bord)' }} />
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-faint)',
            fontWeight: 700,
            letterSpacing: '.06em',
            textTransform: 'uppercase',
          }}
        >
          or
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--bord)' }} />
      </div>

      <Btn
        kind="secondary"
        type="button"
        disabled
        style={{ width: '100%', height: 44, justifyContent: 'center' }}
        icon={
          <svg width="16" height="16" viewBox="0 0 48 48">
            <path
              fill="#FFC107"
              d="M43.6 20.1H42V20H24v8h11.3a12 12 0 11-3.4-13l5.7-5.7A20 20 0 1044 24a20 20 0 00-.4-3.9z"
            />
            <path
              fill="#FF3D00"
              d="M6.3 14.7l6.6 4.8A12 12 0 0124 16c3 0 5.8 1.2 7.9 3l5.7-5.7A20 20 0 006.3 14.7z"
            />
            <path
              fill="#4CAF50"
              d="M24 44a20 20 0 0013.5-5.2l-6.2-5.3A12 12 0 0112.7 28l-6.5 5A20 20 0 0024 44z"
            />
            <path
              fill="#1976D2"
              d="M43.6 20.1H42V20H24v8h11.3a12 12 0 01-4.1 5.5l6.2 5.3a20 20 0 006.6-15a20 20 0 00-.4-3.7z"
            />
          </svg>
        }
      >
        Continue with Google (soon)
      </Btn>

      <div
        style={{
          textAlign: 'center',
          marginTop: 22,
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-2)',
        }}
      >
        Already have an account?{' '}
        <Link
          href="/login"
          style={{ color: 'var(--blue)', fontWeight: 800, textDecoration: 'none' }}
        >
          Sign in
        </Link>
      </div>
    </AuthCard>
  )
}

// ─── Step 2: OTP verification ───────────────────────────────────────────────

function OtpStep(props: {
  email: string
  otp: string[]
  setOtp: (otp: string[]) => void
  onSubmit: (e: React.FormEvent) => void
  onBack: () => void
  onResend: () => void
  submitting: boolean
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])

  const handleChange = (i: number, value: string) => {
    const v = value.replace(/\D/g, '').slice(-1)
    const next = [...props.otp]
    next[i] = v
    props.setOtp(next)
    if (v && i < 5) refs.current[i + 1]?.focus()
  }

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !props.otp[i] && i > 0) {
      refs.current[i - 1]?.focus()
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus()
    } else if (e.key === 'ArrowRight' && i < 5) {
      refs.current[i + 1]?.focus()
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (text.length >= 6) {
      e.preventDefault()
      props.setOtp(text.split('').slice(0, 6))
      refs.current[5]?.focus()
    }
  }

  return (
    <AuthCard>
      <button
        type="button"
        onClick={props.onBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--text-mute)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          marginBottom: 16,
          padding: 0,
        }}
      >
        <Icon.arrowL size={14} /> Back
      </button>

      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div
          style={{
            width: 60,
            height: 60,
            margin: '0 auto 16px',
            borderRadius: 16,
            background: 'rgba(62, 123, 250, 0.12)',
            border: '1px solid rgba(62, 123, 250, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--blue)',
          }}
        >
          <Icon.mail size={26} />
        </div>
        <div className="t-h2" style={{ marginBottom: 8 }}>
          Check your email
        </div>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: 'var(--text-2)',
            lineHeight: 1.5,
          }}
        >
          We sent a 6-digit code to{' '}
          <strong style={{ color: '#fff' }}>{props.email}</strong>. The code
          expires in 10 minutes.
        </div>
      </div>

      <form onSubmit={props.onSubmit}>
        <div
          style={{
            display: 'flex',
            gap: 10,
            justifyContent: 'center',
            marginBottom: 20,
          }}
        >
          {props.otp.map((v, i) => (
            <input
              key={i}
              ref={(el) => {
                refs.current[i] = el
              }}
              value={v}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={handlePaste}
              inputMode="numeric"
              maxLength={1}
              autoFocus={i === 0}
              style={{
                width: 48,
                height: 60,
                textAlign: 'center',
                fontSize: 24,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                background: 'var(--surf-2)',
                border: `1.5px solid ${v ? 'rgba(62,123,250,.5)' : 'var(--bord)'}`,
                borderRadius: 12,
                outline: 'none',
                color: 'white',
                fontFamily: 'var(--font-mono)',
              }}
            />
          ))}
        </div>

        <Btn
          kind="primary"
          type="submit"
          disabled={props.submitting}
          style={{ width: '100%', height: 48, fontSize: 14, justifyContent: 'center' }}
          iconRight={<Icon.arrow size={16} />}
        >
          {props.submitting ? 'Verifying…' : 'Verify & continue'}
        </Btn>
      </form>

      <div
        style={{
          textAlign: 'center',
          marginTop: 18,
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--text-mute)',
        }}
      >
        Didn&apos;t get it?{' '}
        <button
          type="button"
          onClick={props.onResend}
          style={{
            color: 'var(--blue)',
            fontWeight: 800,
            cursor: 'pointer',
            background: 'none',
            border: 'none',
            padding: 0,
          }}
        >
          Resend code
        </button>
      </div>

      <div
        style={{
          marginTop: 22,
          padding: 14,
          background: 'rgba(62, 123, 250, 0.06)',
          border: '1px solid rgba(62, 123, 250, 0.2)',
          borderRadius: 10,
          display: 'flex',
          gap: 10,
        }}
      >
        <Icon.info
          size={16}
          style={{ color: 'var(--blue)', marginTop: 1, flexShrink: 0 }}
        />
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--text-2)',
            lineHeight: 1.5,
          }}
        >
          You can also{' '}
          <strong style={{ color: '#fff' }}>tap the magic link</strong> in the
          email to sign in instantly.
        </div>
      </div>
    </AuthCard>
  )
}

// ─── Step 3: Workspace setup ────────────────────────────────────────────────

function WorkspaceStep(props: {
  workspaceName: string
  setWorkspaceName: (v: string) => void
  slug: string
  setSlug: (v: string) => void
  slugAvailable: boolean | null
  slugChecking: boolean
  sizeBand: string
  setSizeBand: (v: string) => void
  industry: string
  setIndustry: (v: string) => void
  primaryLocation: string
  setPrimaryLocation: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  onBack: () => void
  submitting: boolean
}) {
  const slugStatus = useMemo(() => {
    if (!props.slug || props.slug.length < 3) return null
    if (props.slugChecking)
      return <span style={{ color: 'var(--text-mute)' }}>Checking…</span>
    if (props.slugAvailable === true)
      return <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓ Available</span>
    if (props.slugAvailable === false)
      return <span style={{ color: 'var(--coral)', fontWeight: 700 }}>Already taken</span>
    return null
  }, [props.slug, props.slugAvailable, props.slugChecking])

  return (
    <AuthCard width={560}>
      <div style={{ marginBottom: 28 }}>
        <div className="t-h1" style={{ marginBottom: 8 }}>
          Set up your company
        </div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>
          This becomes your tenant. You can invite teammates after.
        </div>
      </div>

      <form
        onSubmit={props.onSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div>
          <label className="label">Company name</label>
          <input
            className="input"
            placeholder="Acme Pvt Ltd"
            value={props.workspaceName}
            onChange={(e) => props.setWorkspaceName(e.target.value)}
            autoFocus
            required
            maxLength={100}
          />
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-mute)',
              marginTop: 6,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>
              Workspace URL:{' '}
              <span style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>
                {props.slug || 'your-workspace'}.flickssuite.com
              </span>
            </span>
            {slugStatus && <span style={{ fontSize: 11 }}>{slugStatus}</span>}
          </div>
        </div>

        <div>
          <label className="label">
            Workspace slug{' '}
            <span style={{ color: 'var(--text-faint)', fontWeight: 600, textTransform: 'none' }}>
              (lowercase, hyphens)
            </span>
          </label>
          <input
            className="input"
            placeholder="acme-corp"
            value={props.slug}
            onChange={(e) => props.setSlug(e.target.value)}
            required
            minLength={3}
            maxLength={50}
            pattern="[a-z0-9-]+"
            style={{ fontFamily: 'var(--font-mono)' }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label className="label">Team size</label>
            <select
              className="input"
              value={props.sizeBand}
              onChange={(e) => props.setSizeBand(e.target.value)}
            >
              {SIZE_BANDS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Industry</label>
            <select
              className="input"
              value={props.industry}
              onChange={(e) => props.setIndustry(e.target.value)}
            >
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Primary location</label>
          <input
            className="input"
            placeholder="Bengaluru, Karnataka"
            value={props.primaryLocation}
            onChange={(e) => props.setPrimaryLocation(e.target.value)}
            required
            maxLength={160}
          />
        </div>

        <div
          style={{
            marginTop: 8,
            padding: 14,
            background: 'rgba(39, 210, 128, 0.06)',
            border: '1px solid rgba(39, 210, 128, 0.2)',
            borderRadius: 10,
            display: 'flex',
            gap: 10,
          }}
        >
          <Icon.shield
            size={16}
            style={{ color: 'var(--green)', marginTop: 1, flexShrink: 0 }}
          />
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--text-2)',
              lineHeight: 1.5,
            }}
          >
            Your data is hosted in{' '}
            <strong style={{ color: '#fff' }}>Mumbai (ap-south-1)</strong>. DPDP
            2023 compliant by default.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <Btn kind="ghost" type="button" onClick={props.onBack} icon={<Icon.arrowL size={14} />}>
            Back
          </Btn>
          <div style={{ flex: 1 }} />
          <Btn
            kind="primary"
            type="submit"
            disabled={
              props.submitting ||
              props.slugAvailable === false ||
              !props.workspaceName ||
              !props.slug ||
              !props.primaryLocation
            }
            iconRight={<Icon.arrow size={16} />}
          >
            {props.submitting ? 'Creating workspace…' : 'Create workspace'}
          </Btn>
        </div>
      </form>
    </AuthCard>
  )
}
