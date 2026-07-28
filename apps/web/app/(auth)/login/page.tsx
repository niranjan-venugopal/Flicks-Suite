'use client'

import { useState, useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { Btn, Icon } from '@/components/proto'
import { useRequestOtp, useVerifyOtp, useCompleteTotp } from '@/lib/api/queries/use-auth'
import { APIError } from '@/lib/api/client'

const emailSchema = z.object({
  email: z.string().email('Enter a valid email address'),
})
type EmailForm = z.infer<typeof emailSchema>

export default function LoginPage() {
  const { toast } = useToast()
  const [step, setStep] = useState<'email' | 'otp' | 'totp'>('email')
  const [email, setEmail] = useState('')
  const [countdown, setCountdown] = useState(0)
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([])
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', ''])
  const [challengeToken, setChallengeToken] = useState('')
  const [totpCode, setTotpCode] = useState('')

  const router = useRouter()
  const requestOtp = useRequestOtp()
  const verifyOtp = useVerifyOtp()
  const completeTotp = useCompleteTotp()

  const emailForm = useForm<EmailForm>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: '' },
  })

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  const handleEmailSubmit = emailForm.handleSubmit(async (data) => {
    try {
      await requestOtp.mutateAsync({ email: data.email, intent: 'signin' })
      setEmail(data.email)
      setStep('otp')
      setCountdown(60)
      setTimeout(() => otpInputsRef.current[0]?.focus(), 100)
    } catch (e) {
      // Unregistered email → push to signup with the email prefilled (the
      // server sent NO code — accepted Slack/Notion-style behavior).
      if (e instanceof APIError && (e.data as { code?: string } | undefined)?.code === 'NOT_REGISTERED') {
        router.push(`/onboarding?email=${encodeURIComponent(data.email)}&reason=unregistered`)
        return
      }
      toast({
        title: 'Could not send the code',
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      })
    }
  })

  const handleOtpInput = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return
    const next = [...otpDigits]
    next[index] = value.slice(-1)
    setOtpDigits(next)
    if (value && index < 5) otpInputsRef.current[index + 1]?.focus()
    if (next.every((d) => d !== '')) handleOtpSubmit(next.join(''))
  }

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpInputsRef.current[index - 1]?.focus()
    }
  }

  const handleOtpSubmit = async (code: string) => {
    try {
      const result = await verifyOtp.mutateAsync({ email, code })
      if (result.requiresTotp && result.challengeToken) {
        setChallengeToken(result.challengeToken)
        setTotpCode('')
        setStep('totp')
        return
      }
      if (result.requiresTotpEnrollment) {
        window.location.assign('/totp-setup')
        return
      }
      window.location.assign('/dashboard')
    } catch {
      toast({
        title: 'Invalid code',
        description: 'The code is incorrect or has expired. Try again.',
        variant: 'destructive',
      })
      setOtpDigits(['', '', '', '', '', ''])
      otpInputsRef.current[0]?.focus()
    }
  }

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(totpCode)) {
      toast({ title: 'Enter the 6-digit code', variant: 'destructive' })
      return
    }
    try {
      await completeTotp.mutateAsync({ challengeToken, code: totpCode })
      window.location.assign('/fam/overview')
    } catch {
      toast({
        title: 'Invalid authentication code',
        description: 'Check your authenticator app and try again.',
        variant: 'destructive',
      })
      setTotpCode('')
    }
  }

  const handleResend = async () => {
    try {
      await requestOtp.mutateAsync({ email, intent: 'signin' })
      setCountdown(60)
      setOtpDigits(['', '', '', '', '', ''])
      toast({ title: 'Code sent', description: `New code sent to ${email}` })
    } catch {
      toast({ title: 'Failed to resend', variant: 'destructive' })
    }
  }

  // ─── Email step ──────────────────────────────────────────────────────────
  if (step === 'email') {
    return (
      <AuthLayout>
        <AuthCard>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div className="t-h1" style={{ marginBottom: 8 }}>Welcome back</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>
              Sign in to your Flicks Suite workspace.
            </div>
          </div>

          <form onSubmit={handleEmailSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label className="label">Work email</label>
              <input
                className="input"
                type="email"
                placeholder="you@company.com"
                autoFocus
                {...emailForm.register('email')}
              />
              {emailForm.formState.errors.email && (
                <div style={{ fontSize: 11.5, color: 'var(--coral)', marginTop: 6 }}>
                  {emailForm.formState.errors.email.message}
                </div>
              )}
            </div>
            <Btn
              kind="primary"
              type="submit"
              disabled={requestOtp.isPending}
              style={{ height: 48, fontSize: 14 }}
              iconRight={<Icon.arrow size={16} />}
            >
              {requestOtp.isPending ? 'Sending…' : 'Send code & continue'}
            </Btn>
          </form>

          <div style={{ textAlign: 'center', marginTop: 22, fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>
            New to Flicks?{' '}
            <Link href="/onboarding" style={{ color: 'var(--blue)', fontWeight: 800 }}>
              Create a workspace
            </Link>
          </div>
        </AuthCard>
      </AuthLayout>
    )
  }

  // ─── TOTP step (FAM second factor) ────────────────────────────────────────
  if (step === 'totp') {
    return (
      <AuthLayout>
        <AuthCard>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div
              style={{
                width: 60, height: 60, margin: '0 auto 16px', borderRadius: 16,
                background: 'rgba(155,123,250,.12)', border: '1px solid rgba(155,123,250,.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--purple)',
              }}
            >
              <Icon.shield size={26} />
            </div>
            <div className="t-h2" style={{ marginBottom: 8 }}>Two-factor authentication</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
              Enter the 6-digit code from your authenticator app to finish signing in.
            </div>
          </div>

          <form onSubmit={handleTotpSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <input
              className="input"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              style={{ textAlign: 'center', letterSpacing: '0.5em', fontSize: 20, height: 56 }}
            />
            <Btn
              kind="primary"
              type="submit"
              disabled={completeTotp.isPending}
              style={{ height: 48, fontSize: 14 }}
              iconRight={<Icon.arrow size={16} />}
            >
              {completeTotp.isPending ? 'Verifying…' : 'Verify & continue'}
            </Btn>
          </form>
        </AuthCard>
      </AuthLayout>
    )
  }

  // ─── OTP step ──────────────────────────────────────────────────────────────
  return (
    <AuthLayout>
      <AuthCard>
        <button
          type="button"
          onClick={() => { setStep('email'); setOtpDigits(['', '', '', '', '', '']) }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700,
            color: 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 16,
          }}
        >
          ← Change email
        </button>

        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              width: 60, height: 60, margin: '0 auto 16px', borderRadius: 16,
              background: 'rgba(62,123,250,.12)', border: '1px solid rgba(62,123,250,.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--blue)',
            }}
          >
            <Icon.mail size={26} />
          </div>
          <div className="t-h2" style={{ marginBottom: 8 }}>Check your email</div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
            We sent a 6-digit code to <strong style={{ color: '#fff' }}>{email}</strong>. The code expires in 10 minutes.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 20 }}>
          {otpDigits.map((digit, i) => (
            <input
              key={i}
              ref={(el) => { otpInputsRef.current[i] = el }}
              value={digit}
              inputMode="numeric"
              maxLength={1}
              onChange={(e) => handleOtpInput(i, e.target.value)}
              onKeyDown={(e) => handleOtpKeyDown(i, e)}
              style={{
                width: 48, height: 60, textAlign: 'center', fontSize: 24, fontWeight: 800,
                letterSpacing: '-0.02em', color: '#fff', background: 'var(--surf-2)',
                border: `1.5px solid ${digit ? 'rgba(62,123,250,.5)' : 'var(--bord)'}`,
                borderRadius: 12, outline: 'none', transition: 'border-color .2s',
              }}
            />
          ))}
        </div>

        {verifyOtp.isPending && (
          <div style={{ textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: 'var(--text-mute)', marginBottom: 14 }}>
            Verifying…
          </div>
        )}

        <div style={{ textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: 'var(--text-mute)' }}>
          Didn&apos;t get it?{' '}
          {countdown > 0 ? (
            <span>Resend in 0:{String(countdown).padStart(2, '0')}</span>
          ) : (
            <a
              onClick={handleResend}
              style={{ color: 'var(--blue)', fontWeight: 800, cursor: 'pointer' }}
            >
              Resend code
            </a>
          )}
        </div>

        <div
          style={{
            marginTop: 22, padding: 14, background: 'rgba(62,123,250,.06)',
            border: '1px solid rgba(62,123,250,.2)', borderRadius: 10, display: 'flex', gap: 10,
          }}
        >
          <Icon.info size={16} style={{ color: 'var(--blue)', marginTop: 1, flexShrink: 0 }} />
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
            You can also <strong style={{ color: '#fff' }}>tap the magic link</strong> in the email to sign in instantly.
          </div>
        </div>
      </AuthCard>
    </AuthLayout>
  )
}
