'use client'

import { useState, useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowRight, RefreshCw, Mail, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { PageGlows } from '@/components/layout/PageGlows'
import { LogoMark } from '@/components/proto'
import { useRequestOtp, useVerifyOtp } from '@/lib/api/queries/use-auth'

const emailSchema = z.object({
  email: z.string().email('Enter a valid email address'),
})

const otpSchema = z.object({
  code: z
    .string()
    .length(6, 'Enter all 6 digits')
    .regex(/^\d{6}$/, 'Only digits allowed'),
})

type EmailForm = z.infer<typeof emailSchema>
type OtpForm = z.infer<typeof otpSchema>

export default function LoginPage() {
  const { toast } = useToast()
  const [step, setStep] = useState<'email' | 'otp'>('email')
  const [email, setEmail] = useState('')
  const [countdown, setCountdown] = useState(0)
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([])
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', ''])

  const requestOtp = useRequestOtp()
  const verifyOtp = useVerifyOtp()

  const emailForm = useForm<EmailForm>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: '' },
  })

  // Countdown for resend OTP
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  const handleEmailSubmit = emailForm.handleSubmit(async (data) => {
    try {
      await requestOtp.mutateAsync({ email: data.email })
      setEmail(data.email)
      setStep('otp')
      setCountdown(60)
      setTimeout(() => otpInputsRef.current[0]?.focus(), 100)
    } catch {
      toast({
        title: 'Something went wrong',
        description: 'Could not send OTP. Please try again.',
        variant: 'destructive',
      })
    }
  })

  const handleOtpInput = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return
    const newDigits = [...otpDigits]
    newDigits[index] = value.slice(-1)
    setOtpDigits(newDigits)

    // Auto-advance
    if (value && index < 5) {
      otpInputsRef.current[index + 1]?.focus()
    }

    // Auto-submit when all 6 entered
    if (newDigits.every((d) => d !== '')) {
      handleOtpSubmit(newDigits.join(''))
    }
  }

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpInputsRef.current[index - 1]?.focus()
    }
  }

  const handleOtpSubmit = async (code: string) => {
    try {
      await verifyOtp.mutateAsync({ email, code })
      // Hard navigation so the protected layout sees the fresh auth cookies
      // and useCurrentUser runs against a clean tree (router.push alone can
      // race with the cookie being committed to the jar).
      window.location.assign('/dashboard')
    } catch {
      toast({
        title: 'Invalid code',
        description: 'The OTP is incorrect or has expired. Try again.',
        variant: 'destructive',
      })
      setOtpDigits(['', '', '', '', '', ''])
      otpInputsRef.current[0]?.focus()
    }
  }

  const handleResend = async () => {
    try {
      await requestOtp.mutateAsync({ email })
      setCountdown(60)
      setOtpDigits(['', '', '', '', '', ''])
      toast({ title: 'Code sent', description: `New OTP sent to ${email}` })
    } catch {
      toast({ title: 'Failed to resend', variant: 'destructive' })
    }
  }

  return (
    <div className="relative min-h-screen bg-brand-bg flex items-center justify-center overflow-hidden">
      <PageGlows variant="auth" />

      <div className="relative z-10 w-full max-w-md px-4">
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <div className="inline-flex items-center gap-3 mb-6">
            <LogoMark size={40} />
            <span className="text-2xl font-bold text-white tracking-tight">
              flicks<span className="text-brand-blue">.</span>
            </span>
          </div>
          <p className="text-brand-muted text-sm">HR that works at startup speed</p>
        </motion.div>

        {/* Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="glass rounded-xl p-8"
        >
          <AnimatePresence mode="wait">
            {step === 'email' ? (
              <motion.div
                key="email-step"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <h1 className="text-2xl font-bold text-white mb-2">Sign in</h1>
                <p className="text-brand-muted text-sm mb-8">
                  Enter your work email — we'll send a one-time code
                </p>

                <form onSubmit={handleEmailSubmit} className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-white/70 text-sm">
                      Work email
                    </Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@company.com"
                        className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-brand-blue focus:ring-brand-blue/20 h-12"
                        autoFocus
                        {...emailForm.register('email')}
                      />
                    </div>
                    {emailForm.formState.errors.email && (
                      <p className="text-brand-coral text-xs">
                        {emailForm.formState.errors.email.message}
                      </p>
                    )}
                  </div>

                  <Button
                    type="submit"
                    className="w-full h-12 bg-brand-blue hover:bg-brand-blue/90 text-white font-semibold shadow-glow-blue transition-all"
                    disabled={requestOtp.isPending}
                  >
                    {requestOtp.isPending ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        Continue
                        <ArrowRight className="w-4 h-4 ml-2" />
                      </>
                    )}
                  </Button>
                </form>

                <p className="text-center text-brand-muted text-xs mt-6">
                  By continuing, you agree to our{' '}
                  <a href="/terms" className="text-white/60 hover:text-white underline">
                    Terms
                  </a>{' '}
                  and{' '}
                  <a href="/privacy" className="text-white/60 hover:text-white underline">
                    Privacy Policy
                  </a>
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="otp-step"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 bg-brand-green/20 rounded-full flex items-center justify-center">
                    <Shield className="w-4 h-4 text-brand-green" />
                  </div>
                  <h1 className="text-2xl font-bold text-white">Check your inbox</h1>
                </div>
                <p className="text-brand-muted text-sm mb-8">
                  We sent a 6-digit code to{' '}
                  <span className="text-white font-medium">{email}</span>
                </p>

                {/* OTP Input */}
                <div className="flex gap-3 justify-center mb-8">
                  {otpDigits.map((digit, i) => (
                    <input
                      key={i}
                      ref={(el) => { otpInputsRef.current[i] = el }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleOtpInput(i, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(i, e)}
                      className={[
                        'w-12 h-14 text-center text-xl font-bold rounded-lg',
                        'bg-white/5 border-2 text-white',
                        'focus:outline-none focus:ring-0 transition-all',
                        digit
                          ? 'border-brand-blue shadow-glow-blue'
                          : 'border-white/10 focus:border-brand-blue/50',
                      ].join(' ')}
                    />
                  ))}
                </div>

                {verifyOtp.isPending && (
                  <div className="text-center text-brand-muted text-sm mb-4 flex items-center justify-center gap-2">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    Verifying...
                  </div>
                )}

                <div className="flex items-center justify-between text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      setStep('email')
                      setOtpDigits(['', '', '', '', '', ''])
                    }}
                    className="text-brand-muted hover:text-white transition-colors"
                  >
                    ← Change email
                  </button>

                  {countdown > 0 ? (
                    <span className="text-brand-muted">Resend in {countdown}s</span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleResend}
                      className="text-brand-blue hover:text-brand-blue/80 transition-colors"
                      disabled={requestOtp.isPending}
                    >
                      Resend code
                    </button>
                  )}
                </div>

                <p className="text-brand-muted text-xs mt-6 text-center">
                  You can also use the magic link in your email for instant sign-in
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  )
}
