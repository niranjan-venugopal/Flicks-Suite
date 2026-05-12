'use client'

import { Btn, Icon, SectionHead } from '@/components/proto'

export default function MyDocumentsPage() {
  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="My documents"
          sub="Offer letter, payslips, tax forms, and uploads"
          right={
            <Btn kind="primary" size="sm" icon={<Icon.upload size={13} />}>
              Upload
            </Btn>
          }
        />

        <div
          className="card"
          style={{
            padding: 60,
            textAlign: 'center',
            color: 'var(--text-mute)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <Icon.doc size={28} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
          <div style={{ fontSize: 14, fontWeight: 800, color: '#fff', marginBottom: 6 }}>
            No documents yet
          </div>
          <div>Personal documents will appear here once HR uploads them or you submit your own.</div>
        </div>
      </div>
    </div>
  )
}
