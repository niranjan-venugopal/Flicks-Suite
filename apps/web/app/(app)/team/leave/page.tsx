'use client'

import Link from 'next/link'
import { Btn, Icon, SectionHead } from '@/components/proto'

export default function TeamLeavePage() {
  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Team leave"
          sub="Direct reports' upcoming and recent leave"
          right={
            <Link href="/inbox?filter=leave" style={{ textDecoration: 'none' }}>
              <Btn kind="primary" size="sm" icon={<Icon.inbox size={13} />}>
                Review approvals
              </Btn>
            </Link>
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
          <Icon.cal size={28} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
          <div style={{ fontSize: 14, fontWeight: 800, color: '#fff', marginBottom: 6 }}>
            Team leave roster coming soon
          </div>
          <div>
            For now, pending leave requests for your direct reports appear in the{' '}
            <Link href="/inbox" style={{ color: 'var(--blue)', fontWeight: 700 }}>
              Approvals inbox
            </Link>
            .
          </div>
        </div>
      </div>
    </div>
  )
}
