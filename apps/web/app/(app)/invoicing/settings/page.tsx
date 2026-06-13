'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Btn, Icon, Pill, SectionHead, Toggle } from '@/components/proto'
import { InvoPage } from '@/components/invoicing/invo'
import { NumberingTab } from '@/components/invoicing/NumberingTab'
import { useOrgFinancial } from '@/lib/api/queries/use-invoicing'
import {
  useInvSettings,
  useUpdateInvSettings,
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

function SettingRow({ label, sub, children }: { label: string; sub?: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 0', borderBottom: '1px solid var(--bord)' }}>
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
        sub="Numbering, template, email, payments, currencies, tax codes and compliance — per PRD §7.1."
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
        <div className="card" style={{ maxWidth: 680 }}>
          <SettingRow label="Active template" sub="One polished default ships in v3">
            <Pill tone="blue" dot>Default · Classic</Pill>
          </SettingRow>
          <SettingRow label="Brand color" sub="Used for accents on the invoice">
            <div style={{ display: 'flex', gap: 8 }}>
              {BRAND_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set('brand_color_override', c)}
                  aria-label={c}
                  style={{
                    width: 24, height: 24, borderRadius: 7, background: c, cursor: 'pointer',
                    border: draft.brand_color_override === c ? '2px solid #fff' : '2px solid transparent',
                  }}
                />
              ))}
            </div>
          </SettingRow>
          <SettingRow label="Show UPI QR on PDF" sub="Render the UPI intent QR on INR invoices">
            <Toggle on={!!draft.show_upi_qr_on_pdf} onChange={(v) => set('show_upi_qr_on_pdf', v)} />
          </SettingRow>
          <div style={{ paddingTop: 14 }}>
            <div className="label">Default invoice notes</div>
            <textarea
              className="input"
              rows={2}
              value={draft.default_invoice_notes ?? ''}
              onChange={(e) => set('default_invoice_notes', e.target.value)}
              placeholder="Thanks for your business!"
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>
          <div style={{ paddingTop: 14 }}>
            <div className="label">Default terms &amp; conditions</div>
            <textarea
              className="input"
              rows={2}
              value={draft.default_terms_and_conditions ?? ''}
              onChange={(e) => set('default_terms_and_conditions', e.target.value)}
              placeholder="Payment due within the stated terms."
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>
        </div>
      )}

      {tab === 'Email & Reminders' && (
        <div className="card" style={{ maxWidth: 680 }}>
          <SettingRow label="From name" sub="Sender shown on emails">
            <input
              className="input"
              value={draft.email_sender_name ?? ''}
              onChange={(e) => set('email_sender_name', e.target.value)}
              placeholder={fin?.data?.legal_name ?? 'Your company'}
              style={{ width: 240 }}
            />
          </SettingRow>
          <SettingRow label="Reply-to">
            <input
              className="input"
              value={draft.email_reply_to ?? ''}
              onChange={(e) => set('email_reply_to', e.target.value)}
              placeholder="finance@yourco.com"
              style={{ width: 240 }}
            />
          </SettingRow>
          <SettingRow label="CC owner on customer emails" sub="Owner gets a copy of every send">
            <Toggle on={!!draft.cc_owner_on_customer_emails} onChange={(v) => set('cc_owner_on_customer_emails', v)} />
          </SettingRow>
          <div style={{ paddingTop: 14 }}>
            <div className="label">Email signature</div>
            <textarea
              className="input"
              rows={2}
              value={draft.email_signature ?? ''}
              onChange={(e) => set('email_signature', e.target.value)}
              placeholder="— The Acme Finance team"
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="label">Reminder schedule</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['−3d', 'Due day', '+3d', '+7d', '+14d', '+30d'].map((r, i) => (
                <Pill key={i} tone={i < 4 ? 'blue' : ''} dot={i < 4}>{r}</Pill>
              ))}
            </div>
            <div className="t-mute" style={{ fontSize: 11.5, marginTop: 8 }}>
              The hourly reminder sweep is live; per-schedule editing arrives with the schedule editor.
            </div>
          </div>
        </div>
      )}

      {tab === 'Payments' && (
        <div className="card" style={{ maxWidth: 680 }}>
          <SettingRow label="UPI ID" sub="Shown as QR on INR invoices">
            <input
              className="input"
              value={draft.upi_id ?? ''}
              onChange={(e) => set('upi_id', e.target.value)}
              placeholder="yourco@hdfcbank"
              style={{ width: 220, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            />
          </SettingRow>
          <SettingRow label="UPI display name" sub="Beneficiary name on the QR">
            <input
              className="input"
              value={draft.upi_display_name ?? ''}
              onChange={(e) => set('upi_display_name', e.target.value)}
              placeholder="Acme Pvt Ltd"
              style={{ width: 220 }}
            />
          </SettingRow>
          <SettingRow label="Razorpay" sub="Cards · UPI · Netbanking · international">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Pill tone={settings?.razorpay_webhook_configured ? 'green' : ''} dot={settings?.razorpay_webhook_configured}>
                {settings?.razorpay_webhook_configured ? 'Connected' : 'Not connected'}
              </Pill>
              <Btn kind="secondary" size="sm" disabled title="Connect flow arrives with live keys">Connect</Btn>
            </div>
          </SettingRow>
          <SettingRow label="Partial payments" sub="Allow customers to pay in parts">
            <Toggle on={!!draft.allow_partial_payments} onChange={(v) => set('allow_partial_payments', v)} />
          </SettingRow>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, padding: '10px 13px',
              borderRadius: 10, background: 'var(--surf-1)', border: '1px solid var(--bord)',
            }}
          >
            <Icon.lock size={14} style={{ color: 'var(--text-mute)' }} />
            <span className="t-mute" style={{ fontSize: 12 }}>Razorpay disconnect is restricted to the Owner.</span>
          </div>
        </div>
      )}

      {tab === 'Currencies' && (
        <div className="card" style={{ maxWidth: 680 }}>
          <SettingRow label="INR · Indian Rupee" sub="Base currency">
            <Pill tone="green" dot>Locked on</Pill>
          </SettingRow>
          {([['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'Pound Sterling']] as const).map(([c, n]) => (
            <SettingRow key={c} label={`${c} · ${n}`}>
              <Toggle on={currencies[c]!} onChange={(v) => setCurrencies((cur) => ({ ...cur, [c]: v }))} />
            </SettingRow>
          ))}
          <SettingRow label="FX source" sub="openexchangerates · snapshot at invoice creation">
            <Pill tone="">Config-gated</Pill>
          </SettingRow>
        </div>
      )}

      {tab === 'Tax codes' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', maxWidth: 680 }}>
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
      )}

      {tab === 'Compliance' && (
        <div className="card" style={{ maxWidth: 680 }}>
          <SettingRow label="GST registered" sub={fin?.data?.gstin ? `GSTIN ${fin.data.gstin}` : 'Add your GSTIN under Settings → Organization'}>
            <Pill tone={fin?.data?.gstin ? 'green' : ''} dot={!!fin?.data?.gstin}>
              {fin?.data?.gstin ? 'Active' : 'Not set'}
            </Pill>
          </SettingRow>
          <SettingRow label="Place of supply default" sub="From company state">
            <span style={{ fontSize: 13, fontWeight: 700 }}>{fin?.data?.state_code ?? '—'}</span>
          </SettingRow>
          <SettingRow label="Filing frequency" sub="GSTR-1 cadence">
            <select
              className="input"
              value={draft.filing_frequency ?? 'monthly'}
              onChange={(e) => set('filing_frequency', e.target.value)}
              style={{ width: 160 }}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly (QRMP)</option>
            </select>
          </SettingRow>
          <SettingRow label="Composition scheme" sub="Composition dealers don't charge GST">
            <Toggle on={!!draft.composition_scheme} onChange={(v) => set('composition_scheme', v)} />
          </SettingRow>
          <SettingRow label="Auto-suggest TDS" sub="Pre-fill Section 393 on eligible invoices">
            <Toggle on={!!draft.auto_suggest_tds} onChange={(v) => set('auto_suggest_tds', v)} />
          </SettingRow>
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
