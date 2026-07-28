'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import {
  useEmployees,
  useInviteEmployee,
  type InviteEmployeePayload,
} from '@/lib/api/queries/use-employees'
import {
  useDepartments,
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
  managerId: string
  locationId: string
  employmentType: string
  joiningDate: string
  shiftTemplateId: string
  annualCtc: string
  employeeCode: string
  sendInviteImmediately: boolean
}

export default function InviteEmployeePage() {
  const router = useRouter()
  const { toast } = useToast()
  const invite = useInviteEmployee()
  const employees = useEmployees()
  const departments = useDepartments()
  const locations = useLocations()
  const shifts = useShifts()

  // Auto-suggest the next EMP code by scanning existing employees.
  const suggestedCode = useMemo(() => {
    const codes = (employees.data?.employees ?? []).map((e) => e.employeeCode ?? '')
    const ints = codes
      .map((c) => /^EMP(\d+)$/.exec(c))
      .map((m) => (m ? parseInt(m[1]!, 10) : 0))
    const next = Math.max(0, ...ints) + 1
    return `EMP${String(next).padStart(3, '0')}`
  }, [employees.data])

  const [form, setForm] = useState<FormState>({
    firstName: '',
    lastName: '',
    email: '',
    personalPhone: '',
    dateOfBirth: '',
    jobTitle: '',
    departmentId: '',
    managerId: '',
    locationId: '',
    employmentType: 'full_time',
    joiningDate: new Date().toISOString().slice(0, 10),
    shiftTemplateId: '',
    annualCtc: '',
    employeeCode: '',
    sendInviteImmediately: true,
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

    const fullName = `${firstName} ${lastName}`.trim()
    const departmentId = asUuid(form.departmentId)
    const locationId = asUuid(form.locationId)
    const managerId = asUuid(form.managerId)
    const shiftTemplateId = asUuid(form.shiftTemplateId)

    const payload: InviteEmployeePayload = {
      fullName,
      email,
      employeeCode: (form.employeeCode || suggestedCode).trim().toUpperCase(),
      ...(form.jobTitle.trim() ? { jobTitle: form.jobTitle.trim() } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(managerId ? { managerId } : {}),
      ...(form.employmentType ? { employmentType: form.employmentType } : {}),
      ...(form.joiningDate ? { joiningDate: form.joiningDate } : {}),
      ...(form.personalPhone.trim()
        ? { personalPhone: form.personalPhone.trim() }
        : {}),
      ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
    }

    // Warn in the console if any UUID-shaped field was dropped — this is
    // how we'll diagnose if a dropdown is somehow binding to a non-UUID
    // string. Safe to remove once the dropdown-binding code is proven
    // correct.
    const dropped = [
      form.departmentId && !departmentId && 'departmentId',
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
      await invite.mutateAsync(payload)
      toast({
        title: form.sendInviteImmediately
          ? 'Invite sent'
          : 'Saved as draft',
        description: form.sendInviteImmediately
          ? `${email} will receive a magic-link to self-onboard.`
          : 'You can send the invite from the Onboarding pipeline.',
      })
      router.push('/employees')
    } catch (err: any) {
      toast({
        title: 'Could not send invite',
        description: err?.message ?? 'Try again',
        variant: 'destructive',
      })
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="relative min-h-full">
      <div className="relative z-10 p-8" style={{ maxWidth: 760, margin: '0 auto' }}>
        <Link
          href="/employees"
          className="inline-flex items-center gap-1.5 text-xs text-brand-muted hover:text-white font-semibold"
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
                  onChange={(e) =>
                    set('employeeCode', e.target.value.toUpperCase())
                  }
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
                  onChange={(e) => set('departmentId', e.target.value)}
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
                <label className="label">Reporting manager</label>
                <select
                  className="input"
                  value={form.managerId}
                  onChange={(e) => set('managerId', e.target.value)}
                >
                  <option value="">—</option>
                  {(employees.data?.employees ?? [])
                    .filter((e) => e.status === 'active')
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
                <label className="label">Shift template</label>
                <select
                  className="input"
                  value={form.shiftTemplateId}
                  onChange={(e) => set('shiftTemplateId', e.target.value)}
                >
                  <option value="">Use tenant default</option>
                  {(shifts.data?.data ?? [])
                    .filter((s) => s.isActive)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.startTime}–{s.endTime}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">
                  Annual CTC{' '}
                  <span style={{ color: 'var(--text-faint)' }}>
                    (optional, hidden from employee)
                  </span>
                </label>
                <input
                  className="input"
                  value={form.annualCtc}
                  onChange={(e) => set('annualCtc', e.target.value)}
                  placeholder="₹ 6,00,000"
                />
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
              <label
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'var(--text-2)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={form.sendInviteImmediately}
                  onChange={(e) =>
                    set('sendInviteImmediately', e.target.checked)
                  }
                  style={{ accentColor: 'var(--blue)' }}
                />
                Send invite email immediately
              </label>
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
          color: '#fff',
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
