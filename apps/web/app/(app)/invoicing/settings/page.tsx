'use client'

import { useState, type ReactNode } from 'react'
import { Btn, Icon, Pill, SectionHead, Toggle } from '@/components/proto'
import { NumberingTab } from '@/components/invoicing/NumberingTab'
import { useOrgFinancial } from '@/lib/api/queries/use-invoicing'

/**
 * Invoicing Settings (PRD §7.1) — exact port of the v3 prototype's
 * ScrInvSettings (screens-settings.jsx): segmented tab bar + the seven
 * sub-tabs in the HRMS-blended design language. Numbering is fully wired;
 * the remaining tabs render the approved layout and pick up persistence in
 * Sprints 6–9.
 */

const TABS = ['Numbering', 'Template', 'Email & Reminders', 'Payments', 'Currencies', 'Tax codes', 'Compliance']

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
  const [sendAsLink, setSendAsLink] = useState(true)
  const [partialPayments, setPartialPayments] = useState(true)
  const [currencies, setCurrencies] = useState<Record<string, boolean>>({ USD: true, EUR: true, GBP: false })
  const [eInvoice, setEInvoice] = useState(false)

  return (
    <div style={{ padding: '26px 28px 72px' }}>
      <SectionHead
        title="Invoice settings"
        sub="Numbering, template, email, payments, currencies, tax codes and compliance — per PRD §7.1."
      />

      {/* segmented tab bar — prototype style */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          background: 'var(--surf-1)',
          border: '1px solid var(--bord)',
          borderRadius: 11,
          marginBottom: 20,
          flexWrap: 'wrap',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 13px',
              borderRadius: 7,
              border: 'none',
              cursor: 'pointer',
              background: tab === t ? 'var(--surf-3)' : 'transparent',
              color: tab === t ? '#fff' : 'var(--text-2)',
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Numbering' && <NumberingTab />}

      {tab === 'Template' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20 }}>
          <div className="card">
            <SettingRow label="Active template" sub="One polished default ships in v3">
              <Pill tone="blue" dot>Default · Classic</Pill>
            </SettingRow>
            <SettingRow label="Brand color" sub="Used for accents on the invoice">
              <div style={{ display: 'flex', gap: 8 }}>
                {['#3E7BFA', '#27D280', '#9B7BFA', '#F8786B'].map((c) => (
                  <div
                    key={c}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 7,
                      background: c,
                      border: c === '#3E7BFA' ? '2px solid #fff' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </SettingRow>
            <SettingRow label="Logo override" sub="Defaults to company logo">
              <Btn kind="secondary" size="sm" icon={<Icon.upload size={13} />}>Upload</Btn>
            </SettingRow>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 16,
                padding: '11px 14px',
                borderRadius: 10,
                background: 'var(--surf-1)',
                border: '1px solid var(--bord)',
              }}
            >
              <Icon.info size={15} style={{ color: 'var(--text-mute)' }} />
              <span className="t-mute" style={{ fontSize: 12 }}>More templates &amp; full customization — coming soon (P2).</span>
            </div>
          </div>
          <div
            style={{
              aspectRatio: '3/4',
              borderRadius: 12,
              border: '1px dashed var(--bord-2)',
              background: 'repeating-linear-gradient(135deg, var(--surf-1), var(--surf-1) 10px, transparent 10px, transparent 20px)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              color: 'var(--text-faint)',
            }}
          >
            <Icon.doc size={28} />
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>template preview</div>
          </div>
        </div>
      )}

      {tab === 'Email & Reminders' && (
        <div className="card" style={{ maxWidth: 680 }}>
          <SettingRow label="From name" sub="Sender shown on emails">
            <input className="input" defaultValue={fin?.data?.legal_name ?? ''} placeholder="Your company" style={{ width: 220 }} />
          </SettingRow>
          <SettingRow label="Reply-to">
            <input className="input" placeholder="finance@yourco.com" style={{ width: 220 }} />
          </SettingRow>
          <SettingRow label="Send as link (no PDF)" sub="Customer gets the hosted page link">
            <Toggle on={sendAsLink} onChange={setSendAsLink} />
          </SettingRow>
          <div style={{ marginTop: 16 }}>
            <div className="label">Reminder schedule (up to 10)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['−3d', 'Due day', '+3d', '+7d', '+14d', '+30d'].map((r, i) => (
                <Pill key={i} tone={i < 4 ? 'blue' : ''} dot={i < 4}>{r}</Pill>
              ))}
            </div>
            <div className="t-mute" style={{ fontSize: 11.5, marginTop: 8 }}>Reminder sending goes live with Sprint 6.</div>
          </div>
        </div>
      )}

      {tab === 'Payments' && (
        <div className="card" style={{ maxWidth: 680 }}>
          <SettingRow label="UPI ID" sub="Shown as QR on INR invoices">
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" placeholder="yourco@hdfcbank" style={{ width: 200, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
              <Btn kind="secondary" size="sm">Test</Btn>
            </div>
          </SettingRow>
          <SettingRow label="Razorpay" sub="Cards · UPI · Netbanking · international">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Pill tone="">Not connected</Pill>
              <Btn kind="secondary" size="sm" disabled title="Connect flow arrives with live keys (Sprint 9)">Connect</Btn>
            </div>
          </SettingRow>
          <SettingRow label="Partial payments" sub="Allow customers to pay in parts">
            <Toggle on={partialPayments} onChange={setPartialPayments} />
          </SettingRow>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 14,
              padding: '10px 13px',
              borderRadius: 10,
              background: 'var(--surf-1)',
              border: '1px solid var(--bord)',
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
            <Btn kind="secondary" size="sm" icon={<Icon.refresh size={13} />} disabled title="Live FX refresh arrives in Sprint 7">
              Refresh
            </Btn>
          </SettingRow>
        </div>
      )}

      {tab === 'Tax codes' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', maxWidth: 680 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Code</th>
                <th>Type</th>
                <th>Description</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
              </tr>
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
                    <td
                      key={j}
                      style={
                        j === 0
                          ? { fontFamily: 'var(--font-mono)', fontSize: 12 }
                          : j === 3
                            ? { textAlign: 'right', fontWeight: 800 }
                            : undefined
                      }
                    >
                      {c}
                    </td>
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
          <SettingRow label="TDS Section 393" sub="Income Tax Act 2025 · payment codes">
            <Pill tone="yellow">illustrative · pending sign-off</Pill>
          </SettingRow>
          <SettingRow label="e-Invoice (IRP)" sub="Above ₹5cr turnover threshold">
            <Toggle on={eInvoice} onChange={setEInvoice} />
          </SettingRow>
        </div>
      )}
    </div>
  )
}
