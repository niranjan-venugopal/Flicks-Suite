'use client'

import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { usePendingTimesheets, useReviewTimesheet } from '@/lib/api/queries/use-timesheets'
import { useToast } from '@/components/ui/use-toast'

export default function TeamTimesheetsPage() {
  const pending = usePendingTimesheets()
  const review = useReviewTimesheet()
  const { toast } = useToast()

  const rows = pending.data?.data ?? []

  const handleReview = async (periodId: string, action: 'approve' | 'reject') => {
    try {
      await review.mutateAsync({ periodId, action })
      toast({ title: action === 'approve' ? 'Approved' : 'Rejected' })
    } catch (e) {
      toast({
        title: 'Could not submit review',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Team timesheets"
          sub={`${rows.length} ${rows.length === 1 ? 'period' : 'periods'} pending your review`}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="secondary" size="sm" icon={<Icon.filter size={13} />}>
                Filter
              </Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export
              </Btn>
            </div>
          }
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {pending.isLoading ? (
            <div
              style={{
                padding: 48,
                textAlign: 'center',
                color: 'var(--text-mute)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <Loader2 className="w-4 h-4 animate-spin" /> Loading pending timesheets…
            </div>
          ) : rows.length === 0 ? (
            <div
              style={{
                padding: 60,
                textAlign: 'center',
                color: 'var(--text-mute)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              All caught up. No timesheets waiting on you.
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Week</th>
                  <th>Hours</th>
                  <th>Submitted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                        <Avatar name={r.employeeId ?? 'Employee'} size="sm" />
                        <div style={{ fontSize: 13, fontWeight: 800 }}>
                          {r.employeeId ?? 'Employee'}
                        </div>
                      </div>
                    </td>
                    <td>
                      {r.periodStart} – {r.periodEnd}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                      {r.totalHours.toFixed(1)}h
                    </td>
                    <td>
                      <Pill tone="blue" dot>Submitted</Pill>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <Btn
                          kind="secondary"
                          size="sm"
                          icon={<Icon.x size={12} />}
                          onClick={() => handleReview(r.id, 'reject')}
                          disabled={review.isPending}
                        />
                        <Btn
                          kind="primary"
                          size="sm"
                          icon={<Icon.check size={12} />}
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
          )}
        </div>

        <div
          style={{
            marginTop: 14,
            padding: '10px 12px',
            background: 'rgba(254,216,0,.06)',
            border: '1px solid rgba(254,216,0,.25)',
            borderRadius: 8,
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--text-2)',
          }}
        >
          ⚠ The timesheet backend currently returns an empty pending list. UI is wired
          to render real rows once the service is implemented (PRD §8 / Gate 7).
        </div>
      </div>
    </div>
  )
}
