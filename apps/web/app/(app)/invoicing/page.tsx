'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Kpi, Pill, SectionHead, BarChart } from '@/components/proto'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useInvDashboard, useAging, useInvoices, type InvoiceRow } from '@/lib/api/queries/use-invoicing'
import { daysToGstr1 } from '@/components/invoicing/CompanySwitcher'
import {
  useSetupProgress,
  useUpdateSetupProgress,
  useCompleteWizard,
  type SetupProgress,
  type SetupStepKey,
} from '@/lib/api/queries/use-inv-settings'

/**
 * Invoicing overview (PRD §9 / §11). Behaviour by role + setup state:
 *  - Edit-capable role (Owner/Admin/Finance) with setup INCOMPLETE → setup
 *    wizard (the §11 checklist, "Save → Create first invoice").
 *  - Everyone else (and once setup is complete) → the live dashboard: KPIs,
 *    receivables aging, recent invoices, pending actions. Read-only roles
 *    (Auditor, and Manager/Employee without edit) get a ReadOnlyBanner and no
 *    create/CTA controls.
 */

const inr = (v: string | number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v))

const EDIT_ROLES = new Set(['OWNER', 'HR_ADMIN', 'FINANCE'])

export default function InvoicingHome() {
  const { currentUser } = useAuthStore()
  const role = currentUser?.role
  const canEdit = !!role && EDIT_ROLES.has(role)

  const { data: progressRes, isLoading: progressLoading } = useSetupProgress()
  const progress = progressRes?.data

  // Edit-capable users still onboarding see the wizard; everyone else (and all
  // completed workspaces) go straight to the dashboard.
  if (progressLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Loader2 className="w-7 h-7 animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }
  if (canEdit && progress && !progress.is_complete) {
    return <SetupWizard progress={progress} />
  }
  return <Dashboard readOnly={!canEdit} />
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

function Dashboard({ readOnly }: { readOnly: boolean }) {
  const { data: dashRes, isLoading } = useInvDashboard()
  const { data: agingRes } = useAging()
  const { data: invRes } = useInvoices({ page: 1 })
  const d = dashRes?.data
  const aging = agingRes?.data
  const recent = (invRes?.data ?? []).slice(0, 6)
  const gstr1Days = daysToGstr1()

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Loader2 className="w-7 h-7 animate-spin" style={{ color: 'var(--text-mute)' }} />
      </div>
    )
  }

  return (
    <div style={{ padding: '26px 28px 72px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <SectionHead title="Invoicing overview" sub="Receivables, aging and recent activity at a glance." />
        {!readOnly && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/invoicing/reports" style={{ textDecoration: 'none' }}>
              <Btn kind="secondary" size="sm" icon={<Icon.chart size={14} />}>Reports</Btn>
            </Link>
            <Link href="/invoicing/new" style={{ textDecoration: 'none' }}>
              <Btn kind="primary" size="sm" icon={<Icon.plus size={14} />}>New invoice</Btn>
            </Link>
          </div>
        )}
      </div>

      {readOnly && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 18px',
            padding: '10px 14px', borderRadius: 10,
            background: 'rgba(155,123,250,.08)', border: '1px solid rgba(155,123,250,.25)',
          }}
        >
          <Icon.eye size={15} style={{ color: 'var(--purple)' }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)' }}>
            Read-only view — your access is scoped to viewing. Editing is disabled for your role.
          </span>
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginTop: 8 }}>
        <Kpi label="Outstanding" value={inr(d?.outstanding ?? 0)} icon={<Icon.wallet size={16} />} accent="blue" />
        <Kpi label="Overdue" value={d?.overdue ?? 0} delta="invoices past due" icon={<Icon.warn size={16} />} accent="coral" />
        <Kpi label="Collected" value={inr(d?.collected ?? 0)} delta="lifetime received" icon={<Icon.check size={16} />} accent="green" />
        <Kpi label="Open invoices" value={d?.open ?? 0} delta={`${d?.total ?? 0} total`} icon={<Icon.doc size={16} />} accent="purple" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16, marginTop: 18 }}>
        {/* Recent invoices */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Recent invoices</span>
            <Link href="/invoicing/invoices" style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}>View all</Link>
          </div>
          {recent.length === 0 ? (
            <div className="t-mute" style={{ padding: '18px', fontSize: 12.5 }}>No invoices yet.</div>
          ) : (
            <table className="tbl">
              <thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Status</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {recent.map((r: InvoiceRow) => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      <Link href={`/invoicing/${r.id}/preview`} style={{ color: 'inherit', textDecoration: 'none' }}>{r.invoice_number}</Link>
                    </td>
                    <td>{r.customer_name ?? '—'}</td>
                    <td className="t-mute" style={{ fontSize: 12 }}>{r.due_date}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{inr(r.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Right column: aging + pending actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 12 }}>Receivables aging</div>
            {aging ? (
              <>
                <BarChart
                  data={aging.buckets.map((b, i) => ({
                    label: b.bucket.replace(' days', 'd').replace('Current', 'Curr'),
                    value: Number(b.amount),
                    color: ['#27D280', '#FED800', '#F8786B', '#9B7BFA'][i] ?? '#3E7BFA',
                  }))}
                  h={110}
                />
                <div className="t-mute" style={{ fontSize: 11.5, marginTop: 8 }}>Total outstanding {inr(aging.total)}</div>
              </>
            ) : (
              <div className="t-mute" style={{ fontSize: 12 }}>No receivables.</div>
            )}
          </div>

          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 10 }}>Pending actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <ActionRow
                tone={(d?.overdue ?? 0) > 0 ? 'coral' : ''}
                label={`${d?.overdue ?? 0} overdue invoice${(d?.overdue ?? 0) === 1 ? '' : 's'}`}
                href="/invoicing/invoices?status=OVERDUE"
                readOnly={readOnly}
              />
              <ActionRow
                tone={gstr1Days <= 7 ? 'yellow' : ''}
                label={`GSTR-1 due in ${gstr1Days} day${gstr1Days === 1 ? '' : 's'}`}
                href="/invoicing/reports"
                readOnly={readOnly}
              />
              {!readOnly && (
                <ActionRow tone="" label="Add a bank account for foreign payments" href="/settings/organization" readOnly={readOnly} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionRow({ label, href, tone, readOnly }: { label: string; href: string; tone: '' | 'coral' | 'yellow'; readOnly: boolean }) {
  const dotColor = tone === 'coral' ? 'var(--coral)' : tone === 'yellow' ? 'var(--yellow)' : 'var(--text-faint)'
  const inner = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)' }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: dotColor }} />
      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>{label}</span>
      {!readOnly && <Icon.chevR size={14} style={{ color: 'var(--text-faint)' }} />}
    </div>
  )
  if (readOnly) return inner
  return <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>{inner}</Link>
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'PAID' ? 'green'
      : status === 'OVERDUE' ? 'coral'
      : status === 'PARTIALLY_PAID' ? 'yellow'
      : status === 'DRAFT' ? '' : 'blue'
  return <Pill tone={tone as 'green' | 'coral' | 'yellow' | 'blue' | ''}>{status.replace(/_/g, ' ').toLowerCase()}</Pill>
}

// ─── Setup wizard (PRD §11) ───────────────────────────────────────────────────

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

function SetupWizard({ progress }: { progress: SetupProgress }) {
  const router = useRouter()
  const updateStep = useUpdateSetupProgress()
  const complete = useCompleteWizard()

  const finishWizard = async () => {
    await complete.mutateAsync()
    router.push('/invoicing/new')
  }

  return (
    <div style={{ padding: '26px 28px 72px', maxWidth: 820, margin: '0 auto' }}>
      <SectionHead title="Set up Invoicing" sub="A few quick steps and you'll send your first GST-compliant invoice." />

      <div style={{ marginTop: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span className="t-mute" style={{ fontSize: 12, fontWeight: 700 }}>{progress.completed_steps} of {progress.total_steps} steps done</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--blue)' }}>{progress.percent_complete}%</span>
        </div>
        <div style={{ height: 8, borderRadius: 99, background: 'var(--surf-2)', overflow: 'hidden' }}>
          <div style={{ width: `${progress.percent_complete}%`, height: '100%', background: 'var(--blue)', transition: 'width .25s' }} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
        {STEPS.map((step) => {
          const done = !!progress[step.key]
          return (
            <div key={step.key} className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px' }}>
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
                  {step.optional && <span className="t-mute" style={{ fontSize: 11, fontWeight: 700, marginLeft: 8 }}>optional</span>}
                </div>
                <div className="t-mute" style={{ fontSize: 11.5 }}>{step.sub}</div>
              </div>
              <Link href={step.href} style={{ textDecoration: 'none' }}>
                <Btn kind="ghost" size="sm">Configure</Btn>
              </Link>
              <Btn
                kind={done ? 'ghost' : 'secondary'}
                size="sm"
                disabled={updateStep.isPending}
                onClick={() => updateStep.mutate({ [step.key]: !done })}
              >
                {done ? 'Undo' : 'Mark done'}
              </Btn>
            </div>
          )
        })}
      </div>

      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginTop: 22,
          padding: '18px 20px', borderRadius: 14, background: 'rgba(62,123,250,.08)', border: '1px solid rgba(62,123,250,.25)',
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>Ready when you are</div>
          <div className="t-mute" style={{ fontSize: 12 }}>You can finish setup now — anything skipped stays available under Invoicing → Settings.</div>
        </div>
        <Btn kind="primary" icon={<Icon.plus size={15} />} onClick={finishWizard} disabled={complete.isPending}>
          {complete.isPending ? 'Saving…' : 'Save → Create first invoice'}
        </Btn>
      </div>
    </div>
  )
}
