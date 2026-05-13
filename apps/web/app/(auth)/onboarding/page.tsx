'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LogoMark } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { PageGlows } from '@/components/layout/PageGlows'
import { useDebounce } from '@/lib/hooks/use-debounce'
import { useRequestOtp, useVerifyOtp } from '@/lib/api/queries/use-auth'
import { useCheckSlug, useCreateTenant } from '@/lib/api/queries/use-onboarding'

// ─── Static option sets ─────────────────────────────────────────────────────

const SIZE_BANDS = ['1–10', '11–50', '51–200', '201–500', '500+'] as const

const INDUSTRIES = [
  'Technology',
  'SaaS / Software',
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

const STATE_CODES = [
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN',
  'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD',
  'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OR', 'PB', 'PY', 'RJ',
  'SK', 'TN', 'TR', 'TS', 'UK', 'UP', 'WB',
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

  // Form state across all steps
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [workspaceName, setWorkspaceName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null)
  const [sizeBand, setSizeBand] = useState<string>('11–50')
  const [industry, setIndustry] = useState<string>('Technology')
  const [locationName, setLocationName] = useState('')
  const [locationCity, setLocationCity] = useState('')
  const [locationState, setLocationState] = useState<string>('')
  const [acceptedTerms, setAcceptedTerms] = useState(true)

  // Mutations
  const requestOtp = useRequestOtp()
  const verifyOtp = useVerifyOtp()
  const checkSlug = useCheckSlug()
  const createTenant = useCreateTenant()

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

  // ─── Step 1: send OTP ─────────────────────────────────────────────────
  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !fullName.trim()) {
      toast({ title: 'Enter your email and name', variant: 'destructive' })
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

  // ─── Step 2: verify OTP ───────────────────────────────────────────────
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
      // verify-otp returns the JWT cookie + user. If the user already has a
      // tenant, the response includes membership info and we should bounce
      // to /dashboard. Otherwise advance to step 3.
      setStep(3)
    } catch (e: any) {
      toast({
        title: 'Invalid code',
        description: e?.message ?? 'Try again or request a new code',
        variant: 'destructive',
      })
    }
  }

  // ─── Step 3: create workspace ─────────────────────────────────────────
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
      toast({ title: 'That URL is taken', description: 'Choose a different slug.', variant: 'destructive' })
      return
    }
    if (!locationName.trim()) {
      toast({ title: 'Add a primary location', variant: 'destructive' })
      return
    }
    try {
      await createTenant.mutateAsync({
        name: workspaceName.trim(),
        slug,
        fullName: fullName.trim(),
        industry,
        sizeBand,
        primaryLocation: {
          name: locationName.trim(),
          city: locationCity.trim() || undefined,
          stateCode: locationState || undefined,
          timezone: 'Asia/Kolkata',
        },
      })
      toast({
        title: 'Workspace ready',
        description: `Welcome to ${workspaceName.trim()}!`,
      })
      // Small delay so the toast renders before the route change tears it down.
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
    <div className="relative min-h-screen bg-brand-bg flex items-center justify-center overflow-hidden">
      <PageGlows />

      <div className="relative z-10 w-full max-w-xl px-4 py-12">
        {/* Logo + step counter */}
        <div className="flex items-center justify-between mb-8">
          <div className="inline-flex items-center gap-2">
            <LogoMark size={36} />
            <span className="text-xl font-bold text-white">flicks<span className="text-brand-blue">.</span></span>
          </div>
          <div className="t-caption" style={{ fontSize: 11 }}>
            Step {step} of 3 · Sign up
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 32 }}>
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 99,
                background: s <= step ? 'var(--blue)' : 'var(--surf-2)',
                transition: 'background 200ms',
              }}
            />
          ))}
        </div>

        {step === 1 && (
          <SignupStep
            email={email}
            setEmail={setEmail}
            fullName={fullName}
            setFullName={setFullName}
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
            locationName={locationName}
            setLocationName={setLocationName}
            locationCity={locationCity}
            setLocationCity={setLocationCity}
            locationState={locationState}
            setLocationState={setLocationState}
            onSubmit={handleCreateWorkspace}
            onBack={() => setStep(2)}
            submitting={createTenant.isPending}
          />
        )}

        <div className="text-center mt-6">
          <Link href="/login" className="text-xs text-brand-muted hover:text-white">
            Already have a workspace? <span className="text-brand-blue font-semibold">Sign in</span>
          </Link>
        </div>
      </div>
    </div>
  )
}

