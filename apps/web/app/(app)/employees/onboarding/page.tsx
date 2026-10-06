'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  isPendingInvite,
  useEmployees,
  useOnboardingQueue,
  useApproveOnboarding,
  useResendAllInvites,
  useResendInvite,
  type Employee,
  type OnboardingQueueRow,
} from '@/lib/api/queries/use-employees'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import { OnboardingReviewDialog } from '@/components/employees/OnboardingReviewDialog'

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

function OnboardingQueueContent() {
  const router = useRouter()
  const sp = useSearchParams()
  const queue = useOnboardingQueue()
  const approve = useApproveOnboarding()
  const { toast } = useToast()

  // The URL is the single source of truth for which hire is being reviewed —
  // notification/email deep links land here as ?employee=<id>.
  const reviewing = sp.get('employee')
  const openReview = (id: string) =>
    router.replace(`/employees/onboarding?employee=${id}`, { scroll: false })
  const closeReview = () => router.replace('/employees/onboarding', { scroll: false })

  const rows = queue.data?.data ?? []
  // Round 18: HR-admin profiles are listed to owners only, so the copy and
  // the badge differ by who is looking.
  const isOwner = useAuthStore((st) => st.currentUser?.role) === 'OWNER'

  const handleApprove = async (row: OnboardingQueueRow) => {
    try {
      await approve.mutateAsync(row.id)
      // Round P R4: the day-one kit is the next thing HR does — the register
      // opens its Assign flow for this person via ?assign=<employeeId>.
      toast({
        title: 'Onboarding approved',
        description: `${rowName(row)} is now active.`,
        action: (
          <ToastAction altText="Assign equipment" onClick={() => router.push(`/employees/assets?assign=${row.id}`)}>
            Assign equipment
          </ToastAction>
        ),
      })
    } catch (e) {
      toast({
        title: 'Could not approve',
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
                {!isOwner && ' HR admins are reviewed by an owner, so their profiles are not listed here.'}
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
                      {/* Round Q: escalated after 24 hours without a decision. */}
                      {row.escalatedAt && <Pill tone="coral">Waiting 24h+</Pill>}
                      {(row.memberRole === 'admin' || row.memberRole === 'owner') && (
                        <Pill tone="blue">Owner approval</Pill>
                      )}
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
                      icon={<Icon.eye size={13} />}
                      onClick={() => openReview(row.id)}
                      disabled={approve.isPending}
                    >
                      Review
                    </Btn>
                    <Btn
                      kind="primary"
                      size="sm"
                      icon={<Icon.check size={13} />}
                      onClick={() => handleApprove(row)}
                      disabled={approve.isPending}
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

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1100, margin: '28px auto 0' }}>
        <InvitedNotStarted />
      </div>

      <OnboardingReviewDialog employeeId={reviewing} onClose={closeReview} />
    </div>
  )
}

/**
 * Round Q (founder: "HR should also have the Resend invite CTA to resend the
 * onboarding") — the people invited who have not submitted yet, with Resend
 * per row and for everyone, right where HR reviews onboarding. Same API and
 * eligibility as the People list (60 s throttle, submitted / removed /
 * switched-off seats skipped server-side).
 */
function InvitedNotStarted() {
  const list = useEmployees({ status: 'inactive', limit: 100 })
  const resend = useResendInvite()
  const resendAll = useResendAllInvites()
  const { toast } = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)
  const rows = (list.data?.employees ?? []).filter((e) => isPendingInvite(e.uiStatus))

  const resendOne = async (e: Employee) => {
    setBusyId(e.id)
    try {
      const r = await resend.mutateAsync(e.id)
      toast(
        r.emailSent
          ? { title: `Invite re-sent to ${e.name}`, description: `${r.email} · earlier links still work.` }
          : {
              title: 'Invite saved but the email could not be sent — try Resend in a minute',
              description: r.email,
              variant: 'destructive',
            },
      )
    } catch (err) {
      toast({ title: 'Could not resend invite', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  const resendEveryone = async () => {
    try {
      const r = await resendAll.mutateAsync(undefined)
      const skipped = r.skipped.length
      toast({
        title: `Re-sent ${r.sent} invite${r.sent === 1 ? '' : 's'}`,
        description:
          skipped === 0
            ? 'Everyone still waiting has a fresh link in their inbox.'
            : `${skipped} skipped — ${r.skipped
                .slice(0, 3)
                .map((x) => `${x.email || 'unknown'}: ${x.reason}`)
                .join('; ')}${skipped > 3 ? '; …' : ''}`,
        variant: r.sent === 0 && skipped > 0 ? 'destructive' : undefined,
      })
    } catch (err) {
      toast({ title: 'Could not resend invites', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
    }
  }

  if (list.isLoading || rows.length === 0) return null
  return (
    <div data-testid="invited-not-started">
      <SectionHead
        title="Invited — not started yet"
        sub={`${rows.length} ${rows.length === 1 ? 'person has' : 'people have'} not finished self-onboarding`}
        right={
          <Btn
            kind="secondary"
            size="sm"
            icon={<Icon.send size={13} />}
            onClick={() => void resendEveryone()}
            disabled={resendAll.isPending}
            data-testid="resend-all-pending"
          >
            {resendAll.isPending ? 'Sending…' : `Resend all (${rows.length})`}
          </Btn>
        }
      />
      <div className="card" style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
        {rows.map((e, i) => (
          <div
            key={e.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 18px',
              borderTop: i === 0 ? 'none' : '1px solid var(--bord)',
              flexWrap: 'wrap',
            }}
          >
            <Avatar name={e.name || e.email} size="sm" src={e.avatarUrl} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Link href={`/employees/${e.id}`} style={{ fontSize: 13.5, fontWeight: 800 }} className="hover:underline">
                  {e.name || e.email}
                </Link>
                <Pill tone={e.uiStatus === 'onboarding' ? 'blue' : ''} dot>
                  {e.uiStatus === 'onboarding' ? 'Onboarding' : 'Invited'}
                </Pill>
                {e.employeeCode && <Pill>{e.employeeCode}</Pill>}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginTop: 3 }}>
                {[e.designation, e.department].filter(Boolean).join(' · ') || e.email}
              </div>
            </div>
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.send size={13} />}
              onClick={() => void resendOne(e)}
              disabled={busyId === e.id || resendAll.isPending}
              data-testid="resend-invite-row"
            >
              {busyId === e.id ? 'Sending…' : 'Resend invite'}
            </Btn>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function OnboardingQueuePage() {
  return (
    <Suspense fallback={null}>
      <OnboardingQueueContent />
    </Suspense>
  )
}
