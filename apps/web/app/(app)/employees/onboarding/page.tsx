'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  useOnboardingQueue,
  useApproveOnboarding,
  useRejectOnboarding,
  type OnboardingQueueRow,
} from '@/lib/api/queries/use-employees'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

function rowName(r: OnboardingQueueRow): string {
  return (r.fullName ?? '').trim() || r.email || r.employeeCode || 'New hire'
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function OnboardingQueuePage() {
  const queue = useOnboardingQueue()
  const approve = useApproveOnboarding()
  const reject = useRejectOnboarding()
  const { toast } = useToast()

  const [rejecting, setRejecting] = useState<OnboardingQueueRow | null>(null)
  const [reason, setReason] = useState('')

  const rows = queue.data?.data ?? []

  const handleApprove = async (row: OnboardingQueueRow) => {
    try {
      await approve.mutateAsync(row.id)
      toast({ title: 'Onboarding approved', description: `${rowName(row)} is now active.` })
    } catch (e) {
      toast({
        title: 'Could not approve',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handleReject = async () => {
    if (!rejecting) return
    try {
      await reject.mutateAsync({ id: rejecting.id, reason: reason.trim() || undefined })
      toast({
        title: 'Sent back for changes',
        description: `${rowName(rejecting)} can edit and resubmit.`,
      })
      setRejecting(null)
      setReason('')
    } catch (e) {
      toast({
        title: 'Could not reject',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1100, margin: '0 auto' }}>
        <SectionHead
          title="Onboarding queue"
          sub={`${rows.length} ${rows.length === 1 ? 'hire' : 'hires'} awaiting your approval`}
          right={
            <Link href="/employees">
              <Btn kind="secondary" size="sm" icon={<Icon.people size={13} />}>
                All employees
              </Btn>
            </Link>
          }
        />

        <div className="card" style={{ marginTop: 18, padding: 0, overflow: 'hidden' }}>
          {queue.isLoading ? (
            <div style={{ padding: 56, display: 'flex', justifyContent: 'center' }}>
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--text-mute)' }} />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '56px 24px', textAlign: 'center' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                <Icon.check size={28} />
              </div>
              <div className="t-h3" style={{ marginBottom: 4 }}>All caught up</div>
              <p className="t-mute" style={{ fontSize: 13 }}>
                No employees are waiting for onboarding approval right now.
              </p>
            </div>
          ) : (
            <div>
              {rows.map((row, i) => (
                <div
                  key={row.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '14px 18px',
                    borderTop: i === 0 ? 'none' : '1px solid var(--bord)',
                    flexWrap: 'wrap',
                  }}
                >
                  <Avatar name={rowName(row)} size="sm" src={row.avatarUrl ?? undefined} />
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Link
                        href={`/employees/${row.id}`}
                        style={{ fontSize: 14, fontWeight: 800 }}
                        className="hover:underline"
                      >
                        {rowName(row)}
                      </Link>
                      <Pill tone="yellow" dot>Pending</Pill>
                      {row.employeeCode && <Pill>{row.employeeCode}</Pill>}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginTop: 3 }}>
                      {[row.designationTitle, row.departmentName].filter(Boolean).join(' · ') || row.email}
                      {' · submitted '}{fmtDate(row.submittedAt)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn
                      kind="secondary"
                      size="sm"
                      onClick={() => { setRejecting(row); setReason('') }}
                      disabled={approve.isPending || reject.isPending}
                    >
                      Send back
                    </Btn>
                    <Btn
                      kind="primary"
                      size="sm"
                      icon={<Icon.check size={13} />}
                      onClick={() => handleApprove(row)}
                      disabled={approve.isPending || reject.isPending}
                    >
                      Approve
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!rejecting} onOpenChange={(o) => { if (!o) { setRejecting(null); setReason('') } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send onboarding back for changes</DialogTitle>
          </DialogHeader>
          {rejecting && (
            <>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
                {rowName(rejecting)} will be notified and can edit their details and resubmit.
              </p>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Reason (optional)
              </label>
              <textarea
                className="input"
                rows={4}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What should they correct before resubmitting?"
                maxLength={500}
                style={{ width: '100%', padding: 10, fontSize: 12.5, lineHeight: 1.5 }}
                autoFocus
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <Btn kind="ghost" onClick={() => { setRejecting(null); setReason('') }} disabled={reject.isPending}>
                  Cancel
                </Btn>
                <Btn kind="secondary" onClick={handleReject} disabled={reject.isPending}>
                  {reject.isPending ? 'Sending…' : 'Send back'}
                </Btn>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