// ─── Step 1: Signup ─────────────────────────────────────────────────────────

function SignupStep(props: {
  email: string
  setEmail: (v: string) => void
  fullName: string
  setFullName: (v: string) => void
  acceptedTerms: boolean
  setAcceptedTerms: (v: boolean) => void
  onSubmit: (e: React.FormEvent) => void
  submitting: boolean
}) {
  return (
    <form onSubmit={props.onSubmit} className="card p-8 space-y-5">
      <div className="text-center mb-2">
        <div className="t-h1" style={{ fontSize: 28, marginBottom: 8 }}>
          Build your workspace
        </div>
        <p className="t-mute" style={{ fontSize: 13 }}>
          HR for India&apos;s modern startups. Free for 14 days · no card required.
        </p>
      </div>

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

      <div>
        <label className="label">Your full name</label>
        <input
          className="input"
          placeholder="Asha Patel"
          value={props.fullName}
          onChange={(e) => props.setFullName(e.target.value)}
          required
        />
      </div>

      <label className="flex items-start gap-2 text-xs text-brand-muted leading-relaxed cursor-pointer">
        <input
          type="checkbox"
          checked={props.acceptedTerms}
          onChange={(e) => props.setAcceptedTerms(e.target.checked)}
          className="mt-0.5"
          style={{ accentColor: 'var(--blue)' }}
        />
        <span>
          I agree to the{' '}
          <a href="#" className="text-brand-blue font-semibold">Terms of Service</a>{' '}
          and{' '}
          <a href="#" className="text-brand-blue font-semibold">DPDP-aligned Privacy Policy</a>.
        </span>
      </label>

      <button
        type="submit"
        disabled={props.submitting}
        className="btn btn-primary w-full"
        style={{ height: 48, fontSize: 14 }}
      >
        {props.submitting ? 'Sending OTP…' : 'Send OTP & continue →'}
      </button>
    </form>
  )
}

// ─── Step 2: OTP ─────────────────────────────────────────────────────────────

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
    <form onSubmit={props.onSubmit} className="card p-8 space-y-6">
      <button
        type="button"
        onClick={props.onBack}
        className="flex items-center gap-1.5 text-xs text-brand-muted hover:text-white font-semibold"
      >
        ← Back
      </button>

      <div className="text-center">
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
            fontSize: 24,
          }}
        >
          ✉
        </div>
        <div className="t-h1" style={{ fontSize: 24, marginBottom: 6 }}>
          Check your inbox
        </div>
        <p className="t-mute" style={{ fontSize: 13 }}>
          We sent a 6-digit code to{' '}
          <span className="text-white font-semibold">{props.email}</span>.
          The code expires in 10 minutes.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
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
            }}
          />
        ))}
      </div>

      <button
        type="submit"
        disabled={props.submitting}
        className="btn btn-primary w-full"
        style={{ height: 48, fontSize: 14 }}
      >
        {props.submitting ? 'Verifying…' : 'Verify & continue →'}
      </button>

      <div className="text-center text-xs text-brand-muted">
        Didn&apos;t get it?{' '}
        <button
          type="button"
          onClick={props.onResend}
          className="text-brand-blue font-semibold hover:underline"
        >
          Send another code
        </button>
      </div>

      <div
        style={{
          padding: 14,
          background: 'rgba(62, 123, 250, 0.06)',
          border: '1px solid rgba(62, 123, 250, 0.2)',
          borderRadius: 10,
          display: 'flex',
          gap: 10,
          fontSize: 11.5,
          color: 'var(--text-2)',
          lineHeight: 1.5,
        }}
      >
        <span style={{ color: 'var(--blue)', flexShrink: 0 }}>ℹ</span>
        <span>
          You can also tap the <strong className="text-white">magic link</strong> in the email
          to sign in without entering the code.
        </span>
      </div>
    </form>
  )
}

