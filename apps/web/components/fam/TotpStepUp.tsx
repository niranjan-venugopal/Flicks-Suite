'use client'

import { useState } from 'react'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { Btn, Icon } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { useLogout, useStepUpTotp } from '@/lib/api/queries/use-auth'

/**
 * Round R R2 — the console's second-factor step-up. An enrolled platform
 * admin whose session was issued without the authenticator (signed in before
 * two-factor was enforced, or before this release) proves the code here; the
 * server re-issues the session with the mfa claim and the console opens.
 * No sign-out, no redirect — the loop a "sign in again" bounce would cause
 * (the sign-in page sends an authenticated person straight back) never starts.
 */
export function TotpStepUp({ onDone }: { onDone: () => void }) {
  const { toast } = useToast()
  const stepUp = useStepUpTotp()
  const logout = useLogout()
  const [code, setCode] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) {
      toast({ title: 'Enter the 6-digit code', variant: 'destructive' })
      return
    }
    try {
      await stepUp.mutateAsync(code)
      onDone()
    } catch (err) {
      toast({
        title: 'That code did not work',
        description: err instanceof Error ? err.message : 'Check your authenticator app and try again.',
        variant: 'destructive',
      })
      setCode('')
    }
  }

  return (
    <AuthLayout>
      <AuthCard>
        <div style={{ textAlign: 'center', marginBottom: 24 }} data-testid="totp-step-up">
          <div
            style={{
              width: 60, height: 60, margin: '0 auto 16px', borderRadius: 16,
              background: 'rgba(155,123,250,.12)', border: '1px solid rgba(155,123,250,.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--purple)',
            }}
          >
            <Icon.shield size={26} />
          </div>
          <div className="t-h2" style={{ marginBottom: 8 }}>Finish two-factor</div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
            This session signed in without your authenticator. Enter the 6-digit code it shows now to open the console — you stay signed in.
          </div>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            autoFocus
            style={{ textAlign: 'center', letterSpacing: '0.5em', fontSize: 20, height: 56 }}
            data-testid="totp-step-up-code"
          />
          <Btn
            kind="primary"
            type="submit"
            disabled={stepUp.isPending || code.length !== 6}
            style={{ height: 48, fontSize: 14 }}
            iconRight={<Icon.arrow size={16} />}
            data-testid="totp-step-up-submit"
          >
            {stepUp.isPending ? 'Verifying…' : 'Verify & continue'}
          </Btn>
        </form>
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          style={{
            marginTop: 14, background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-mute)', fontSize: 12, fontWeight: 600, width: '100%',
            textAlign: 'center', textDecoration: 'underline',
          }}
        >
          Lost your authenticator? Sign out and use a backup code at sign-in
        </button>
      </AuthCard>
    </AuthLayout>
  )
}
