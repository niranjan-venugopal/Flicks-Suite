'use client'

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Btn, Icon, Pill, SectionHead, Toggle } from '@/components/proto'
import { InvoPage } from '@/components/invoicing/invo'
import { NumberingTab } from '@/components/invoicing/NumberingTab'
import { useOrgFinancial } from '@/lib/api/queries/use-invoicing'
import {
  useInvSettings,
  useUpdateInvSettings,
  useRazorpayConnectUrl,
  useDisconnectRazorpay,
  type InvSettings,
  type InvSettingsPatch,
} from '@/lib/api/queries/use-inv-settings'
import { useToast } from '@/components/ui/use-toast'

/**
 * Invoicing Settings (PRD §7.1) — prototype ScrInvSettings layout, now wired to
 * /invoicing/settings. Numbering keeps its own persistence; Currencies and Tax
 * codes stay informational (they manage sub-resources). The other tabs edit a
 * single draft over invoicing_settings and persist via a sticky Save bar.
 */

const TABS = ['Numbering', 'Template', 'Email & Reminders', 'Payments', 'Currencies', 'Tax codes', 'Compliance']
const BRAND_COLORS = ['#3E7BFA', '#27D280', '#9B7BFA', '#F8786B']

// Blended idiom (matches NumberingTab): each tab is a flex column of cards.
const TAB_WRAP: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }
const GRID_2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }

// Label-above-input field (NumberingTab style). `full` spans both grid columns.
function Field({ label, hint, full, children }: { label: string; hint?: string; full?: boolean; children: ReactNode }) {
  return (
    <div style={full ? { gridColumn: '1 / -1' } : undefined}>
      <label className="label">{label}</label>
      {children}
      {hint && <div className="t-mute" style={{ fontSize: 11, marginTop: 6 }}>{hint}</div>}
    </div>
  )
}

