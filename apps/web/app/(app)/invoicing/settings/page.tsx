'use client'

import { useState } from 'react'
import { NumberingTab } from '@/components/invoicing/NumberingTab'
import { INVO, InvoPage, InvoTitle, InvoTabs, InvoIcons } from '@/components/invoicing/invo'

const TABS = [
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

      <InvoTabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.live ? t.label : `${t.label} · soon` }))}
        active={tab}
        onChange={(id) => {
          if (TABS.find((t) => t.id === id)?.live) setTab(id)
        }}
      />

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
