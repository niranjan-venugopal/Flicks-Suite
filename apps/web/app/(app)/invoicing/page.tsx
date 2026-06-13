'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, SectionHead } from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  useSetupProgress,
  useUpdateSetupProgress,
  useCompleteWizard,
  type SetupProgress,
  type SetupStepKey,
} from '@/lib/api/queries/use-inv-settings'

/**
 * Invoicing overview (PRD §11). On first entry — before the setup wizard is
 * completed — this is the guided checklist that walks an owner through the ~11
 * configuration steps and ends on "Save → Create first invoice." Once complete
 * it becomes a light landing with quick links into the module.
 */

interface Step {
  key: SetupStepKey
  label: string
  sub: string
  href: string
  optional?: boolean
}

const STEPS: Step[] = [
  { key: 'business_details_confirmed', label: 'Confirm business details', sub: 'GSTIN, PAN, address & state', href: '/settings/organization' },
  { key: 'numbering_configured', label: 'Set invoice numbering', sub: 'Prefix, FY format, starting number', href: '/invoicing/settings' },
  { key: 'payment_terms_set', label: 'Default payment terms', sub: 'Net days applied to new invoices', href: '/invoicing/settings' },
  { key: 'default_gst_set', label: 'Default GST & compliance', sub: 'Filing frequency, default rate', href: '/invoicing/settings' },
  { key: 'template_chosen', label: 'Confirm template & brand', sub: 'Logo + brand colour', href: '/invoicing/settings' },
  { key: 'upi_configured', label: 'Add UPI for payments', sub: 'Shown as a QR on INR invoices', href: '/invoicing/settings' },
  { key: 'default_notes_set', label: 'Default notes & terms', sub: 'Pre-filled on every invoice', href: '/invoicing/settings' },
  { key: 'email_signature_set', label: 'Email signature', sub: 'Appended to customer emails', href: '/invoicing/settings' },
  { key: 'currencies_enabled', label: 'Enable currencies', sub: 'INR is always on; add foreign', href: '/invoicing/settings' },
  { key: 'reminder_schedule_set', label: 'Reminder schedule', sub: 'Automatic overdue nudges', href: '/invoicing/settings' },
  { key: 'razorpay_connected', label: 'Connect Razorpay', sub: 'Optional — cards, netbanking, intl', href: '/invoicing/settings', optional: true },
]

export default function InvoicingHome() {
  const router = useRouter()
  const { currentUser } = useAuthStore()
  const { data, isLoading } = useSetupProgress()
  const updateStep = useUpdateSetupProgress()
  const complete = useCompleteWizard()

  const progress = data?.data
  const canEdit = currentUser?.role === 'OWNER' || currentUser?.role === 'HR_ADMIN'

  if (isLoading || !progress) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Loader2 className="w-7 h-7 animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }

  if (progress.is_complete) {
    return <CompleteLanding />
  }

  const finishWizard = async () => {
    await complete.mutateAsync()
    router.push('/invoicing/new')
  }

  return (
    <div style={{ padding: '26px 28px 72px', maxWidth: 820, margin: '0 auto' }}>
      <SectionHead
        title="Set up Invoicing"
        sub="A few quick steps and you'll send your first GST-compliant invoice."
      />

      <ProgressBar progress={progress} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
        {STEPS.map((step) => {
          const done = !!progress[step.key]
          return (
            <div
              key={step.key}
              className="card"
              style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px' }}
            >
              <div
                style={{
                  width: 26, height: 26, borderRadius: 8, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: done ? 'rgba(39,210,128,.16)' : 'var(--surf-2)',
                  color: done ? 'var(--green)' : 'var(--text-faint)',
                  border: `1px solid ${done ? 'rgba(39,210,128,.4)' : 'var(--bord)'}`,
                }}
              >
                {done && <Icon.check size={15} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 800 }}>
                  {step.label}
                  {step.optional && (
                    <span className="t-mute" style={{ fontSize: 11, fontWeight: 700, marginLeft: 8 }}>optional</span>
                  )}
                </div>
                <div className="t-mute" style={{ fontSize: 11.5 }}>{step.sub}</div>
              </div>
              <Link href={step.href} style={{ textDecoration: 'none' }}>
                <Btn kind="ghost" size="sm">Configure</Btn>
              </Link>
              {canEdit && (
                <Btn
                  kind={done ? 'ghost' : 'secondary'}
                  size="sm"
                  disabled={updateStep.isPending}
                  onClick={() => updateStep.mutate({ [step.key]: !done })}
                >
                  {done ? 'Undo' : 'Mark done'}
                </Btn>
              )}
            </div>
          )
        })}
      </div>

      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, marginTop: 22, padding: '18px 20px', borderRadius: 14,
          background: 'rgba(62,123,250,.08)', border: '1px solid rgba(62,123,250,.25)',
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>Ready when you are</div>
          <div className="t-mute" style={{ fontSize: 12 }}>
            You can finish setup now — anything skipped stays available under Invoicing → Settings.
          </div>
        </div>
        <Btn
          kind="primary"
          icon={<Icon.plus size={15} />}
          onClick={finishWizard}
          disabled={!canEdit || complete.isPending}
          title={canEdit ? undefined : 'Only an owner or admin can complete setup'}
        >
          {complete.isPending ? 'Saving…' : 'Save → Create first invoice'}
        </Btn>
      </div>
    </div>
  )
}

function ProgressBar({ progress }: { progress: SetupProgress }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="t-mute" style={{ fontSize: 12, fontWeight: 700 }}>
          {progress.completed_steps} of {progress.total_steps} steps done
        </span>
        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--blue)' }}>{progress.percent_complete}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
        <div
          style={{
            width: `${progress.percent_complete}%`, height: '100%',
            background: 'var(--blue)', transition: 'width .25s',
          }}
        />
      </div>
    </div>
  )
}

function CompleteLanding() {
  const tiles = [
    { href: '/invoicing/invoices', icon: 'doc' as const, label: 'Invoices', sub: 'Create, send & track' },
    { href: '/invoicing/customers', icon: 'people' as const, label: 'Customers', sub: 'Your billing contacts' },
    { href: '/invoicing/reports', icon: 'chart' as const, label: 'Reports', sub: 'Aging, revenue, GSTR-1' },
    { href: '/invoicing/settings', icon: 'cog' as const, label: 'Settings', sub: 'Numbering, template, tax' },
  ]
  return (
    <div style={{ padding: '26px 28px 72px' }}>
      <SectionHead title="Invoicing overview" sub="Setup complete — your workspace is ready." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginTop: 8 }}>
        {tiles.map((t) => {
          const IconCmp = Icon[t.icon]
          return (
            <Link key={t.href} href={t.href} style={{ textDecoration: 'none' }}>
              <div className="card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ color: 'var(--blue)' }}><IconCmp size={22} /></div>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{t.label}</div>
                <div className="t-mute" style={{ fontSize: 12 }}>{t.sub}</div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
