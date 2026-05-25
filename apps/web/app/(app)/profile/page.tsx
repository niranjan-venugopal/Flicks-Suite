'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAuthStore } from '@/lib/stores/auth.store'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  useExportMyData,
  useDeletionRequest,
  useRequestDeletion,
  useCancelDeletion,
} from '@/lib/api/queries/use-auth'

export default function ProfilePage() {
  const { currentUser, currentTenant } = useAuthStore()

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="My profile"
          sub="Your account, employment, and security settings"
          right={
            <Btn kind="secondary" size="sm" icon={<Icon.edit size={13} />}>
              Edit profile
            </Btn>
          }
        />

        {/* Identity card */}
        <div className="card" style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <Avatar name={currentUser?.name ?? ''} size="xl" src={currentUser?.avatarUrl} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t-h1" style={{ fontSize: 24, marginBottom: 6 }}>
                {currentUser?.name ?? 'Guest'}
              </div>
              <div className="t-mute" style={{ fontSize: 13, marginBottom: 8 }}>
                {currentUser?.email ?? '—'} · {currentTenant?.name ?? '—'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Pill tone="green" dot>Active</Pill>
                <Pill>{currentUser?.role?.replace('_', ' ').toLowerCase() ?? 'member'}</Pill>
                {currentUser?.employeeId && (
                  <Pill>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>
                      {currentUser.employeeId.slice(0, 8)}
                    </span>
                  </Pill>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {/* Account info */}
          <div className="card">
            <SectionHead title="Account" sub="Identity and contact details" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Full name" value={currentUser?.name ?? '—'} />
              <Field label="Work email" value={currentUser?.email ?? '—'} mono />
              <Field label="Workspace" value={currentTenant?.name ?? '—'} />
              <Field label="Role" value={currentUser?.role?.replace('_', ' ').toLowerCase() ?? '—'} />
            </div>
          </div>

          {/* Security */}
          <div className="card">
            <SectionHead title="Security" sub="Sign-in method and active sessions" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  padding: '12px 14px',
                  background: 'var(--surf-1)',
                  border: '1px solid var(--bord)',
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <Icon.mail size={16} style={{ color: 'var(--blue)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>Email + OTP</div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                    Passwordless · 6-digit code valid for 10 minutes
                  </div>
                </div>
                <Pill tone="green" dot>Active</Pill>
              </div>
              <Field label="Last sign-in" value={new Date().toLocaleString('en-IN')} />
              <Btn kind="secondary" size="sm" icon={<Icon.refresh size={13} />}>
                Sign out other devices
              </Btn>
            </div>
          </div>
        </div>

        {/* Data & privacy (DPDP) */}
        <DataPrivacyCard />
      </div>
    </div>
  )
}

function DataPrivacyCard() {
  const { toast } = useToast()
  const exportMut = useExportMyData()
  const deletionStatus = useDeletionRequest()
  const requestMut = useRequestDeletion()
  const cancelMut = useCancelDeletion()

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reason, setReason] = useState('')

  const pending = deletionStatus.data?.request ?? null

  const handleExport = async () => {
    try {
      await exportMut.mutateAsync()
      toast({ title: 'Export downloaded', description: 'Your data file is in your downloads.' })
    } catch (e) {
      toast({
        title: 'Could not export',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handleRequestDeletion = async () => {
    try {
      const res = await requestMut.mutateAsync(reason.trim() || undefined)
      toast({
        title: 'Deletion requested',
        description: `Scheduled for ${new Date(res.scheduledFor).toLocaleDateString('en-IN')}. You can cancel any time before then.`,
      })
      setConfirmOpen(false)
      setReason('')
    } catch (e) {
      toast({
        title: 'Could not request deletion',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const handleCancel = async () => {
    try {
      await cancelMut.mutateAsync()
      toast({ title: 'Deletion cancelled', description: 'Your account stays active.' })
    } catch (e) {
      toast({
        title: 'Could not cancel',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <SectionHead title="Data & privacy" sub="Your rights under the DPDP Act 2023" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Export */}
        <Row
          title="Download my data"
          desc="Get a JSON copy of your profile, employment, leave, timesheets and consents."
          action={
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.download size={13} />}
              onClick={handleExport}
              disabled={exportMut.isPending}
            >
              {exportMut.isPending ? 'Preparing…' : 'Download'}
            </Btn>
          }
        />

        {/* Delete */}
        {pending ? (
          <div
            style={{
              padding: '14px 16px',
              background: 'rgba(248,120,107,.07)',
              border: '1px solid rgba(248,120,107,.3)',
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Icon.warn size={16} style={{ color: 'var(--coral)', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800 }}>
                Account deletion scheduled
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                Cool-off ends {new Date(pending.scheduledFor).toLocaleString('en-IN')}. Cancel any time before then.
              </div>
            </div>
            <Btn kind="secondary" size="sm" onClick={handleCancel} disabled={cancelMut.isPending}>
              {cancelMut.isPending ? 'Cancelling…' : 'Cancel request'}
            </Btn>
          </div>
        ) : (
          <Row
            title="Delete my account"
            desc="Requests erasure of your personal login. A 7-day cool-off applies; statutory employment records are retained per law."
            action={
              <Btn
                kind="ghost"
                size="sm"
                icon={<Icon.trash size={13} />}
                style={{ color: 'var(--coral)' }}
                onClick={() => setConfirmOpen(true)}
              >
                Delete account
              </Btn>
            }
          />
        )}

        <div style={{ fontSize: 11.5, color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Read our{' '}
          <Link href="/privacy" target="_blank" style={{ color: 'var(--blue)', fontWeight: 700 }}>
            Privacy Policy
          </Link>{' '}
          or reach the{' '}
          <Link href="/contact" target="_blank" style={{ color: 'var(--blue)', fontWeight: 700 }}>
            Grievance Officer
          </Link>
          .
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
          </DialogHeader>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 12 }}>
            This opens a <strong>7-day cool-off</strong>. After that, your personal
            login and contact data are erased. Statutory employment records (payroll,
            tax) are retained for the legally-required period. You can cancel any time
            during the cool-off.
          </p>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>
            Reason (optional)
          </label>
          <textarea
            className="input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Helps us improve — optional."
            maxLength={500}
            style={{ width: '100%', padding: 10, fontSize: 12.5 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Btn kind="ghost" onClick={() => setConfirmOpen(false)} disabled={requestMut.isPending}>
              Keep my account
            </Btn>
            <Btn kind="danger" onClick={handleRequestDeletion} disabled={requestMut.isPending}>
              {requestMut.isPending ? 'Requesting…' : 'Request deletion'}
            </Btn>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Row({
  title,
  desc,
  action,
}: {
  title: string
  desc: string
  action: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 800 }}>{title}</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2, lineHeight: 1.5 }}>
          {desc}
        </div>
      </div>
      {action}
    </div>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="t-caption" style={{ marginBottom: 5 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: '#fff',
          fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        }}
      >
        {value}
      </div>
    </div>
  )
}
