'use client'

import { useState } from 'react'
import Link from 'next/link'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { Btn, Icon, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { ConsentRowsBlock } from '@/components/consent/ConsentPrefs'
import {
  useMyConsents,
  useRecordConsents,
  useRequestMyExport,
  type ConsentType,
} from '@/lib/api/queries/use-consent'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useEffect } from 'react'

/**
 * D3 — Settings → Privacy & data (PRD v4 §3.5/§3.6). Consent toggles (same
 * component as the banner's D2 modal), self-service data export with the
 * emailed-link state, legal links, and the existing account-deletion flow.
 */
export default function PrivacySettingsPage() {
  const { toast } = useToast()
  const { currentUser } = useAuthStore()
  const { data } = useMyConsents(true)
  const record = useRecordConsents()
  const myExport = useRequestMyExport()
  const [vals, setVals] = useState({ analytics: false, marketing_email: false })
  const [exportState, setExportState] = useState<'idle' | 'working' | 'done'>('idle')

  useEffect(() => {
    const latest = data?.data?.latest
    if (latest) {
      setVals({
        analytics: latest.analytics?.granted ?? false,
        marketing_email: latest.marketing_email?.granted ?? false,
      })
    }
  }, [data])

  const save = async () => {
    try {
      await record.mutateAsync({
        consents: [
          { type: 'analytics', granted: vals.analytics },
          { type: 'marketing_email', granted: vals.marketing_email },
        ],
      })
      toast({ title: 'Privacy preferences saved' })
    } catch (err) {
      toast({
        title: 'Could not save preferences',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const runExport = async () => {
    setExportState('working')
    try {
      await myExport.mutateAsync()
      setExportState('done')
    } catch (err) {
      setExportState('idle')
      toast({
        title: 'Could not start the export',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <SettingsLayout>
      {/* Consent choices */}
      <div className="card">
        <div className="t-h3" style={{ marginBottom: 4 }}>Your consent choices</div>
        <div className="t-mute" style={{ fontSize: 11.5, marginBottom: 14 }}>
          Withdrawal is as easy as giving consent and takes effect immediately for future processing.
        </div>
        <ConsentRowsBlock
          values={vals}
          onChange={(k: ConsentType, v: boolean) => setVals((s) => ({ ...s, [k]: v }))}
        />
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 14 }}>
          <span className="t-caption">
            {data?.data?.consent_version ?? 'consent-v1'} · recorded with timestamp, version &amp; region
          </span>
          <div style={{ flex: 1 }} />
          <Btn kind="primary" size="sm" onClick={save}>
            {record.isPending ? 'Saving…' : 'Save preferences'}
          </Btn>
        </div>
      </div>

      {/* Data export */}
      <div className="card">
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div className="t-h3" style={{ marginBottom: 4 }}>Download my data</div>
            <div className="t-mute" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
              Profile, memberships and consent history — as a ZIP. We&apos;ll email you a download link.
            </div>
          </div>
          {exportState === 'idle' && (
            <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />} onClick={runExport}>
              Download my data
            </Btn>
          )}
          {exportState === 'working' && (
            <Btn kind="secondary" size="sm" style={{ pointerEvents: 'none', opacity: 0.7 }}>
              Preparing export…
            </Btn>
          )}
          {exportState === 'done' && <Pill tone="green" dot>Requested</Pill>}
        </div>
        {exportState === 'done' && (
          <div
            style={{
              display: 'flex',
              gap: 9,
              marginTop: 12,
              padding: '10px 13px',
              borderRadius: 9,
              background: 'rgba(39,210,128,.08)',
              border: '1px solid rgba(39,210,128,.25)',
            }}
          >
            <Icon.mail size={14} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
              Link will be emailed to <b style={{ color: '#fff' }}>{currentUser?.email}</b> — expires in
              7 days. Limit: 1 export per day.
            </span>
          </div>
        )}
      </div>

      {/* Legal links + delete */}
      <div className="card">
        <div className="t-h3" style={{ marginBottom: 12 }}>Legal</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          {[
            ['Terms of Service', '/terms'],
            ['Privacy Policy', '/privacy'],
            ['Sub-processor list', '/privacy#sub-processors'],
          ].map(([label, href]) => (
            <a
              key={label}
              href={href}
              target="_blank"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12.5,
                fontWeight: 700,
                color: 'var(--blue)',
              }}
            >
              {label} <Icon.arrow size={12} />
            </a>
          ))}
        </div>
        <div
          style={{
            paddingTop: 14,
            borderTop: '1px solid var(--bord)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Link
            href="/profile"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 12.5,
              fontWeight: 800,
              color: 'var(--coral)',
            }}
          >
            <Icon.trash size={13} /> Delete account
          </Link>
          <span className="t-caption">Opens the existing deletion flow on your profile — unchanged</span>
        </div>
      </div>
    </SettingsLayout>
  )
}
