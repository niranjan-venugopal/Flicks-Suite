'use client'

import { useState } from 'react'
import { Pill, SectionHead } from '@/components/proto'
import { NumberingTab } from '@/components/invoicing/NumberingTab'

const TABS = [
  { id: 'numbering', label: 'Numbering', live: true },
  { id: 'template', label: 'Template', live: false },
  { id: 'email', label: 'Email & Reminders', live: false },
  { id: 'payments', label: 'Payments', live: false },
  { id: 'currencies', label: 'Currencies', live: false },
  { id: 'tax', label: 'Tax codes', live: false },
  { id: 'compliance', label: 'Compliance', live: false },
] as const

export default function InvoicingSettingsPage() {
  const [tab, setTab] = useState<string>('numbering')

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1000, margin: '0 auto' }}>
      <SectionHead eyebrow="Invoicing" title="Settings" sub="Numbering, templates, email, payments, currencies and tax codes." />

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 20px' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => t.live && setTab(t.id)}
            style={{
              padding: '7px 13px',
              borderRadius: 9,
              border: '1px solid var(--line)',
              background: tab === t.id ? 'var(--blue)' : 'var(--surface)',
              color: tab === t.id ? '#fff' : t.live ? 'var(--text)' : 'var(--muted)',
              fontSize: 13,
              cursor: t.live ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {t.label}
            {!t.live && <Pill tone="">soon</Pill>}
          </button>
        ))}
      </div>

      {tab === 'numbering' && <NumberingTab />}
    </div>
  )
}
