'use client'

import { useEffect, useState } from 'react'
import { Shield, RefreshCw, ArrowRight, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { PageGlows } from '@/components/layout/PageGlows'
import { LogoMark } from '@/components/proto'
import { useEnrollTotp, useConfirmTotp } from '@/lib/api/queries/use-auth'

export default function TotpSetupPage() {
  const { toast } = useToast()
  const enroll = useEnrollTotp()
  const confirm = useConfirmTotp()
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)

  // Generate a secret on mount. The user is already authenticated here
  // (FAM first-login grants a session before TOTP enrolment).
  useEffect(() => {
    enroll
      .mutateAsync()
      .then((d) => setSecret(d.secret))
      .catch(() =>
        toast({
          title: 'Could not start setup',
          description: 'Please reload and try again.',
          variant: 'destructive',
        }),
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable; the secret is shown for manual copy */
    }
  }

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) {
      toast({ title: 'Enter the 6-digit code', variant: 'destructive' })
      return
    }
    try {
      await confirm.mutateAsync(code)
      toast({ title: 'Two-factor enabled' })
      window.location.assign('/fam/overview')
    } catch {
      toast({
        title: 'Invalid code',
        description: 'Check your authenticator app and try again.',
        variant: 'destructive',
      })
      setCode('')
    }
  }

  return (
    <div className="relative min-h-screen bg-brand-bg flex items-center justify-center overflow-hidden">
      <PageGlows variant="auth" />
      <div className="relative z-10 w-full max-w-md px-4">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <LogoMark size={36} />
            <span className="text-xl font-bold text-white tracking-tight">
              flicks<span className="text-brand-blue">.</span>
            </span>
          </div>
        </div>

        <div className="glass rounded-xl p-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 bg-brand-purple/20 rounded-full flex items-center justify-center">
              <Shield className="w-4 h-4 text-brand-purple" />
            </div>
            <h1 className="text-2xl font-bold text-white">Set up two-factor</h1>
          </div>
          <p className="text-brand-muted text-sm mb-6">
            Platform admin accounts require an authenticator app. Add this
            secret to Google Authenticator, 1Password, or Authy, then enter the
            6-digit code to confirm.
          </p>

          {enroll.isPending && !secret ? (
            <div className="flex items-center justify-center py-8 text-brand-muted">
              <RefreshCw className="w-5 h-5 animate-spin" />
            </div>
          ) : (
            <>
              <div className="mb-6">
                <div className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-2">
                  Setup key
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-3 text-white font-mono text-sm break-all">
                    {secret || '—'}
                  </code>
                  <button
                    type="button"
                    onClick={copySecret}
                    className="shrink-0 w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/60 hover:text-white transition-colors"
                    aria-label="Copy setup key"
                  >
                    {copied ? (
                      <Check className="w-4 h-4 text-brand-green" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <form onSubmit={handleConfirm} className="space-y-5">
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  placeholder="123456"
                  className="text-center tracking-[0.5em] text-xl bg-white/5 border-white/10 text-white h-14"
                />
                <Button
                  type="submit"
                  className="w-full h-12 bg-brand-blue hover:bg-brand-blue/90 text-white font-semibold"
                  disabled={confirm.isPending || !secret}
                >
                  {confirm.isPending ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      Enable two-factor
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </>
                  )}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
