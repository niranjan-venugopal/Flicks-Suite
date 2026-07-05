'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import {
  Avatar,
  Btn,
  Icon,
  Kpi,
  Pill,
  SectionHead,
  type PillTone,
} from '@/components/proto'
import { useMyTeam, type TeamMember } from '@/lib/api/queries/use-employees'
import { RowPresenceAvatar, PresenceText } from '@/components/presence/RowPresence'
import { usePresence } from '@/lib/api/queries/use-presence'
import { useTeamToday } from '@/lib/api/queries/use-attendance'
import { usePendingLeaveRequests } from '@/lib/api/queries/use-leave'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function employmentTypeLabel(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function statusTone(s: string): PillTone {
  switch (s) {
    case 'active':         return 'green'
    case 'on_leave':       return 'yellow'
    case 'notice_period':  return 'coral'
    case 'separated':
    case 'absconded':      return 'coral'
    case 'inactive':       return ''
    default:               return ''
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MyTeamPage() {
  const { data: team, isLoading } = useMyTeam()
  const { data: today } = useTeamToday()
  const { data: pendingLeave } = usePendingLeaveRequests()

  const members: TeamMember[] = team?.data ?? []
  // D9 (PRD v4 §5) — seed batched presence for the team.
  usePresence(members.map((m) => m.userId).filter((id): id is string => !!id))

  // ─── KPIs ──────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const directReports = members.length
    const onLeave = members.filter((m) => m.status === 'on_leave').length

    let presentToday = 0
    if (today) {
      presentToday = today.filter((t) =>
        ['present', 'late', 'work_from_home', 'on_duty'].includes(
          t.attendanceStatus ?? '',
        ),
      ).length
    }

    const pending = Array.isArray(pendingLeave) ? pendingLeave.length : 0

    return { directReports, presentToday, onLeave, pending }
  }, [members, today, pendingLeave])

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          maxWidth: 1280,
          margin: '0 auto',
        }}
      >
        <SectionHead
          title="Direct reports"
          sub="Your team at a glance"
          right={
            <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
              Export
            </Btn>
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
          <Kpi
            label="Direct reports"
            value={kpis.directReports.toString()}
            icon={<Icon.people size={14} />}
            accent="blue"
          />
          <Kpi
            label="Present today"
            value={kpis.presentToday.toString()}
            icon={<Icon.check size={14} />}
            accent="green"
          />
          <Kpi
            label="On leave"
            value={kpis.onLeave.toString()}
            icon={<Icon.cal size={14} />}
            accent="purple"
          />
          <Kpi
            label="Pending approvals"
            value={kpis.pending.toString()}
            icon={<Icon.inbox size={14} />}
            accent="yellow"
          />
        </div>

        {isLoading ? (
          <div
            className="card"
            style={{ padding: 60, display: 'flex', justifyContent: 'center' }}
          >
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : members.length === 0 ? (
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
            <Icon.people
              size={28}
              style={{ color: 'var(--text-faint)', marginBottom: 12 }}
            />
            <div
              style={{
                fontSize: 14,
                fontWeight: 800,
                color: '#fff',
                marginBottom: 6,
              }}
            >
              No direct reports yet
            </div>
            <div>Employees with you set as their reporting manager will show up here.</div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                  <th style={th}>Name</th>
                  <th style={th}>Designation</th>
                  <th style={th}>Department</th>
                  <th style={th}>Location</th>
                  <th style={th}>Joined</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m, i, arr) => (
                  <tr
                    key={m.id}
                    style={{
                      borderBottom:
                        i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                    }}
                  >
                    <td style={{ padding: '12px 14px' }}>
                      <div className="flex items-center gap-3">
                        <RowPresenceAvatar
                          name={m.fullName}
                          size={30}
                          src={m.avatarUrl ?? undefined}
                          userId={m.userId}
                        />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
                            {m.fullName}
                            <PresenceText userId={m.userId} />
                          </div>
                          {m.employeeCode && (
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--text-mute)',
                                fontFamily: 'var(--font-mono)',
                              }}
                            >
                              {m.employeeCode}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={td}>{m.designationTitle ?? '—'}</td>
                    <td style={td}>{m.departmentName ?? '—'}</td>
                    <td style={td}>{m.locationName ?? '—'}</td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                      {fmtDate(m.dateOfJoining)}
                    </td>
                    <td style={td}>
                      <div className="flex flex-wrap gap-1.5">
                        <Pill tone={statusTone(m.status)}>
                          {m.status.replace(/_/g, ' ')}
                        </Pill>
                        {m.onboardingComplete === false && (
                          <Pill tone="yellow">Onboarding</Pill>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                      <Link
                        href={`/employees/${m.id}`}
                        style={{ textDecoration: 'none' }}
                      >
                        <Btn kind="ghost" size="sm">
                          View
                        </Btn>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 11.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-mute)',
}

const td: React.CSSProperties = {
  padding: '12px 14px',
  fontSize: 12.5,
  color: 'var(--text-2)',
}