// ─── Step 3: Workspace ───────────────────────────────────────────────────────

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
  locationName: string
  setLocationName: (v: string) => void
  locationCity: string
  setLocationCity: (v: string) => void
  locationState: string
  setLocationState: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  onBack: () => void
  submitting: boolean
}) {
  const slugStatus = useMemo(() => {
    if (!props.slug || props.slug.length < 3) return null
    if (props.slugChecking)
      return <span className="text-brand-muted text-xs">Checking…</span>
    if (props.slugAvailable === true)
      return <span className="text-brand-green text-xs font-semibold">✓ Available</span>
    if (props.slugAvailable === false)
      return <span className="text-brand-coral text-xs font-semibold">Already taken</span>
    return null
  }, [props.slug, props.slugAvailable, props.slugChecking])

  return (
    <form onSubmit={props.onSubmit} className="card p-8 space-y-5">
      <div>
        <div className="t-h1" style={{ fontSize: 24, marginBottom: 6 }}>
          Set up your company
        </div>
        <p className="t-mute" style={{ fontSize: 13 }}>
          This becomes your tenant. You can invite teammates and configure
          everything else from settings later.
        </p>
      </div>

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
        <p className="text-xs text-brand-muted mt-2">
          Workspace URL:{' '}
          <span className="text-white font-mono">
            {props.slug || 'your-workspace'}.flickssuite.com
          </span>
        </p>
      </div>

      <div>
        <div className="flex justify-between items-center mb-1">
          <label className="label">Workspace URL</label>
          {slugStatus}
        </div>
        <input
          className="input font-mono"
          placeholder="acme-corp"
          value={props.slug}
          onChange={(e) => props.setSlug(e.target.value)}
          required
          minLength={3}
          maxLength={50}
          pattern="[a-z0-9-]+"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
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

      <div
        style={{
          marginTop: 6,
          paddingTop: 14,
          borderTop: '1px solid var(--bord)',
        }}
      >
        <div className="t-caption" style={{ fontSize: 11, marginBottom: 12 }}>
          Primary location
        </div>
        <div>
          <label className="label">Office name</label>
          <input
            className="input"
            placeholder="Bengaluru HQ"
            value={props.locationName}
            onChange={(e) => props.setLocationName(e.target.value)}
            required
            maxLength={160}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className="label">City</label>
            <input
              className="input"
              placeholder="Bengaluru"
              value={props.locationCity}
              onChange={(e) => props.setLocationCity(e.target.value)}
              maxLength={80}
            />
          </div>
          <div>
            <label className="label">State</label>
            <select
              className="input"
              value={props.locationState}
              onChange={(e) => props.setLocationState(e.target.value)}
            >
              <option value="">Select…</option>
              {STATE_CODES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div
        style={{
          padding: 12,
          background: 'rgba(39, 210, 128, 0.06)',
          border: '1px solid rgba(39, 210, 128, 0.2)',
          borderRadius: 10,
          display: 'flex',
          gap: 10,
          fontSize: 11.5,
          color: 'var(--text-2)',
          lineHeight: 1.5,
        }}
      >
        <span style={{ color: 'var(--green)', flexShrink: 0 }}>✓</span>
        <span>
          Your data lives in <strong className="text-white">Mumbai (ap-south-1)</strong>{' '}
          and is DPDP 2023 compliant by default.
        </span>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={props.onBack}
          className="btn btn-ghost"
        >
          Back
        </button>
        <div className="flex-1" />
        <button
          type="submit"
          disabled={
            props.submitting ||
            props.slugAvailable === false ||
            !props.workspaceName ||
            !props.slug ||
            !props.locationName
          }
          className="btn btn-primary"
          style={{ height: 44 }}
        >
          {props.submitting ? 'Creating workspace…' : 'Create workspace →'}
        </button>
      </div>
    </form>
  )
}