// A standalone toggle/status card — the "Auto-reset on April 1" pattern from NumberingTab:
// title + sub on the left, control on the right.
function ToggleRow({ label, sub, children }: { label: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 800 }}>{label}</div>
        {sub && <div className="t-mute" style={{ fontSize: 11.5, marginTop: 2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  )
}

export default function InvoicingSettingsPage() {
  const [tab, setTab] = useState('Numbering')
  const { data: fin } = useOrgFinancial()
  const { data: settingsRes } = useInvSettings()
  const update = useUpdateInvSettings()
  const { toast } = useToast()

  const settings = settingsRes?.data
  const [draft, setDraft] = useState<InvSettingsPatch>({})
  const connectRzp = useRazorpayConnectUrl()
  const disconnectRzp = useDisconnectRazorpay()

  // Surface the OAuth round-trip result (callback redirects back here with
  // ?tab=Payments&razorpay=connected|error) and land the user on the Payments tab.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get('razorpay')
    if (params.get('tab') === 'Payments') setTab('Payments')
    if (status === 'connected') toast({ title: 'Razorpay connected' })
    else if (status === 'error')
      toast({ title: 'Razorpay connection failed', variant: 'destructive' })
    if (status) {
      params.delete('razorpay')
      const qs = params.toString()
      window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startRazorpayConnect = async () => {
    try {
      const res = await connectRzp.mutateAsync()
      window.location.href = res.data.url
    } catch (err) {
      toast({
        title: 'Could not start Razorpay connect',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const disconnectRazorpay = async () => {
    if (!window.confirm('Disconnect Razorpay? Customers will no longer be able to pay online.')) return
    try {
      await disconnectRzp.mutateAsync()
      toast({ title: 'Razorpay disconnected' })
    } catch (err) {
      toast({
        title: 'Could not disconnect Razorpay',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  // Seed the draft once settings land, and whenever they change underneath us.
  useEffect(() => {
    if (!settings) return
    setDraft({
      brand_color_override: settings.brand_color_override ?? BRAND_COLORS[0],
      default_invoice_notes: settings.default_invoice_notes ?? '',
      default_terms_and_conditions: settings.default_terms_and_conditions ?? '',
      email_sender_name: settings.email_sender_name ?? '',
      email_reply_to: settings.email_reply_to ?? '',
      email_signature: settings.email_signature ?? '',
      cc_owner_on_customer_emails: settings.cc_owner_on_customer_emails,
      upi_id: settings.upi_id ?? '',
      upi_display_name: settings.upi_display_name ?? '',
      allow_partial_payments: settings.allow_partial_payments,
      show_upi_qr_on_pdf: settings.show_upi_qr_on_pdf,
      filing_frequency: settings.filing_frequency,
      composition_scheme: settings.composition_scheme,
      auto_suggest_tds: settings.auto_suggest_tds,
      default_tds_section: settings.default_tds_section ?? '393',
    })
  }, [settings])

  const set = <K extends keyof InvSettingsPatch>(k: K, v: InvSettingsPatch[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))

  // Dirty = any draft value differs from the loaded settings.
  const dirty = useMemo(() => {
    if (!settings) return false
    return (Object.keys(draft) as (keyof InvSettingsPatch)[]).some((k) => {
      const cur = (settings as InvSettings)[k as keyof InvSettings]
      return (draft[k] ?? null) !== (cur ?? null)
    })
  }, [draft, settings])

  const save = async () => {
    try {
      await update.mutateAsync(draft)
      toast({ title: 'Settings saved' })
    } catch (err) {
      toast({
        title: 'Could not save settings',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  // Currencies/Tax-codes remain local/informational for now.
  const [currencies, setCurrencies] = useState<Record<string, boolean>>({ USD: true, EUR: true, GBP: false })

  return (
    <InvoPage>
      <SectionHead
        title="Invoice settings"
        sub="Numbering, template, email, payments, currencies, tax codes and compliance."
      />

      <div
        style={{
          display: 'flex', gap: 4, padding: 4, background: 'var(--surf-1)',
          border: '1px solid var(--bord)', borderRadius: 11, marginBottom: 20, flexWrap: 'wrap',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 13px', borderRadius: 7, border: 'none', cursor: 'pointer',
              background: tab === t ? 'var(--surf-3)' : 'transparent',
              color: tab === t ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Numbering' && <NumberingTab />}

      {tab === 'Template' && (
        <div style={TAB_WRAP}>
          <div className="card">
            <div className="t-h3" style={{ marginBottom: 18 }}>Template &amp; branding</div>
            <div style={{ ...GRID_2, alignItems: 'start' }}>
              <Field label="Active template" hint="More templates are on the way">
                <Pill tone="blue" dot>Default · Classic</Pill>
              </Field>
              <Field label="Brand color" hint="Used for accents on the invoice">
                <div style={{ display: 'flex', gap: 8, height: 38, alignItems: 'center' }}>
                  {BRAND_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => set('brand_color_override', c)}
                      aria-label={c}
                      style={{
                        width: 26, height: 26, borderRadius: 7, background: c, cursor: 'pointer',
                        border: draft.brand_color_override === c ? '2px solid #fff' : '2px solid transparent',
                      }}
                    />
                  ))}
                </div>
              </Field>
              <Field label="Default invoice notes" full>
                <textarea
                  className="input"
                  rows={2}
                  value={draft.default_invoice_notes ?? ''}
                  onChange={(e) => set('default_invoice_notes', e.target.value)}
                  placeholder="Thanks for your business!"
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </Field>
              <Field label="Default terms & conditions" full>
                <textarea
                  className="input"
                  rows={2}
                  value={draft.default_terms_and_conditions ?? ''}
                  onChange={(e) => set('default_terms_and_conditions', e.target.value)}
                  placeholder="Payment due within the stated terms."
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </Field>
            </div>
          </div>
          <ToggleRow label="Show UPI QR on PDF" sub="Render the UPI intent QR on INR invoices">
            <Toggle on={!!draft.show_upi_qr_on_pdf} onChange={(v) => set('show_upi_qr_on_pdf', v)} />
          </ToggleRow>
        </div>
      )}

      {tab === 'Email & Reminders' && (
        <div style={TAB_WRAP}>
          <div className="card">
            <div className="t-h3" style={{ marginBottom: 18 }}>Sender</div>
            <div style={{ ...GRID_2, alignItems: 'start' }}>
              <Field label="From name" hint="Sender shown on emails">
                <input
                  className="input"
                  value={draft.email_sender_name ?? ''}
                  onChange={(e) => set('email_sender_name', e.target.value)}
                  placeholder={fin?.data?.legal_name ?? 'Your company'}
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label="Reply-to">
                <input
                  className="input"
                  value={draft.email_reply_to ?? ''}
                  onChange={(e) => set('email_reply_to', e.target.value)}
                  placeholder="finance@yourco.com"
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label="Email signature" full>
                <textarea
                  className="input"
                  rows={2}
                  value={draft.email_signature ?? ''}
                  onChange={(e) => set('email_signature', e.target.value)}
                  placeholder="— The Acme Finance team"
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </Field>
            </div>
          </div>
          <ToggleRow label="CC owner on customer emails" sub="Owner gets a copy of every send">
            <Toggle on={!!draft.cc_owner_on_customer_emails} onChange={(v) => set('cc_owner_on_customer_emails', v)} />
          </ToggleRow>
          <div className="card">
            <div className="t-h3" style={{ marginBottom: 14 }}>Reminder schedule</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['−3d', 'Due day', '+3d', '+7d', '+14d', '+30d'].map((r, i) => (
                <Pill key={i} tone={i < 4 ? 'blue' : ''} dot={i < 4}>{r}</Pill>
              ))}
            </div>
            <div className="t-mute" style={{ fontSize: 11.5, marginTop: 12 }}>
              The hourly reminder sweep is live; per-schedule editing arrives with the schedule editor.
            </div>
          </div>
        </div>
      )}

      {tab === 'Payments' && (
        <div style={TAB_WRAP}>
          <div className="card">
            <div className="t-h3" style={{ marginBottom: 18 }}>UPI</div>
            <div style={GRID_2}>
              <Field label="UPI ID" hint="Shown as QR on INR invoices">
                <input
                  className="input"
                  value={draft.upi_id ?? ''}
                  onChange={(e) => set('upi_id', e.target.value)}
                  placeholder="yourco@hdfcbank"
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                />
              </Field>
              <Field label="UPI display name" hint="Beneficiary name on the QR">
                <input
                  className="input"
                  value={draft.upi_display_name ?? ''}
                  onChange={(e) => set('upi_display_name', e.target.value)}
                  placeholder="Acme Pvt Ltd"
                  style={{ width: '100%' }}
                />
              </Field>
            </div>
          </div>
          <ToggleRow label="Razorpay" sub="Online payments via Razorpay are coming in the next version.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {settings?.razorpay_connected ? (
                // Legacy connected tenants keep visibility + the exit door.
                <>
                  <Pill tone="green" dot>Connected</Pill>
                  <Btn kind="secondary" size="sm" onClick={disconnectRazorpay} disabled={disconnectRzp.isPending}>
                    Disconnect
                  </Btn>
                </>
              ) : (
                // This version ships without the tenant-track integration.
                <>
                  <Pill tone="yellow" dot>Coming soon</Pill>
                  <Btn kind="secondary" size="sm" disabled>
                    Connect with Razorpay
                  </Btn>
                </>
              )}
            </div>
          </ToggleRow>
          <ToggleRow label="Partial payments" sub="Allow customers to pay in parts">
            <Toggle on={!!draft.allow_partial_payments} onChange={(v) => set('allow_partial_payments', v)} />
          </ToggleRow>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px',
              borderRadius: 10, background: 'var(--surf-1)', border: '1px solid var(--bord)',
            }}
          >
            <Icon.lock size={14} style={{ color: 'var(--text-mute)' }} />
            <span className="t-mute" style={{ fontSize: 12 }}>Razorpay disconnect is restricted to the Owner.</span>
          </div>
        </div>
      )}

      {tab === 'Currencies' && (
        <div style={TAB_WRAP}>
          <ToggleRow label="INR · Indian Rupee" sub="Base currency">
            <Pill tone="green" dot>Locked on</Pill>
          </ToggleRow>
          {([['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'Pound Sterling']] as const).map(([c, n]) => (
            <ToggleRow key={c} label={`${c} · ${n}`} sub="Enable to invoice in this currency">
              <Toggle on={currencies[c]!} onChange={(v) => setCurrencies((cur) => ({ ...cur, [c]: v }))} />
            </ToggleRow>
          ))}
          <ToggleRow label="FX source" sub="openexchangerates · snapshot at invoice creation">
            <Pill tone="">Config-gated</Pill>
          </ToggleRow>
        </div>
      )}

      {tab === 'Tax codes' && (
        <div style={TAB_WRAP}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--bord)' }}>
              <div className="t-h3">Saved HSN / SAC codes</div>
              <div className="t-mute" style={{ fontSize: 11.5, marginTop: 2 }}>Reused across items and invoices for GST.</div>
            </div>
            <table className="tbl">
              <thead>
                <tr><th>Code</th><th>Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Rate</th></tr>
              </thead>
              <tbody>
                {([
                  ['998314', 'SAC', 'IT design & development', '18%'],
                  ['998315', 'SAC', 'Hosting & infrastructure', '18%'],
                  ['8523', 'HSN', 'Software media', '18%'],
                  ['998313', 'SAC', 'IT consulting & support', '18%'],
                ] as const).map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j} style={j === 0 ? { fontFamily: 'var(--font-mono)', fontSize: 12 } : j === 3 ? { textAlign: 'right', fontWeight: 800 } : undefined}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'Compliance' && (
        <div style={TAB_WRAP}>
          <div className="card">
            <div className="t-h3" style={{ marginBottom: 18 }}>GST</div>
            <div style={{ ...GRID_2, alignItems: 'start' }}>
              <Field label="GST registered" hint={fin?.data?.gstin ? `GSTIN ${fin.data.gstin}` : 'Add your GSTIN under Settings → Organization'}>
                <Pill tone={fin?.data?.gstin ? 'green' : ''} dot={!!fin?.data?.gstin}>
                  {fin?.data?.gstin ? 'Active' : 'Not set'}
                </Pill>
              </Field>
              <Field label="Place of supply default" hint="From company state">
                <span style={{ display: 'inline-block', fontSize: 13, fontWeight: 700, paddingTop: 6 }}>{fin?.data?.state_code ?? '—'}</span>
              </Field>
              <Field label="Filing frequency" hint="GSTR-1 cadence">
                <select
                  className="input"
                  value={draft.filing_frequency ?? 'monthly'}
                  onChange={(e) => set('filing_frequency', e.target.value)}
                  style={{ width: '100%' }}
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly (QRMP)</option>
                </select>
              </Field>
            </div>
          </div>
          <ToggleRow label="Composition scheme" sub="Composition dealers don't charge GST">
            <Toggle on={!!draft.composition_scheme} onChange={(v) => set('composition_scheme', v)} />
          </ToggleRow>
          <ToggleRow label="Auto-suggest TDS" sub="Pre-fill Section 393 on eligible invoices">
            <Toggle on={!!draft.auto_suggest_tds} onChange={(v) => set('auto_suggest_tds', v)} />
          </ToggleRow>
        </div>
      )}

      {/* Sticky save bar — shown when the draft differs from saved settings. */}
      {dirty && tab !== 'Numbering' && tab !== 'Currencies' && tab !== 'Tax codes' && (
        <div
          style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, padding: '14px 28px',
            background: 'rgba(13,13,20,.92)', backdropFilter: 'blur(10px)',
            borderTop: '1px solid var(--bord-2)', display: 'flex', justifyContent: 'flex-end',
            gap: 10, zIndex: 50,
          }}
        >
          <span className="t-mute" style={{ alignSelf: 'center', fontSize: 12 }}>You have unsaved changes</span>
          <Btn kind="primary" onClick={save} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Btn>
        </div>
      )}
    </InvoPage>
  )
}
