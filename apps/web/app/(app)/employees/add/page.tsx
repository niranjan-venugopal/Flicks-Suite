'use client'

import { useMemo, useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { APIError } from '@/lib/api/client'
import {
  useEmployees,
  useInviteEmployee,
  useNextEmployeeCode,
  type InviteEmployeePayload,
} from '@/lib/api/queries/use-employees'
import {
  useDepartments,
  useDesignations,
  useLocations,
  useShifts,
} from '@/lib/api/queries/use-settings'

const EMPLOYMENT_TYPES = [
  { v: 'full_time',  l: 'Full-time' },
  { v: 'part_time',  l: 'Part-time' },
  { v: 'contract',   l: 'Contract' },
  { v: 'intern',     l: 'Intern' },
  { v: 'consultant', l: 'Consultant' },
  { v: 'probation',  l: 'Probation' },
] as const

interface FormState {
  firstName: string
  lastName: string
  email: string
  personalPhone: string
  dateOfBirth: string
  jobTitle: string
  departmentId: string
  designationId: string
  managerId: string
  locationId: string
  employmentType: string
  joiningDate: string
  probationEndDate: string
  noticePeriodDays: string
  shiftTemplateId: string
  employeeCode: string
}

export default function InviteEmployeePage() {
  const router = useRouter()
  const { toast } = useToast()
  const invite = useInviteEmployee()
  // Reporting-manager pool: active people only, at the API's page cap
  // (round P, R1.3).
  const employees = useEmployees({ status: 'active', limit: 100 })
  // The client-side code fallback must see EVERY live status (an invited or
  // on-leave person holds a code just as firmly as an active one), so it
  // reads the unfiltered roster rather than the manager pool above.
  const roster = useEmployees({ limit: 100 })
  // Round P (contract C6): the server suggests the next free code over EVERY
  // row — removed employees included, since they still hold the unique index
  // and a client-side guess from the visible list walked straight into 409s.
  const nextCode = useNextEmployeeCode()
  const departments = useDepartments()
  const designations = useDesignations()
  const locations = useLocations()
  const shifts = useShifts()

  // Client-side fallback while the server suggestion loads (or if that
  // endpoint is unavailable): parse the visible codes as (prefix)(number)
  // and continue the dominant prefix at its digit width.
  const clientSuggestedCode = useMemo(() => {
    const parsed = (roster.data?.employees ?? [])
      .map((e) => /^(.*?)(\d+)$/.exec(e.employeeCode ?? ''))
      .filter((m): m is RegExpExecArray => m !== null)
    if (parsed.length === 0) return 'EMP001'
    const byPrefix = new Map<string, { count: number; max: number; width: number }>()
    for (const m of parsed) {
      const prefix = m[1]!
      const num = parseInt(m[2]!, 10)
      const entry = byPrefix.get(prefix) ?? { count: 0, max: 0, width: 3 }
      entry.count += 1
      if (num >= entry.max) {
        entry.max = num
        entry.width = m[2]!.length
      }
      byPrefix.set(prefix, entry)
    }
    // Most-used prefix wins; ties break toward the highest sequence number
    // (≈ most recently issued).
    const [prefix, info] = [...byPrefix.entries()].sort(
      (a, b) => b[1].count - a[1].count || b[1].max - a[1].max,
    )[0]!
    return `${prefix}${String(info.max + 1).padStart(info.width, '0')}`
  }, [roster.data])

  const suggestedCode = nextCode.data?.suggested?.trim() || clientSuggestedCode

  // Prefill once the suggestion lands — still fully editable. Tracks whether
  // the user has typed so we never clobber their input.
  const codeTouched = useRef(false)
  useEffect(() => {
    if (!codeTouched.current) {
      setForm((f) => (f.employeeCode === suggestedCode ? f : { ...f, employeeCode: suggestedCode }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedCode])

  const [form, setForm] = useState<FormState>({
    firstName: '',
    lastName: '',
    email: '',
    personalPhone: '',
    dateOfBirth: '',
    jobTitle: '',
    departmentId: '',
    designationId: '',
    managerId: '',
    locationId: '',
    employmentType: 'full_time',
    joiningDate: new Date().toISOString().slice(0, 10),
    probationEndDate: '',
    noticePeriodDays: '',
    shiftTemplateId: '',
    employeeCode: '',
  })

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((p) => ({ ...p, [k]: v }))

  // class-validator's @IsUUID() rejects empty strings, so we must drop any
  // optional UUID field that isn't a valid v4 (or earlier) UUID instead of
  // passing through whatever HTML <select> happened to bind. The dropdowns
  // SHOULD always carry real UUIDs as their value, but defensively scrubbing
  // here keeps the invite endpoint responsive when the data layer hiccups.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const asUuid = (v: string): string | undefined =>
    UUID_RE.test(v.trim()) ? v.trim() : undefined

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const firstName = form.firstName.trim()
    const lastName = form.lastName.trim()
    const email = form.email.trim().toLowerCase()
    if (!firstName) {
      toast({ title: 'First name is required', variant: 'destructive' })
      return
    }
    if (!email) {
      toast({ title: 'Work email is required', variant: 'destructive' })
      return
    }
    if (form.noticePeriodDays.trim()) {
      const days = Number(form.noticePeriodDays)
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        toast({
          title: 'Notice period must be a whole number of days (0–365)',
          variant: 'destructive',
        })
        return
      }
    }

    const fullName = `${firstName} ${lastName}`.trim()
    const departmentId = asUuid(form.departmentId)
    const designationId = asUuid(form.designationId)
    const locationId = asUuid(form.locationId)
    const managerId = asUuid(form.managerId)
    const shiftTemplateId = asUuid(form.shiftTemplateId)

    const payload: InviteEmployeePayload = {
      fullName,
      email,
      employeeCode: (form.employeeCode || suggestedCode).trim().toUpperCase(),
      ...(form.jobTitle.trim() ? { jobTitle: form.jobTitle.trim() } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(designationId ? { designationId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(managerId ? { managerId } : {}),
      // The Shift dropdown finally reaches the server (founder round A) —
      // the API writes an employee_shifts mapping from the joining date.
      ...(shiftTemplateId ? { shiftTemplateId } : {}),
      ...(form.employmentType ? { employmentType: form.employmentType } : {}),
      ...(form.joiningDate ? { joiningDate: form.joiningDate } : {}),
      ...(form.personalPhone.trim()
        ? { personalPhone: form.personalPhone.trim() }
        : {}),
      ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
      ...(form.probationEndDate
        ? { probationEndDate: form.probationEndDate }
        : {}),
      ...(form.noticePeriodDays.trim() &&
      !Number.isNaN(Number(form.noticePeriodDays))
        ? { noticePeriodDays: Number(form.noticePeriodDays) }
        : {}),
    }

    // Warn in the console if any UUID-shaped field was dropped — this is
    // how we'll diagnose if a dropdown is somehow binding to a non-UUID
    // string. Safe to remove once the dropdown-binding code is proven
    // correct.
    const dropped = [
      form.departmentId && !departmentId && 'departmentId',
      form.designationId && !designationId && 'designationId',
      form.locationId && !locationId && 'locationId',
      form.managerId && !managerId && 'managerId',
      form.shiftTemplateId && !shiftTemplateId && 'shiftTemplateId',
    ].filter(Boolean)
    if (dropped.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[invite-employee] Dropped non-UUID fields: ${dropped.join(', ')} ·`,
        {
          departmentId: form.departmentId,
          locationId: form.locationId,
          managerId: form.managerId,
          shiftTemplateId: form.shiftTemplateId,
        },
      )
    }

    try {
      const res = await invite.mutateAsync(payload)
      // Round P (contract C3): the invite is always sent — the old "Saved as
      // draft" toast described a checkbox the server never read. A 200 can
      // still mean the email bounced at the provider (emailSent:false), and a
      // pending invitee re-added from this form is updated + re-invited.
      if (res.emailSent === false) {
        toast({
          title: 'Invite saved but the email could not be sent — try Resend in a minute',
          description: `${email} is in the directory. Use Resend invite from their row.`,
          variant: 'destructive',
        })
      } else if (res.reinvited) {
        toast({
          title: `Invite re-sent to ${email} — their details were updated`,
          description: 'Their earlier link still works too.',
        })
      } else if (res.rehired) {
        toast({
          title: `${fullName} is back`,
          description: `Their record was restored and a fresh invite went to ${email}.`,
        })
      } else {
        toast({
          title: 'Invite sent',
          description: `${email} will receive a magic-link to self-onboard.`,
        })
      }
      router.push('/employees')
    } catch (err) {
      // 409s carry copy written for the user (ALREADY_EMPLOYEE / EXTERNAL_SEAT
      // / employee-code clashes) — show it as-is and offer the directory,
      // since every one of them is resolved from there.
      const conflict = err instanceof APIError && err.status === 409
      toast({
        title: 'Could not send invite',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
        ...(conflict
          ? {
              action: (
                <ToastAction altText="View employees" onClick={() => router.push('/employees')}>
                  View employees
                </ToastAction>
              ),
            }
          : {}),
      })
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="relative min-h-full">
      <div className="relative z-10 p-8" style={{ maxWidth: 760, margin: '0 auto' }}>
        <Link
          href="/employees"
          className="inline-flex items-center gap-1.5 text-xs text-brand-muted hover:text-ink font-semibold"
          style={{ marginBottom: 18 }}
        >
          <Icon.arrowL size={14} /> Back to Employees
        </Link>

        <div className="t-h1" style={{ marginBottom: 8 }}>
          Invite a new employee
        </div>
        <div className="t-mute" style={{ fontSize: 13.5, marginBottom: 24 }}>
          They&apos;ll get an email to accept and self-onboard. You only fill in
          essentials — the rest is captured during their onboarding.
        </div>

        <form onSubmit={handleSubmit}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* ─── Section 1: Identity ──────────────────────────────────── */}
            <SectionHeader number={1} title="Identity" />
            <div
              style={{
                padding: 22,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 16,
              }}
            >
              <div>
                <label className="label">
                  First name <span style={{ color: 'var(--coral)' }}>*</span>
                </label>
                <input
                  className="input"
                  value={form.firstName}
                  onChange={(e) => set('firstName', e.target.value)}
                  placeholder="Asha"
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="label">Last name</label>
                <input
                  className="input"
                  value={form.lastName}
                  onChange={(e) => set('lastName', e.target.value)}
                  placeholder="Patel"
                />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label className="label">
                  Work email <span style={{ color: 'var(--coral)' }}>*</span>
                </label>
                <input
                  className="input"
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  placeholder="asha@company.com"
                  required
                />
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-mute)',
                    marginTop: 6,
                  }}
                >
                  Invitation will be sent here. Must be unique within the
                  workspace.
                </div>
              </div>
              <div>
                <label className="label">Personal phone</label>
                <input
                  className="input"
                  value={form.personalPhone}
                  onChange={(e) => set('personalPhone', e.target.value)}
                  placeholder="+91 98765 43210"
                />
              </div>
              <div>
                <label className="label">Date of birth</label>
                <DateField
                  value={form.dateOfBirth}
                  onChange={(v) => set('dateOfBirth', v)}
                />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label className="label">Employee code</label>
                <input
                  className="input font-mono"
                  value={form.employeeCode}
                  onChange={(e) => {
                    codeTouched.current = true
                    set('employeeCode', e.target.value.toUpperCase())
                  }}
                  placeholder={suggestedCode}
                />
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-mute)',
                    marginTop: 6,
                  }}
                >
                  Leave blank to use{' '}
                  <code style={{ color: 'var(--text)' }}>{suggestedCode}</code>.
                </div>
              </div>
            </div>

            {/* ─── Section 2: Job ───────────────────────────────────────── */}
            <SectionHeader number={2} title="Job" muted />
            <div
              style={{
                padding: 22,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 16,
              }}
            >
              <div>
                <label className="label">Job title</label>
                <input
                  className="input"
                  value={form.jobTitle}
                  onChange={(e) => set('jobTitle', e.target.value)}
                  placeholder="Software Engineer"
                />
              </div>
              <div>
                <label className="label">Department</label>
                <select
                  className="input"
                  value={form.departmentId}
                  onChange={(e) => {
                    const departmentId = e.target.value
                    // Keep the designation only if it still applies: common
                    // (no department) designations survive any switch.
                    const keep = (designations.data?.data ?? []).some(
                      (d) =>
                        d.id === form.designationId &&
                        (!d.departmentId || d.departmentId === departmentId),
                    )
                    setForm((p) => ({
                      ...p,
                      departmentId,
                      designationId: keep ? p.designationId : '',
                    }))
                  }}
                >
                  <option value="">—</option>
                  {(departments.data?.data ?? [])
                    .filter((d) => d.isActive)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">Designation</label>
                {/* All active designations are pickable in ANY order — choosing
                    a department-linked one auto-fills the Department (founder
                    round 16); common ones leave it untouched. */}
                <select
                  className="input"
                  value={form.designationId}
                  onChange={(e) => {
                    const designationId = e.target.value
                    const picked = (designations.data?.data ?? []).find(
                      (d) => d.id === designationId,
                    )
                    setForm((p) => ({
                      ...p,
                      designationId,
                      ...(picked?.departmentId
                        ? { departmentId: picked.departmentId }
                        : {}),
                    }))
                  }}
                >
                  <option value="">—</option>
                  {(designations.data?.data ?? [])
                    .filter((d) => d.isActive)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                        {d.level ? ` · L${d.level}` : ''}
                        {!d.departmentId ? '' : d.departmentName ? ` (${d.departmentName})` : ''}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">Reporting manager</label>
                <select
                  className="input"
                  value={form.managerId}
                  onChange={(e) => set('managerId', e.target.value)}
                >
                  <option value="">—</option>
                  {(employees.data?.employees ?? [])
                    .filter((e) => e.uiStatus === 'active')
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                        {e.employeeCode ? ` · ${e.employeeCode}` : ''}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">Work location</label>
                <select
                  className="input"
                  value={form.locationId}
                  onChange={(e) => set('locationId', e.target.value)}
                >
                  <option value="">—</option>
                  {(locations.data?.data ?? [])
                    .filter((l) => l.isActive)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.city ? ` · ${l.city}` : ''}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">Employment type</label>
                <select
                  className="input"
                  value={form.employmentType}
                  onChange={(e) => set('employmentType', e.target.value)}
                >
                  {EMPLOYMENT_TYPES.map((t) => (
                    <option key={t.v} value={t.v}>{t.l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Start date</label>
                <DateField
                  value={form.joiningDate}
                  onChange={(v) => set('joiningDate', v)}
                />
              </div>
              <div>
                <label className="label">
                  Probation ends{' '}
                  <span style={{ color: 'var(--text-faint)' }}>(optional)</span>
                </label>
                <DateField
                  value={form.probationEndDate}
                  onChange={(v) => set('probationEndDate', v)}
                  min={form.joiningDate || undefined}
                />
              </div>
              <div>
                <label className="label">Notice period (days)</label>
                <input
                  className="input"
                  inputMode="numeric"
                  value={form.noticePeriodDays}
                  onChange={(e) => set('noticePeriodDays', e.target.value)}
                  placeholder="30"
                />
              </div>
              <div>
                <label className="label">Shift template</label>
                <select
                  className="input"
                  value={form.shiftTemplateId}
                  onChange={(e) => set('shiftTemplateId', e.target.value)}
                >
                  <option value="">Use workspace default</option>
                  {(shifts.data?.data ?? [])
                    .filter((s) => s.isActive)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.startTime}–{s.endTime}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            {/* ─── Footer ───────────────────────────────────────────────── */}
            <div
              style={{
                padding: '14px 22px',
                background: 'var(--surf-1)',
                borderTop: '1px solid var(--bord)',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'var(--text-mute)',
                }}
              >
                <Icon.mail size={14} />
                The invite email goes out as soon as you send.
              </div>
              <div style={{ flex: 1 }} />
              <Btn kind="ghost" type="button" onClick={() => router.push('/employees')}>
                Cancel
              </Btn>
              <Btn
                kind="primary"
                type="submit"
                disabled={invite.isPending}
                icon={<Icon.mail size={14} />}
              >
                {invite.isPending ? 'Sending…' : 'Send invite'}
              </Btn>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

function SectionHeader({
  number,
  title,
  muted,
}: {
  number: number
  title: string
  muted?: boolean
}) {
  return (
    <div
      style={{
        padding: muted ? '14px 22px' : '18px 22px',
        background: muted ? 'var(--surf-1)' : 'transparent',
        borderTop: muted ? '1px solid var(--bord)' : 'none',
        borderBottom: '1px solid var(--bord)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'var(--blue)',
          color: 'var(--on-accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 800,
        }}
      >
        {number}
      </div>
      <div className="t-h3" style={{ fontSize: 15 }}>{title}</div>
    </div>
  )
}
