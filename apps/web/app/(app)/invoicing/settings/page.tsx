'use client'

import { useState } from 'react'
import { NumberingTab } from '@/components/invoicing/NumberingTab'
import { INVO, InvoPage, InvoTitle, InvoIcons } from '@/components/invoicing/invo'

// PRD §7.1 — the seven Invoicing Settings sub-tabs. Numbering is live;
// the rest land in Sprints 6–9 and render as visibly disabled tabs.
const TABS: { id: string; label: string; live: boolean }[] = [
  { id: 'numbering', label: 'Numbering', live: true },
  { id: 'template', label: 'Template', live: false },
  { id: 'email', label: 'Email & Reminders', live: false },
  { id: 'payments', label: 'Payments', live: false },
  { id: 'currencies', label: 'Currencies', live: false },
  { id: 'tax', label: 'Tax codes', live: false },
  { id: 'compliance', label: 'Compliance', live: false },
]

export default function InvoicingSettingsPage() {
  const [tab, setTab] = useState<string>('numbering')

  return (
    <InvoPage>
      <InvoTitle icon={InvoIcons.settings}>Invoice settings</InvoTitle>

      {/* §7.1 sub-tabs — underline pattern from the Invo prototype, with
          disabled (not-yet-live) tabs muted + a Soon chip. */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid rgba(255,255,255,0.08)', marginBottom: 4, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <div
            key={t.id}
            onClick={() => t.live && setTab(t.id)}
            style={{
              padding: '8px 16px',
              cursor: t.live ? 'pointer' : 'not-allowed',
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: '-0.02em',
              color: tab === t.id ? '#fff' : t.live ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.18)',
              borderBottom: tab === t.id ? '2px solid #fff' : '2px solid transparent',
              marginBottom: -2,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
            {!t.live && (
              <span
                style={{
                  padding: '1px 7px',
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.06)',
                  color: 'rgba(255,255,255,0.3)',
                  fontWeight: 700,
                  fontSize: 10,
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                }}
              >
                Soon
              </span>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 24 }}>
        {tab === 'numbering' && (
          <>
            <p style={{ fontWeight: 600, fontSize: 13, color: INVO.muted50, marginBottom: 20, letterSpacing: '-0.02em', maxWidth: 720 }}>
              Numbers reset automatically at the start of each financial year. Numbers must be ≤16 characters and use
              only letters, digits, “-” and “/”. Changing numbering mid-year can affect GST compliance.
            </p>
            <NumberingTab />
          </>
        )}
      </div>
    </InvoPage>
  )
}
