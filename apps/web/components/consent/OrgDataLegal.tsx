'use client'

import { useState } from 'react'
import { Btn, Icon, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { useRequestOrgExport } from '@/lib/api/queries/use-consent'

/**
 * D17 — Org settings "Data & legal" block (PRD v4 §3.5). Appended to the
 * Organization · Financial settings page; everything above it is unchanged.
 * Owner/Admin only (the settings page itself is admin-gated).
 */
export function OrgDataLegal() {
  const { toast } = useToast()
  const orgExport = useRequestOrgExport()
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle')

  const run = async () => {
    setState('working')
    try {
      await orgExport.mutateAsync()
      setState('done')
    } catch (err) {
      setState('idle')
      toast({
        title: 'Could not start the export',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="card">
      <div className="t-h3" style={{ marginBottom: 14 }}>Data &amp; legal</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* Export */}
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'flex-start',
            padding: '4px 0 14px',
            borderBottom: '1px solid var(--bord)',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 3 }}>
              Export organization data
            </div>
            <div className="t-mute" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
              Employees, attendance, leave, timesheets, customers, items, invoices, payments,
              notes, subscriptions and settings — CSV + JSON, zipped. Owner &amp; Admin only · 1
              per day.
            </div>
            {state === 'done' && (
              <div
                style={{
                  display: 'flex',
                  gap: 9,
                  marginTop: 10,
                  padding: '9px 12px',
                  borderRadius: 9,
                  background: 'rgba(39,210,128,.08)',
                  border: '1px solid rgba(39,210,128,.25)',
                }}
              >
                <Icon.mail size={14} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
                  Export running — the download link will be emailed to{' '}
                  <b style={{ color: '#fff' }}>owners &amp; admins</b>. Expires in 7 days.
                </span>
              </div>
            )}
          </div>
          {state === 'idle' && (
            <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />} onClick={run}>
              Export data
            </Btn>
          )}
          {state === 'working' && (
            <Btn kind="secondary" size="sm" style={{ pointerEvents: 'none', opacity: 0.7 }}>
              Queued…
            </Btn>
          )}
          {state === 'done' && <Pill tone="green" dot>Requested</Pill>}
        </div>

        {/* DPA */}
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            padding: '14px 0',
            borderBottom: '1px solid var(--bord)',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 3 }}>
              Data Processing Addendum
            </div>
            <div className="t-mute" style={{ fontSize: 11.5 }}>
              For your organization&apos;s controller/processor relationship with Specflicks.
            </div>
          </div>
          <a
            href="mailto:privacy@specflicks.com?subject=DPA%20request"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--blue)',
            }}
          >
            Request a signed copy <Icon.arrow size={12} />
          </a>
        </div>

        {/* Sub-processors */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '14px 0 4px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 3 }}>Sub-processor list</div>
            <div className="t-mute" style={{ fontSize: 11.5 }}>
              Supabase (Mumbai) · Cloudflare R2 · Vercel · Railway · Razorpay · Resend · Sentry
              (EU) · Upstash.
            </div>
          </div>
          <a
            href="/privacy#sub-processors"
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
            View on privacy page <Icon.arrow size={12} />
          </a>
        </div>
      </div>
    </div>
  )
}
