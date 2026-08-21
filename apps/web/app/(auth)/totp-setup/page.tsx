'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Copy, Check } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useToast } from '@/components/ui/use-toast'
import { AuthLayout, AuthCard } from '@/components/layout/AuthLayout'
import { Btn, Icon } from '@/components/proto'
import { useEnrollTotp, useConfirmTotp } from '@/lib/api/queries/use-auth'

export default function TotpSetupPage() {
  const { toast } = useToast()
  const enroll = useEnrollTotp()
  const confirm = useConfirmTotp()
  const [secret, setSecret] = useState('')
  const [otpauthUrl, setOtpauthUrl] = useState('')
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  // Post-confirm step: the 10 single-use backup codes, shown exactly once.
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  const [codesCopied, setCodesCopied] = useState(false)

  // Fetch the pending secret on mount. The server is idempotent — reloading
  // this page returns the SAME secret, so an authenticator entry added on a
  // previous visit stays valid.
  useEffect(() => {
    enroll
      .mutateAsync(undefined)
      .then((d) => {
        setSecret(d.secret)
        setOtpauthUrl(d.otpauthUrl)
      })
      .catch((e: unknown) => {
        const status = (e as { status?: number })?.status
        if (status === 409) {
          // Already enrolled — this page has nothing to do; the login flow
          // asks for the authenticator code instead.
          toast({ title: 'Two-factor is already set up', description: 'Sign in with your authenticator code.' })
          window.location.assign('/login')
          return
        }
        toast({
          title: 'Could not start setup',
          description: 'Please reload and try again.',
          variant: 'destructive',
        })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const regenerate = async () => {
    try {
      const d = await enroll.mutateAsync({ regenerate: true })
      setSecret(d.secret)
      setOtpauthUrl(d.otpauthUrl)
      setCode('')
      toast({
        title: 'New key generated',
        description: 'Remove the old Flicks Suite entry from your authenticator and add this one.',
      })
    } catch {
      toast({ title: 'Could not generate a new key', variant: 'destructive' })
    }
  }

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable; the secret is shown for manual copy */
    }
  }

  const copyBackupCodes = async () => {
    if (!backupCodes) return
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'))
      setCodesCopied(true)
      setTimeout(() => setCodesCopied(false), 1500)
    } catch {
      /* shown on screen for manual copy */
    }
  }

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) {
      toast({ title: 'Enter the 6-digit code', variant: 'destructive' })
      return
    }
    try {
      const res = await confirm.mutateAsync(code)
      setBackupCodes(res.backupCodes ?? [])
      toast({ title: 'Two-factor enabled' })
    } catch {
      toast({
        title: 'Invalid code',
        description:
          'Check your authenticator app and try again. If you added the key a while ago, generate a new key below and re-add it.',
        variant: 'destructive',
      })
      setCode('')
    }
  }

  // ── Step 2: backup codes (shown exactly once after confirmation) ──────────
  if (backupCodes) {
    return (
      <AuthLayout>
        <AuthCard>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div
              style={{
                width: 60, height: 60, margin: '0 auto 16px', borderRadius: 16,
                background: 'rgba(39,210,128,.12)', border: '1px solid rgba(39,210,128,.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--green)',
              }}
            >
              <Icon.check size={26} />
            </div>
            <div className="t-h2" style={{ marginBottom: 8 }}>Save your backup codes</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
              Each code signs you in once if you lose access to your authenticator app.
              They are shown only this once — store them in your password manager.
            </div>
          </div>

          <div
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8,
              background: 'var(--surf-2)', border: '1px solid var(--bord)',
              borderRadius: 'var(--r-sm)', padding: 14, marginBottom: 14,
              fontFamily: 'var(--font-mono)', fontSize: 13, color: '#fff',
            }}
          >
            {backupCodes.map((c) => (
              <div key={c} style={{ textAlign: 'center' }}>{c}</div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Btn
              kind="secondary"
              onClick={copyBackupCodes}
              icon={codesCopied ? <Check className="w-4 h-4" style={{ color: 'var(--green)' }} /> : <Copy className="w-4 h-4" />}
            >
              {codesCopied ? 'Copied' : 'Copy all codes'}
            </Btn>
            <Btn
              kind="primary"
              onClick={() => window.location.assign('/fam/overview')}
              style={{ height: 48, fontSize: 14 }}
              iconRight={<Icon.arrow size={16} />}
            >
              I saved them — continue
            </Btn>
          </div>
        </AuthCard>
      </AuthLayout>
    )
  }

  // ── Step 1: scan + confirm ────────────────────────────────────────────────
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
            Platform admin accounts require an authenticator app. Scan the QR code with
            Google Authenticator, Microsoft Authenticator, 1Password, or Authy, then enter
            the 6-digit code it shows to confirm.
          </div>
        </div>

        {enroll.isPending && !secret ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0', color: 'var(--text-mute)' }}>
            <RefreshCw className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <>
            {otpauthUrl && (
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
                <div
                  style={{
                    background: '#fff', padding: 12, borderRadius: 'var(--r-sm)',
                    lineHeight: 0, border: '1px solid var(--bord)',
                  }}
                >
                  <QRCodeSVG value={otpauthUrl} size={168} bgColor="#ffffff" fgColor="#01010D" level="M" />
                </div>
              </div>
            )}

            <div style={{ marginBottom: 18 }}>
              <label className="label">Can&apos;t scan? Enter this key manually</label>
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

            <button
              onClick={regenerate}
              disabled={enroll.isPending}
              style={{
                marginTop: 14, background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-mute)', fontSize: 12, fontWeight: 600, width: '100%',
                textAlign: 'center', textDecoration: 'underline',
              }}
            >
              Key not working? Generate a new key (invalidates the previous one)
            </button>
          </>
        )}
      </AuthCard>
    </AuthLayout>
  )
}
