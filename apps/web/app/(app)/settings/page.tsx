'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Camera } from 'lucide-react'
import { Btn, Pill, SectionHead, Skeleton, SkeletonCard, avBg, initials, type PillTone } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { MediaCropModal } from '@/components/media/MediaCropModal'
import { useUploadLogo, useRemoveLogo } from '@/lib/api/queries/use-media'
import {
  useOrganization,
  useUpdateOrganization,
  type UpdateOrganizationPayload,
} from '@/lib/api/queries/use-settings'
import { useToast } from '@/components/ui/use-toast'

// ─── Static option lists (PRD §4.3) ──────────────────────────────────────────

const INDUSTRY_OPTIONS = [
  'Technology',
  'Manufacturing',
  'Retail',
  'Financial Services',
  'Healthcare',
  'Education',
  'Consulting',
  'Media & Entertainment',
  'Logistics',
  'Real Estate',
  'Other',
] as const

const SIZE_OPTIONS = [
  '1-10',
  '11-50',
  '51-200',
  '201-500',
  '501-1000',
  '1000+',
] as const

const STATE_CODES = [
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN',
  'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD',
  'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OR', 'PB', 'PY', 'RJ',
  'SK', 'TN', 'TR', 'TS', 'UK', 'UP', 'WB',
] as const

// ─── Status pill helper ──────────────────────────────────────────────────────

function statusPill(status: string) {
  const tone: PillTone =
    status === 'active' ? 'green'
    : status === 'trialing' ? 'yellow'
    : status === 'suspended' ? 'coral'
    : 'purple'
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  return <Pill tone={tone} dot>{label}</Pill>
}

// ─── Field block ─────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
  span = 1,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  span?: 1 | 2 | 3
}) {
  const colSpan = span === 3 ? 'md:col-span-3' : span === 2 ? 'md:col-span-2' : 'md:col-span-1'
  return (
    <div className={`flex flex-col gap-1.5 ${colSpan}`}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-xs text-brand-muted">{hint}</p>}
    </div>
  )
}

// ─── Form state helpers ──────────────────────────────────────────────────────

type FormState = {
  name: string
  legalName: string
  industry: string
  sizeBand: string
  gstin: string
  pan: string
  cin: string
  addressLine1: string
  addressLine2: string
  city: string
  stateCode: string
  postalCode: string
}

function toForm(org: ReturnType<typeof useOrganization>['data']): FormState {
  return {
    name: org?.name ?? '',
    legalName: org?.legalName ?? '',
    industry: org?.industry ?? '',
    sizeBand: org?.sizeBand ?? '',
    gstin: org?.gstin ?? '',
    pan: org?.pan ?? '',
    cin: org?.cin ?? '',
    addressLine1: org?.addressLine1 ?? '',
    addressLine2: org?.addressLine2 ?? '',
    city: org?.city ?? '',
    stateCode: org?.stateCode ?? '',
    postalCode: org?.postalCode ?? '',
  }
}

