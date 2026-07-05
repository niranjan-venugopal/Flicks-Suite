'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { ConsentPrefsPanel } from './ConsentPrefs'
import {
  readConsentCookie,
  writeConsentCookie,
  bannerVariantFor,
  analyticsDefaultFor,
} from '@/lib/api/queries/use-consent'
import { useAuthStore } from '@/lib/stores/auth.store'

/**
 * D1 — geo-aware consent banner (PRD v4 §3.3, Appendix E copy). Non-modal
 * bottom bar; never blocks the page; never re-prompts after a choice (the
 * fs_consent cookie remembers; a version bump invalidates it). Hidden on
 * print/PDF surfaces and the hosted public invoice/mandate pages.
 */
export function ConsentBanner() {
  const pathname = usePathname()
  const isAuthenticated = useAuthStore((s) => !!s.currentUser)
  const [region, setRegion] = useState<string | null>(null)
  const [chosen, setChosen] = useState(true) // assume chosen until cookie read
  const [manage, setManage] = useState(false)

  useEffect(() => {
    if (readConsentCookie()) {
      setChosen(true)
      return
    }
    setChosen(false)
    fetch('/api/geo')
      .then((r) => r.json())
      .then((d) => setRegion(String(d.region ?? 'IN')))
      .catch(() => setRegion('IN'))
  }, [])

  // Excluded surfaces: print (rides into PDFs) + customer-facing public pages.
  if (
    !pathname ||
    pathname.includes('/print') ||
    pathname.startsWith('/inv/') ||
    pathname.startsWith('/sub/')
  ) {
    return null
  }
  if (chosen || !region) return null

  const variant = bannerVariantFor(region)
  const choose = (analytics: boolean) => {
    writeConsentCookie(analytics, region)
    setChosen(true)
  }

  const copy =
    variant === 'india' ? (
      <>
        Flicks Suite uses essential cookies to run the app. With your consent, we also collect
        product-usage analytics to improve the service. Read how we handle personal data in our{' '}
        <a href="/privacy" target="_blank" style={{ color: 'var(--blue)', fontWeight: 800 }}>
          Privacy Policy
        </a>{' '}
        — including your rights and our Grievance Officer contact.
      </>
    ) : variant === 'eu' ? (
      <>We use essential cookies to run Flicks Suite. We&apos;d also like to use analytics to improve the product.</>
    ) : (
      <>
        We use cookies and analytics to run and improve Flicks Suite. See our{' '}
        <a href="/privacy" target="_blank" style={{ color: 'var(--blue)', fontWeight: 800 }}>
          Privacy Policy
        </a>
        .
      </>
    )

  return (
    <>
      <div style={{ position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 900 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '14px 18px',
            borderRadius: 13,
            background: 'rgba(18,18,30,.97)',
            backdropFilter: 'blur(16px)',
            border: '1px solid var(--bord-2)',
            boxShadow: '0 18px 48px rgba(0,0,0,.55)',
            maxWidth: 1100,
            margin: '0 auto',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ color: 'var(--blue)', flexShrink: 0 }}>
            <Icon.shield size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 240, fontSize: 12, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.55 }}>
            {copy}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
            {variant === 'india' && (
              <>
                <Btn kind="primary" size="sm" onClick={() => choose(true)}>I consent</Btn>
                <Btn kind="secondary" size="sm" onClick={() => setManage(true)}>Manage choices</Btn>
              </>
            )}
            {variant === 'eu' && (
              <>
                <Btn kind="primary" size="sm" onClick={() => choose(true)}>Accept all</Btn>
                <Btn kind="secondary" size="sm" onClick={() => choose(false)}>Reject non-essential</Btn>
                <Btn kind="ghost" size="sm" onClick={() => setManage(true)}>Manage</Btn>
              </>
            )}
            {variant === 'us' && (
              <>
                <Btn kind="primary" size="sm" onClick={() => choose(analyticsDefaultFor(region))}>OK</Btn>
                <button
                  onClick={() => setManage(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-2)',
                    fontSize: 12,
                    fontWeight: 800,
                    textDecoration: 'underline',
                    textUnderlineOffset: 3,
                  }}
                >
                  Privacy choices
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {manage && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 950,
            background: 'rgba(1,1,13,.6)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
          onClick={(e) => e.target === e.currentTarget && setManage(false)}
        >
          <ConsentPrefsPanel
            authed={isAuthenticated}
            region={region}
            onClose={() => {
              setManage(false)
              if (readConsentCookie()) setChosen(true)
            }}
          />
        </div>
      )}
    </>
  )
}
