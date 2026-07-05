'use client'

import { useEffect, useState } from 'react'
import { Btn, Icon, Toggle } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useMyConsents,
  useRecordConsents,
  writeConsentCookie,
  readConsentCookie,
  type ConsentType,
} from '@/lib/api/queries/use-consent'

/**
 * D2 — consent preference rows + panel (PRD v4 §3.1, Appendix E copy).
 * Essential is locked on; Product analytics and Marketing emails toggle.
 * Reused by the banner's "Manage" modal and Settings → Privacy & data.
 */

const ROWS: Array<{
  k: 'essential' | ConsentType
  title: string
  desc: string
  locked?: boolean
}> = [
  {
    k: 'essential',
    title: 'Essential',
    desc: 'Required for sign-in, security, and core features.',
    locked: true,
  },
  {
    k: 'analytics',
    title: 'Product analytics',
    desc: 'Helps us see which features are used so we can improve them. Identifiers only, stored on our own servers in India.',
  },
  {
    k: 'marketing_email',
    title: 'Marketing emails',
    desc: 'Occasional product updates and offers. Unsubscribe anytime.',
  },
]

export function ConsentRowsBlock({
  values,
  onChange,
}: {
  values: { analytics: boolean; marketing_email: boolean }
  onChange: (k: ConsentType, v: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {ROWS.map((r) => (
        <div
          key={r.k}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 14,
            padding: '13px 15px',
            borderRadius: 11,
            background: 'var(--surf-1)',
            border: '1px solid var(--bord)',
            opacity: r.locked ? 0.75 : 1,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>{r.title}</span>
              {r.locked && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 9.5,
                    fontWeight: 800,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: 'var(--text-mute)',
                  }}
                >
                  <Icon.lock size={10} /> Always on
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.5 }}>
              {r.desc}
            </div>
          </div>
          <div style={{ marginTop: 2, pointerEvents: r.locked ? 'none' : 'auto' }}>
            <Toggle
              on={r.locked ? true : values[r.k as 'analytics' | 'marketing_email']}
              onChange={(v: boolean) => !r.locked && onChange(r.k as ConsentType, v)}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The framed preferences panel. When `authed`, saving writes ledger rows via
 * POST /consents; pre-login (banner "Manage") it only writes the fs_consent
 * cookie — the choice is ledgered on the first authenticated session.
 */
export function ConsentPrefsPanel({
  onClose,
  authed,
  region,
}: {
  onClose?: () => void
  authed: boolean
  region: string
}) {
  const { toast } = useToast()
  const { data } = useMyConsents(authed)
  const record = useRecordConsents()
  const [vals, setVals] = useState({ analytics: false, marketing_email: false })

  // Seed from the ledger (authed) or the cookie (pre-login).
  useEffect(() => {
    if (authed && data?.data?.latest) {
      setVals({
        analytics: data.data.latest.analytics?.granted ?? false,
        marketing_email: data.data.latest.marketing_email?.granted ?? false,
      })
    } else if (!authed) {
      const c = readConsentCookie()
      if (c) setVals((s) => ({ ...s, analytics: c.analytics }))
    }
  }, [authed, data])

  const save = async () => {
    writeConsentCookie(vals.analytics, region)
    if (authed) {
      try {
        await record.mutateAsync({
          consents: [
            { type: 'analytics', granted: vals.analytics },
            { type: 'marketing_email', granted: vals.marketing_email },
          ],
          region_code: region.length === 2 ? region : undefined,
        })
      } catch {
        toast({ title: 'Could not save preferences', variant: 'destructive' })
        return
      }
    }
    toast({ title: 'Privacy preferences saved' })
    onClose?.()
  }

  return (
    <div
      style={{
        background: 'rgba(18,18,30,.98)',
        border: '1px solid var(--bord-2)',
        borderRadius: 16,
        padding: 22,
        width: '100%',
        maxWidth: 480,
        boxShadow: '0 32px 80px rgba(0,0,0,.6)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 3 }}>
            Privacy preferences
          </div>
          <div className="t-mute" style={{ fontSize: 11.5 }}>
            Your choice is recorded with a timestamp, policy version and region.
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: 'var(--surf-2)',
              border: '1px solid var(--bord)',
              color: 'var(--text-2)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon.x size={14} />
          </button>
        )}
      </div>
      <ConsentRowsBlock values={vals} onChange={(k, v) => setVals((s) => ({ ...s, [k]: v }))} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, fontWeight: 700 }}>
          <a href="/privacy" target="_blank" style={{ color: 'var(--blue)' }}>Privacy Policy</a>
          <a href="/terms" target="_blank" style={{ color: 'var(--blue)' }}>Terms</a>
          <a href="/privacy#sub-processors" target="_blank" style={{ color: 'var(--blue)' }}>Sub-processors</a>
        </div>
        <div style={{ flex: 1 }} />
        <Btn kind="primary" size="sm" onClick={save}>
          {record.isPending ? 'Saving…' : 'Save preferences'}
        </Btn>
      </div>
    </div>
  )
}
