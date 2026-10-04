'use client'

import { Icon, Pill, SectionHead } from '@/components/proto'

/**
 * Personal document vault. Round P polish: there is no storage/upload backend
 * yet (FEATURES.hr_documents is off and the nav entry is hidden), so a direct
 * URL gets an honest "Coming soon" instead of an Upload button that did
 * nothing and an empty state that promised documents HR cannot add.
 */
export default function MyDocumentsPage() {
  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="My documents"
          sub="Offer letter, payslips, tax forms, and uploads"
          right={<Pill tone="yellow">Coming soon</Pill>}
        />

        <div
          className="card"
          data-testid="documents-coming-soon"
          style={{
            padding: 60,
            textAlign: 'center',
            color: 'var(--text-mute)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <Icon.doc size={28} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>
            Document vault is coming soon
          </div>
          <div style={{ maxWidth: 420, margin: '0 auto', lineHeight: 1.55 }}>
            Offer letters, payslips and tax forms will live here once document storage
            launches. There is nothing to upload yet — HR will share any paperwork with you
            directly until then.
          </div>
        </div>
      </div>
    </div>
  )
}
