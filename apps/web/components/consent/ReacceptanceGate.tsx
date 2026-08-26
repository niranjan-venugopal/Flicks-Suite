'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Btn, LogoMark } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { useMyConsents, useRecordConsents } from '@/lib/api/queries/use-consent'

/**
 * §3.2 — policy-bump re-acceptance interstitial. Shown exactly once per user
 * after a TERMS_VERSION/PRIVACY_VERSION bump (or for accounts that predate the
 * ledger, e.g. invited users): one checkbox + Continue → new ledger row.
 */
export function ReacceptanceGate() {
  const { data } = useMyConsents(true)
  const record = useRecordConsents()
  const qc = useQueryClient()
  const { toast } = useToast()
  const [agree, setAgree] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const state = data?.data
  if (!state?.requires_reacceptance || dismissed) return null

  const accept = async () => {
    try {
      await record.mutateAsync({
        consents: [{ type: 'terms_privacy', granted: true }],
      })
      // The trust-device prompt waits behind this gate on the same consents
      // query; refresh auth/me too so anything reading it sees fresh state.
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      setDismissed(true)
    } catch (err) {
      // Keep the gate up — dismissing on failure would leave the ledger
      // without the acceptance this interstitial exists to record.
      toast({
        title: 'Could not record your acceptance',
        description: err instanceof Error ? err.message : 'Please try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 990,
        // Radix modals set pointer-events: none on <body>; this gate is not a
        // Radix layer, so it must re-arm its own subtree or every click dies.
        pointerEvents: 'auto',
        background: 'rgba(1,1,13,.72)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: 'rgba(18,18,30,.98)',
          border: '1px solid var(--bord-2)',
          borderRadius: 16,
          padding: '26px 26px 22px',
          boxShadow: '0 32px 80px rgba(0,0,0,.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <LogoMark size={34} />
          <div>
            <div style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-0.02em' }}>
              We&apos;ve updated our Terms &amp; Privacy Policy
            </div>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: 'var(--text-mute)',
                fontFamily: 'var(--font-mono)',
                marginTop: 2,
              }}
            >
              {state.terms_version} · {state.privacy_version}
            </div>
          </div>
        </div>
        <div className="t-mute" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>
          Please review and accept the updated terms to continue to your workspace.{' '}
          <a href="/terms" target="_blank" style={{ color: 'var(--blue)', fontWeight: 700 }}>
            Review what changed →
          </a>
        </div>
        <label
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            fontSize: 12.5,
            color: 'var(--text-2)',
            lineHeight: 1.5,
            cursor: 'pointer',
            padding: '11px 13px',
            borderRadius: 10,
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            marginBottom: 14,
          }}
        >
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
            style={{ marginTop: 2, accentColor: 'var(--blue)' }}
          />
          <span>
            I agree to the updated{' '}
            <a href="/terms" target="_blank" style={{ color: 'var(--blue)', fontWeight: 700 }}>
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="/privacy" target="_blank" style={{ color: 'var(--blue)', fontWeight: 700 }}>
              Privacy Policy
            </a>
            .
          </span>
        </label>
        <Btn
          kind="primary"
          style={{
            width: '100%',
            height: 44,
            justifyContent: 'center',
            ...(agree ? {} : { opacity: 0.45, pointerEvents: 'none' }),
          }}
          onClick={accept}
        >
          {record.isPending ? 'Saving…' : 'Continue to workspace'}
        </Btn>
      </div>
    </div>
  )
}
