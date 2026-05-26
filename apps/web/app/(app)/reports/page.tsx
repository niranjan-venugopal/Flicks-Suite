'use client'

import Link from 'next/link'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import type { IconKey } from '@/components/proto'

interface ReportTile {
  href: string
  title: string
  description: string
  icon: IconKey
  iconColor: string
  iconTint: string
  schedule?: string
  status: 'live' | 'soon'
}

const REPORTS: ReportTile[] = [
  {
    href: '/reports/attendance',
    title: 'Attendance compliance',
    description: 'Present-rate, late arrivals, day-by-day trend, per-employee compliance.',
    icon: 'clock',
    iconColor: 'var(--yellow)',
    iconTint: 'rgba(254, 216, 0, 0.13)',
    schedule: 'Weekly · Mon',
    status: 'live',
  },
  {
    href: '/reports/leave',
    title: 'Leave consumption',
    description: 'Approved days by leave type, monthly trend, top consumers.',
    icon: 'cal',
    iconColor: 'var(--coral)',
    iconTint: 'rgba(248, 120, 107, 0.13)',
    status: 'live',
  },
  {
    href: '/reports/headcount',
    title: 'Headcount summary',
    description: 'Active, joined, exited by month with department breakdown.',
    icon: 'people',
    iconColor: 'var(--blue)',
    iconTint: 'rgba(62, 123, 250, 0.13)',
    schedule: 'Monthly · 1st',
    status: 'live',
  },
  {
    href: '/reports/audit',
    title: 'Audit log',
    description: 'Full activity stream for compliance and security review.',
    icon: 'shield',
    iconColor: 'var(--purple)',
    iconTint: 'rgba(155, 123, 250, 0.13)',
    status: 'live',
  },
  {
    href: '/reports/utilization',
    title: 'Timesheet utilization',
    description: 'Billable vs non-billable hours per employee, with utilization %.',
    icon: 'tag',
    iconColor: 'var(--green)',
    iconTint: 'rgba(39, 210, 128, 0.13)',
    status: 'live',
  },
  {
    href: '/reports',
    title: 'Diversity snapshot',
    description: 'Gender, age band, and location distribution. Hardening pass (Sprint 4).',
    icon: 'layers',
    iconColor: 'var(--purple)',
    iconTint: 'rgba(155, 123, 250, 0.13)',
    status: 'soon',
  },
]

export default function ReportsHubPage() {
  return (
    <div className="relative min-h-full">
      <div className="relative z-10 p-8 max-w-6xl mx-auto">
        <SectionHead
          title="Reports"
          sub="Pre-built reports and saved views"
          right={
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />}>
              New report
            </Btn>
          }
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 14,
          }}
        >
          {REPORTS.map((r) => {
            const IconComp = Icon[r.icon]
            const isLive = r.status === 'live'
            const card = (
              <div
                className="card"
                style={{
                  cursor: isLive ? 'pointer' : 'default',
                  opacity: isLive ? 1 : 0.6,
                  height: '100%',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: 14,
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 9,
                      background: r.iconTint,
                      color: r.iconColor,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <IconComp size={17} />
                  </div>
                  {isLive ? (
                    r.schedule && <Pill>{r.schedule}</Pill>
                  ) : (
                    <Pill tone="yellow">Soon</Pill>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    letterSpacing: '-0.01em',
                    marginBottom: 4,
                  }}
                >
                  {r.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-mute)',
                    lineHeight: 1.5,
                    marginBottom: 14,
                  }}
                >
                  {r.description}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn kind="secondary" size="sm" disabled={!isLive}>
                    {isLive ? 'Open' : 'Coming soon'}
                  </Btn>
                  {isLive && (
                    <Btn kind="ghost" size="sm" icon={<Icon.download size={12} />} />
                  )}
                </div>
              </div>
            )

            return isLive ? (
              <Link key={r.title} href={r.href} style={{ textDecoration: 'none' }}>
                {card}
              </Link>
            ) : (
              <div key={r.title}>{card}</div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
