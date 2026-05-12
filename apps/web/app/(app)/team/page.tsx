'use client'

import { Btn, Icon, Kpi, SectionHead } from '@/components/proto'

export default function MyTeamPage() {
  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Direct reports"
          sub="Your team at a glance"
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export
              </Btn>
            </div>
          }
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 14,
            marginBottom: 18,
          }}
        >
          <Kpi label="Direct reports" value="—" icon={<Icon.people size={14} />} accent="blue" />
          <Kpi label="Present today" value="—" icon={<Icon.check size={14} />} accent="green" />
          <Kpi label="On leave" value="—" icon={<Icon.cal size={14} />} accent="purple" />
          <Kpi label="Pending approvals" value="—" icon={<Icon.inbox size={14} />} accent="yellow" />
        </div>

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
          <Icon.people size={28} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
          <div style={{ fontSize: 14, fontWeight: 800, color: '#fff', marginBottom: 6 }}>
            Team roster will populate from your direct reports
          </div>
          <div>Needs the &quot;list my direct reports&quot; endpoint (PRD §5.6).</div>
        </div>
      </div>
    </div>
  )
}