function diffPayload(form: FormState, baseline: FormState): UpdateOrganizationPayload {
  const out: UpdateOrganizationPayload = {}
  ;(Object.keys(form) as Array<keyof FormState>).forEach((k) => {
    const next = form[k].trim()
    const prev = (baseline[k] ?? '').trim()
    if (next !== prev) {
      out[k] = next.length === 0 ? '' : next
    }
  })
  return out
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/

// ─── Page ────────────────────────────────────────────────────────────────────

export default function OrganizationSettingsPage() {
  const { data: org, isLoading } = useOrganization()
  const update = useUpdateOrganization()
  const uploadLogo = useUploadLogo()
  const removeLogo = useRemoveLogo()
  const [logoModalOpen, setLogoModalOpen] = useState(false)
  const { toast } = useToast()

  const [form, setForm] = useState<FormState>(toForm(undefined))
  const [baseline, setBaseline] = useState<FormState>(toForm(undefined))

  // Reset form state when the server payload changes (initial load, after save).
  useEffect(() => {
    if (org) {
      const next = toForm(org)
      setForm(next)
      setBaseline(next)
    }
  }, [org])

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [form, baseline],
  )

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((p) => ({ ...p, [key]: value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty) return

    // Client-side validation (server enforces too)
    if (!form.name.trim()) {
      toast({ title: 'Workspace name is required', variant: 'destructive' })
      return
    }
    if (form.gstin && !GSTIN_RE.test(form.gstin)) {
      toast({
        title: 'Invalid GSTIN',
        description: '15 characters: 2 state digits, 10 PAN, 1 entity, "Z", 1 checksum.',
        variant: 'destructive',
      })
      return
    }
    if (form.pan && !PAN_RE.test(form.pan)) {
      toast({
        title: 'Invalid PAN',
        description: '10 characters: 5 letters, 4 digits, 1 letter.',
        variant: 'destructive',
      })
      return
    }

    try {
      await update.mutateAsync(diffPayload(form, baseline))
      toast({
        title: 'Workspace updated',
        description: 'Your changes are live across the workspace.',
      })
    } catch (err: any) {
      toast({
        title: 'Save failed',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleReset = () => setForm(baseline)

  if (isLoading || !org) {
    return (
      <SettingsLayout>
        <div className="flex flex-col gap-6">
          <div className="card p-6 flex items-center gap-6">
            <Skeleton w={64} h={64} r="50%" />
            <div className="flex-1 flex flex-col gap-2">
              <Skeleton w={220} h={18} />
              <Skeleton w={320} h={12} />
            </div>
          </div>
          <SkeletonCard lines={4} />
          <SkeletonCard lines={3} />
        </div>
      </SettingsLayout>
    )
  }

  const planLabel = org.status === 'trialing' ? 'Trial' : org.status === 'active' ? 'Paid' : '—'
  const created = new Date(org.createdAt).toLocaleDateString('en-IN', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <SettingsLayout>
      <SectionHead
        title="Organization"
        sub="Your workspace identity, registered address, and tax IDs."
        right={statusPill(org.status)}
      />

        {/* ─── Overview card ──────────────────────────────────────────────── */}
        <div className="card mb-6 p-6 flex flex-wrap items-center gap-6">
          {/* D7 (PRD v4 §4.1) — org logo, circular in-app; camera badge opens the crop modal */}
          <div className="relative shrink-0">
            <div
              className="w-16 h-16 rounded-full overflow-hidden flex items-center justify-center text-white font-extrabold text-xl"
              style={{ background: org.logoUrl ? 'var(--surf-2)' : avBg(org.name) }}
            >
              {org.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={org.logoUrl} alt="Logo" className="w-full h-full object-cover" />
              ) : (
                initials(org.name)
              )}
            </div>
            <button
              type="button"
              title="Change logo"
              onClick={() => setLogoModalOpen(true)}
              className="absolute -bottom-0.5 -right-0.5 w-[26px] h-[26px] rounded-full flex items-center justify-center text-white cursor-pointer"
              style={{ background: 'var(--blue)', border: '2.5px solid var(--surf-1)' }}
            >
              <Camera className="w-[13px] h-[13px]" />
            </button>
          </div>
          <div className="flex-1 min-w-[240px]">
            <div className="t-h2">{org.name}</div>
            <div className="t-mute mt-1">
              <code className="px-1.5 py-0.5 rounded bg-white/5">{org.slug}</code>
              <span className="mx-2 opacity-40">•</span>
              {org.industry || '—'}
              <span className="mx-2 opacity-40">•</span>
              {org.sizeBand ? `${org.sizeBand} employees` : '—'}
            </div>
            <div className="t-caption mt-2">Created {created} · {planLabel} plan</div>
          </div>
          <div className="flex gap-3">
            <div className="px-4 py-3 rounded-lg bg-white/5 border border-white/8 min-w-[100px]">
              <div className="t-caption">Members</div>
              <div className="text-xl font-semibold text-white mt-0.5">{org.counts.activeMembers}</div>
            </div>
            <div className="px-4 py-3 rounded-lg bg-white/5 border border-white/8 min-w-[100px]">
              <div className="t-caption">Locations</div>
              <div className="text-xl font-semibold text-white mt-0.5">{org.counts.locations}</div>
            </div>
            <div className="px-4 py-3 rounded-lg bg-white/5 border border-white/8 min-w-[100px]">
              <div className="t-caption">Departments</div>
              <div className="text-xl font-semibold text-white mt-0.5">{org.counts.departments}</div>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* ─── Workspace details ──────────────────────────────────────── */}
          <section className="card p-6">
            <div className="mb-4">
              <h2 className="t-h3">Workspace details</h2>
              <p className="t-mute mt-1">How your workspace appears across the product.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Workspace name" span={2}>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="Acme, Inc."
                  maxLength={100}
                />
              </Field>
              <Field label="Slug" hint="Immutable; used in URLs and audit logs.">
                <input
                  className="input opacity-60 cursor-not-allowed"
                  value={org.slug}
                  readOnly
                />
              </Field>
              <Field label="Legal entity name" span={3} hint="Used on invoices and HR documents.">
                <input
                  className="input"
                  value={form.legalName}
                  onChange={(e) => set('legalName', e.target.value)}
                  placeholder="Acme Corporation Pvt Ltd"
                  maxLength={200}
                />
              </Field>
              <Field label="Industry">
                <select
                  className="input"
                  value={form.industry}
                  onChange={(e) => set('industry', e.target.value)}
                >
                  <option value="">Select…</option>
                  {INDUSTRY_OPTIONS.map((i) => (
                    <option key={i} value={i}>{i}</option>
                  ))}
                </select>
              </Field>
              <Field label="Company size">
                <select
                  className="input"
                  value={form.sizeBand}
                  onChange={(e) => set('sizeBand', e.target.value)}
                >
                  <option value="">Select…</option>
                  {SIZE_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s} employees</option>
                  ))}
                </select>
              </Field>
              {/* Logo is changed via the camera badge on the overview card above —
                  one control only (user decision, 2026-07-06) */}
            </div>
          </section>

          {/* ─── Tax & legal ────────────────────────────────────────────── */}
          <section className="card p-6">
            <div className="mb-4">
              <h2 className="t-h3">Tax & legal identifiers</h2>
              <p className="t-mute mt-1">Indian statutory IDs used for compliance and payroll exports (PRD §4.3).</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="GSTIN" hint="15 characters. State code auto-detected.">
                <input
                  className="input font-mono uppercase"
                  value={form.gstin}
                  onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                  placeholder="27AABCU9603R1ZX"
                  maxLength={15}
                />
              </Field>
              <Field label="PAN" hint="10 characters.">
                <input
                  className="input font-mono uppercase"
                  value={form.pan}
                  onChange={(e) => set('pan', e.target.value.toUpperCase())}
                  placeholder="AABCU9603R"
                  maxLength={10}
                />
              </Field>
              <Field label="CIN" hint="21 characters. MCA registration.">
                <input
                  className="input font-mono uppercase"
                  value={form.cin}
                  onChange={(e) => set('cin', e.target.value.toUpperCase())}
                  placeholder="U72200KA2020PTC123456"
                  maxLength={40}
                />
              </Field>
            </div>
          </section>

          {/* ─── Registered address ─────────────────────────────────────── */}
          <section className="card p-6">
            <div className="mb-4">
              <h2 className="t-h3">Registered address</h2>
              <p className="t-mute mt-1">Used on payslips, F&F letters, and statutory filings.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Address line 1" span={3}>
                <input
                  className="input"
                  value={form.addressLine1}
                  onChange={(e) => set('addressLine1', e.target.value)}
                  placeholder="Building, street"
                  maxLength={200}
                />
              </Field>
              <Field label="Address line 2" span={3}>
                <input
                  className="input"
                  value={form.addressLine2}
                  onChange={(e) => set('addressLine2', e.target.value)}
                  placeholder="Area, landmark"
                  maxLength={200}
                />
              </Field>
              <Field label="City">
                <input
                  className="input"
                  value={form.city}
                  onChange={(e) => set('city', e.target.value)}
                  placeholder="Bengaluru"
                  maxLength={80}
                />
              </Field>
              <Field label="State" hint={form.gstin ? 'From GSTIN' : 'Two-letter code'}>
                <select
                  className="input"
                  value={form.stateCode}
                  onChange={(e) => set('stateCode', e.target.value)}
                  disabled={Boolean(form.gstin)}
                >
                  <option value="">Select…</option>
                  {STATE_CODES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="PIN code">
                <input
                  className="input"
                  value={form.postalCode}
                  onChange={(e) => set('postalCode', e.target.value)}
                  placeholder="560038"
                  maxLength={12}
                  inputMode="numeric"
                />
              </Field>
            </div>
          </section>

          {/* ─── Footer actions (in normal flow — a transparent sticky bar
               floated over the address fields while scrolling) ───────────── */}
          <div className="flex items-center justify-between">
            <p className="t-mute text-sm">
              {dirty
                ? <span className="text-brand-yellow">You have unsaved changes.</span>
                : <span>Up to date.</span>}
            </p>
            <div className="flex gap-3">
              <Btn kind="ghost" onClick={handleReset} disabled={!dirty || update.isPending}>
                Discard
              </Btn>
              <Btn
                kind="primary"
                type="submit"
                disabled={!dirty || update.isPending}
              >
                {update.isPending ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                  </span>
                ) : (
                  'Save changes'
                )}
              </Btn>
            </div>
          </div>
        </form>

        {logoModalOpen && (
          <MediaCropModal
            kind="logo"
            hasCurrent={!!org.logoUrl}
            onUpload={async (blob) => {
              await uploadLogo.mutateAsync(blob)
            }}
            onRemove={async () => {
              await removeLogo.mutateAsync()
            }}
            onClose={() => setLogoModalOpen(false)}
          />
        )}
    </SettingsLayout>
  )
}
