'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Copy, Check } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { Btn, Icon } from '@/components/proto'
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
          <div className="t-h2" style={{ marginBottom: 8 }}>Set up two-factor</div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
            Platform admin accounts require an authenticator app. Add this secret to
            Google Authenticator, 1Password, or Authy, then enter the 6-digit code to confirm.
          </div>
        </div>

        {enroll.isPending && !secret ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0', color: 'var(--text-mute)' }}>
            <RefreshCw className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 18 }}>
              <label className="label">Setup key</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code
                  style={{
                    flex: 1, background: 'var(--surf-2)', border: '1px solid var(--bord)',
                    borderRadius: 'var(--r-sm)', padding: '12px 14px', color: '#fff',
                    fontFamily: 'var(--font-mono)', fontSize: 13, wordBreak: 'break-all',
                  }}
                >
                  {secret || '—'}
                </code>
                <Btn
                  kind="secondary"
                  onClick={copySecret}
                  icon={copied ? <Check className="w-4 h-4" style={{ color: 'var(--green)' }} /> : <Copy className="w-4 h-4" />}
                  aria-label="Copy setup key"
                  style={{ height: 44, width: 44 }}
                />
              </div>
            </div>

            <form onSubmit={handleConfirm} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <input
                className="input"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                style={{ textAlign: 'center', letterSpacing: '0.5em', fontSize: 20, height: 56 }}
              />
              <Btn
                kind="primary"
                type="submit"
                disabled={confirm.isPending || !secret}
                style={{ height: 48, fontSize: 14 }}
                iconRight={<Icon.arrow size={16} />}
              >
                {confirm.isPending ? 'Enabling…' : 'Enable two-factor'}
              </Btn>
            </form>
          </>
        )}
      </AuthCard>
    </AuthLayout>
  )
}
