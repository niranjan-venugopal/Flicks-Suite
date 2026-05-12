'use client'

import { Btn, Icon, Kpi, SectionHead } from '@/components/proto'

export default function TeamAttendancePage() {
  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Team attendance"
          sub="Live · direct reports across locations"
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />}>
                Today
              </Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export
              </Btn>
            </div>
          }
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 12,
            marginBottom: 18,
          }}
        >
          <Kpi label="In office" value="—" icon={<Icon.building size={14} />} accent="green" />
          <Kpi label="WFH" value="—" icon={<Icon.home size={14} />} accent="blue" />
          <Kpi label="On leave" value="—" icon={<Icon.cal size={14} />} accent="purple" />
          <Kpi label="Yet to clock in" value="—" icon={<Icon.clock size={14} />} accent="yellow" />
          <Kpi label="Late > 15m" value="—" icon={<Icon.warn size={14} />} accent="coral" />
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
          <Icon.clock size={28} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
          <div style={{ fontSize: 14, fontWeight: 800, color: '#fff', marginBottom: 6 }}>
            Team attendance roster coming soon
          </div>
          <div>Needs the team-roster + attendance-by-employee endpoint (PRD §6.6).</div>
        </div>
      </div>
    </div>
  )
}
