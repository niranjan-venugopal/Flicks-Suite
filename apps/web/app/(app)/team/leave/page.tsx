'use client'

import Link from 'next/link'
import { useMemo } from 'react'
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
import {
  usePendingLeaveRequests,
  useReviewLeave,
} from '@/lib/api/queries/use-leave'
import { useToast } from '@/components/ui/use-toast'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  })
}

function fmtRange(start: string, end: string): string {
  if (start === end) return fmtDate(start)
  return `${fmtDate(start)} – ${fmtDate(end)}`
}

function typePillTone(code: string | null): PillTone {
  if (!code) return ''
  if (code === 'CL') return 'blue'
  if (code === 'SL' || code === 'ML' || code === 'LOP') return 'coral'
  if (code === 'CO' || code === 'WFH') return 'green'
  return 'purple'
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TeamLeavePage() {
  const { data, isLoading } = usePendingLeaveRequests()
  const review = useReviewLeave()
  const { toast } = useToast()

  const requests = Array.isArray(data) ? data : []

  const kpis = useMemo(() => {
    const total = requests.length
    const totalDays = requests.reduce((sum, r) => sum + (r.totalDays ?? 0), 0)
    const employees = new Set(requests.map((r) => r.employeeId)).size
    return { total, totalDays, employees }
  }, [requests])

  const handleReview = async (
    id: string,
    action: 'approve' | 'reject',
  ) => {
    try {
      await review.mutateAsync({ id, action })
      toast({
        title: action === 'approve' ? 'Leave approved' : 'Leave rejected',
      })
    } catch (e: any) {
      toast({
        title: 'Could not record review',
        description: e?.message,
        variant: 'destructive',
      })
    }
  }

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
          title="Team leave"
          sub="Pending leave requests from your direct reports"
          right={
            <Link href="/inbox" style={{ textDecoration: 'none' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.inbox size={13} />}>
                Full Inbox
              </Btn>
            </Link>
          }
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 14,
            marginBottom: 18,
          }}
        >
          <Kpi
            label="Pending requests"
            value={kpis.total.toString()}
            icon={<Icon.inbox size={14} />}
            accent="yellow"
          />
          <Kpi
            label="Total days requested"
            value={kpis.totalDays.toFixed(1)}
            icon={<Icon.cal size={14} />}
            accent="purple"
          />
          <Kpi
            label="Employees affected"
            value={kpis.employees.toString()}
            icon={<Icon.people size={14} />}
            accent="blue"
          />
        </div>

        {isLoading ? (
          <div
            className="card"
            style={{ padding: 60, display: 'flex', justifyContent: 'center' }}
          >
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : requests.length === 0 ? (
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
            <Icon.cal
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
              No pending leave
            </div>
            <div>You&apos;re all caught up. New requests will appear here.</div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                  <th style={th}>Employee</th>
                  <th style={th}>Type</th>
                  <th style={th}>Dates</th>
                  <th style={th}>Days</th>
                  <th style={th}>Applied</th>
                  <th style={th}>Reason</th>
                  <th style={{ ...th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r, i, arr) => (
                  <tr
                    key={r.id}
                    style={{
                      borderBottom:
                        i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                    }}
                  >
                    <td style={{ padding: '12px 14px' }}>
                      <div className="flex items-center gap-3">
                        <Avatar name={r.employeeName} size="sm" />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>
                            {r.employeeName}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--text-mute)',
                              fontFamily: 'var(--font-mono)',
                            }}
                          >
                            {r.employeeCode}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <Pill tone={typePillTone(r.leaveTypeName)}>
                        {r.leaveTypeName ?? '—'}
                      </Pill>
                    </td>
                    <td style={td}>{fmtRange(r.startDate, r.endDate)}</td>
                    <td
                      style={{
                        ...td,
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 800,
                      }}
                    >
                      {r.totalDays}
                    </td>
                    <td
                      style={{
                        ...td,
                        fontSize: 11,
                        color: 'var(--text-mute)',
                      }}
                    >
                      {new Date(r.appliedAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </td>
                    <td
                      style={{
                        ...td,
                        maxWidth: 220,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.reason ?? undefined}
                    >
                      {r.reason ?? '—'}
                    </td>
                    <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                      <div className="flex justify-end gap-2">
                        <Btn
                          kind="ghost"
                          size="sm"
                          onClick={() => handleReview(r.id, 'reject')}
                          disabled={review.isPending}
                        >
                          Reject
                        </Btn>
                        <Btn
                          kind="primary"
                          size="sm"
                          onClick={() => handleReview(r.id, 'approve')}
                          disabled={review.isPending}
                        >
                          Approve
                        </Btn>
                      </div>
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
