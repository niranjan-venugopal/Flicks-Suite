'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Modal, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useEmployee,
  useApproveOnboarding,
  useRejectOnboarding,
  useOnboardingQueue,
} from '@/lib/api/queries/use-employees'
import { Card, Grid, Field, fmtDate, fmtAddress, fmtPhone } from './detail-kit'

/**
 * The review surface behind the "submitted onboarding for review"
 * notification: everything the new hire entered in the wizard (sensitive
 * fields masked exactly like the employee 360° page), with Approve /
 * Send-back right in the footer. Hosted by the onboarding queue page and
 * deep-linked as /employees/onboarding?employee=<id>.
 */
export function OnboardingReviewDialog({
  employeeId,
  onClose,
}: {
  employeeId: string | null
  onClose: () => void
}) {
  const { toast } = useToast()
  const { data: e, isLoading } = useEmployee(employeeId ?? '')
  const approve = useApproveOnboarding()
  const reject = useRejectOnboarding()
  const [mode, setMode] = useState<'review' | 'sendback'>('review')
  const [reason, setReason] = useState('')
  const busy = approve.isPending || reject.isPending
  // This dialog is deep-linkable (?employee=<id>), so a stale link can point
  // at a hire the viewer may not review — an HR admin's file is the owner's
  // to sign off (round 18). The queue is the authority; the server enforces.
  const queue = useOnboardingQueue()
  const notReviewable =
    !queue.isLoading &&
    !!employeeId &&
    !(queue.data?.data ?? []).some((r) => r.id === employeeId)

  if (!employeeId) return null

  const close = () => {
    if (busy) return
    setMode('review')
    setReason('')
    onClose()
  }

  const name = e
    ? (e.userFullName ?? [e.firstName, e.lastName].filter(Boolean).join(' ')) ||
      e.workEmail
    : 'New hire'
  const primaryEmergency = e
    ? (e.emergencyContacts.find((c) => c.isPrimary) ?? e.emergencyContacts[0])
    : undefined

  const handleApprove = async () => {
    try {
      await approve.mutateAsync(employeeId)
      toast({ title: 'Onboarding approved', description: `${name} is now active.` })
      close()
    } catch (err) {
      toast({
        title: 'Could not approve',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handleSendBack = async () => {
    try {
      await reject.mutateAsync({ id: employeeId, reason: reason.trim() || undefined })
      toast({ title: 'Sent back for changes', description: `${name} can edit and resubmit.` })
      close()
    } catch (err) {
      toast({
        title: 'Could not reject',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <Modal
      open
      onClose={close}
      width={720}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          {name}
          {e?.status !== 'active' && <Pill tone="yellow" dot>Pending review</Pill>}
        </span>
      }
      sub="Submitted onboarding details — approve to activate"
      footer={
        notReviewable ? (
          <>
            <span
              style={{
                flex: 1,
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--text-mute)',
              }}
            >
              An owner reviews this profile.
            </span>
            <Btn kind="ghost" onClick={close}>Close</Btn>
          </>
        ) : mode === 'review' ? (
          <>
            <Btn kind="ghost" onClick={close} disabled={busy}>Cancel</Btn>
            <Btn kind="secondary" onClick={() => setMode('sendback')} disabled={busy}>
              Send back
            </Btn>
            <Btn kind="primary" icon={<Icon.check size={14} />} onClick={() => void handleApprove()} disabled={busy || !e}>
              {approve.isPending ? 'Approving…' : 'Approve'}
            </Btn>
          </>
        ) : (
          <>
            <Btn kind="ghost" onClick={() => setMode('review')} disabled={busy}>Back</Btn>
            <Btn kind="secondary" onClick={() => void handleSendBack()} disabled={busy}>
              {reject.isPending ? 'Sending…' : 'Send back'}
            </Btn>
          </>
        )
      }
    >
      {mode === 'sendback' ? (
        <div>
          <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
            {name} will be notified and can edit their details and resubmit.
          </p>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>
            Reason (optional)
          </label>
          <textarea
            className="input"
            rows={4}
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="What should they correct before resubmitting?"
            maxLength={500}
            style={{ width: '100%', padding: 10, fontSize: 12.5, lineHeight: 1.5 }}
            autoFocus
          />
        </div>
      ) : isLoading || !e ? (
        <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
          <Loader2 className="animate-spin" style={{ color: 'var(--text-mute)' }} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card title="Personal & contact">
            <Grid cols={2}>
              <Field label="Work email" value={e.workEmail || '—'} />
              <Field label="Personal email" value={e.personalEmail || '—'} />
              <Field label="Work phone" value={fmtPhone(e.workPhone)} />
              <Field label="Personal phone" value={fmtPhone(e.personalPhone)} />
              <Field label="Date of birth" value={fmtDate(e.dateOfBirth)} />
              <Field label="Gender" value={e.gender ? e.gender.replace(/_/g, ' ') : '—'} capitalize />
              <Field label="Marital status" value={e.maritalStatus ?? '—'} capitalize />
              <Field label="Blood group" value={e.bloodGroup ?? '—'} />
              <Field label="Current address" value={fmtAddress(e.currentAddress)} span={2} />
              <Field
                label="Emergency contact"
                value={
                  primaryEmergency
                    ? `${primaryEmergency.name} · ${primaryEmergency.relationship} · ${primaryEmergency.phone}`
                    : '—'
                }
                span={2}
              />
            </Grid>
          </Card>

          <Card title="Employment">
            <Grid cols={3}>
              <Field label="Job title" value={e.designationTitle ?? '—'} />
              <Field label="Department" value={e.departmentName ?? '—'} />
              <Field label="Date of joining" value={fmtDate(e.dateOfJoining)} />
            </Grid>
          </Card>

          <Card title="Statutory & banking">
            <Grid cols={2}>
              <Field
                label="PAN"
                value={e.hasPan ? '•••• •••• ••••' : '—'}
                mono
                hint={e.hasPan ? 'Encrypted — view requires re-auth' : undefined}
              />
              <Field label="Passport / ID" value={e.hasPassport ? '•••• •••• ••••' : 'Not on file'} mono />
              <Field label="Aadhaar (last 4)" value={e.aadhaarLast4 ? `•••• ${e.aadhaarLast4}` : '—'} mono />
              <Field label="PF UAN" value={e.pfUan ?? '—'} mono />
              <Field
                label="Bank"
                value={e.bankName ? `${e.bankName}${e.bankBranch ? ' · ' + e.bankBranch : ''}` : '—'}
              />
              <Field
                label="Account"
                value={e.hasBankAccount ? '•••• 0000' : '—'}
                mono
                hint={e.bankAccountType ? `${e.bankAccountType.replace('_', ' ')}` : undefined}
              />
              <Field label="IFSC" value={e.bankIfsc ?? '—'} mono />
              <Field label="Account holder" value={e.bankAccountHolder ?? '—'} />
            </Grid>
          </Card>
        </div>
      )}
    </Modal>
  )
}
