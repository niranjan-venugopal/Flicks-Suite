'use client'

import { use, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, type PillTone } from '@/components/proto'
import {
  useEmployee,
  useUpdateEmployee,
  type EmployeeDetail,
} from '@/lib/api/queries/use-employees'
import { useDepartments, useDesignations, useLocations } from '@/lib/api/queries/use-settings'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DateField } from '@/components/ui/date-picker'
import { EditDetailsDialog } from '@/components/employees/EditDetailsDialog'
import { EmployeeAttendanceTab } from '@/components/employees/EmployeeAttendanceTab'
import { Card, Grid, Field, fmtDate, fmtAddress, fmtPhone } from '@/components/employees/detail-kit'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TABS = [
  'overview',
  'timeline',
  'attendance',
  'leave',
  'timesheet',
  'documents',
  'access',
] as const
type Tab = (typeof TABS)[number]

function statusTone(s: EmployeeDetail['status']): PillTone {
  switch (s) {
    case 'active':         return 'green'
    case 'on_leave':       return 'yellow'
    case 'notice_period':  return 'coral'
    case 'separated':
    case 'absconded':      return 'coral'
    default:               return ''
  }
}

function statusLabel(s: EmployeeDetail['status']): string {
  switch (s) {
    case 'active':         return 'Active'
    case 'on_leave':       return 'On leave'
    case 'notice_period':  return 'Notice period'
    case 'separated':      return 'Separated'
    case 'absconded':      return 'Absconded'
    case 'inactive':       return 'Inactive'
    default:               return s
  }
}

function employmentTypeLabel(t: EmployeeDetail['employmentType']): string {
  switch (t) {
    case 'full_time':  return 'Full-time'
    case 'part_time':  return 'Part-time'
    case 'contract':   return 'Contract'
    case 'intern':     return 'Intern'
    case 'consultant': return 'Consultant'
    case 'probation':  return 'Probation'
    default:           return t
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const { data: e, isLoading, error } = useEmployee(id)
  const [tab, setTab] = useState<Tab>('overview')

  return (
    <div className="relative min-h-full">
      <div className="relative z-10 p-8 max-w-6xl mx-auto">
        <div style={{ marginBottom: 16 }}>
          <Link
            href="/employees"
            className="inline-flex items-center gap-2 text-sm text-brand-muted hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to employees
          </Link>
        </div>

        {isLoading ? (
          <div className="card p-12 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : error || !e ? (
          <div className="card p-12 text-center">
            <div className="t-h3 mb-1">Employee not found</div>
            <p className="t-mute">
              They may have been removed, or you don&apos;t have access.
            </p>
          </div>
        ) : (
          <>
            <EmployeeHeader e={e} />
            <TabsBar tab={tab} setTab={setTab} />
            {tab === 'overview' && <OverviewTab e={e} />}
            {tab === 'timeline' && <TimelinePlaceholder e={e} />}
            {tab === 'attendance' && <EmployeeAttendanceTab employeeId={e.id} />}
            {tab === 'leave' && <ModuleLink href="/leave" label="Leave" />}
            {tab === 'timesheet' && <ModuleLink href="/timesheets" label="Timesheets" />}
            {tab === 'documents' && <ComingSoon title="Documents" desc="Offer letters, ID proofs, contracts and policies will land here once secure file uploads are enabled." />}
            {tab === 'access' && <ComingSoon title="Access" desc="Workspace role, IP allowlist, and SSO bindings move here in a future polish pass." />}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Header ──────────────────────────────────────────────────────────────────

function EmployeeHeader({ e }: { e: EmployeeDetail }) {
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ') || e.userFullName || e.workEmail
  const role = useAuthStore((s) => s.currentUser?.role)
  const canEdit = role === 'OWNER' || role === 'HR_ADMIN'
  const [editing, setEditing] = useState(false)
  const [editingDetails, setEditingDetails] = useState(false)
  const contactEmail = e.workEmail || e.userEmail || e.personalEmail || undefined

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 18,
        marginBottom: 24,
        flexWrap: 'wrap',
      }}
    >
      <Avatar name={name} size="lg" src={e.avatarUrl ?? undefined} />
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <Pill tone={statusTone(e.status)} dot>
            {statusLabel(e.status)}
          </Pill>
          <Pill>{e.employeeCode}</Pill>
          <Pill>{employmentTypeLabel(e.employmentType)}</Pill>
        </div>
        <div className="t-h1" style={{ fontSize: 26, marginBottom: 4 }}>
          {name}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 12,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-2)',
            flexWrap: 'wrap',
          }}
        >
          {e.designationTitle && (
            <>
              <span>{e.designationTitle}{e.designationLevel ? ` · L${e.designationLevel}` : ''}</span>
              <span style={{ color: 'var(--text-faint)' }}>·</span>
            </>
          )}
          {e.departmentName && (
            <>
              <span>{e.departmentName}</span>
              <span style={{ color: 'var(--text-faint)' }}>·</span>
            </>
          )}
          {e.locationName && (
            <>
              <span>{e.locationName}</span>
              <span style={{ color: 'var(--text-faint)' }}>·</span>
            </>
          )}
          <span>Joined {fmtDate(e.dateOfJoining)}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {contactEmail && (
          <a href={`mailto:${contactEmail}`}>
            <Btn kind="secondary" size="sm" icon={<Icon.mail size={13} />}>
              Message
            </Btn>
          </a>
        )}
        {canEdit && (
          <>
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.cog size={13} />}
              onClick={() => setEditing(true)}
            >
              Edit profile
            </Btn>
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.shield size={13} />}
              onClick={() => setEditingDetails(true)}
            >
              Edit details
            </Btn>
          </>
        )}
      </div>

      {canEdit && (
        <EditProfileDialog e={e} open={editing} onClose={() => setEditing(false)} />
      )}
      {canEdit && (
        <EditDetailsDialog e={e} open={editingDetails} onClose={() => setEditingDetails(false)} />
      )}
    </div>
  )
}

function EditProfileDialog({
  e,
  open,
  onClose,
}: {
  e: EmployeeDetail
  open: boolean
  onClose: () => void
}) {
  const update = useUpdateEmployee()
  const { toast } = useToast()
  const departments = useDepartments()
  const designations = useDesignations()
  const locations = useLocations()
  const initialName =
    [e.firstName, e.lastName].filter(Boolean).join(' ') || e.userFullName || ''
  const [fullName, setFullName] = useState(initialName)
  const [workPhone, setWorkPhone] = useState(e.workPhone ?? '')
  const [personalPhone, setPersonalPhone] = useState(e.personalPhone ?? '')
  const [employeeCode, setEmployeeCode] = useState(e.employeeCode ?? '')
  const [departmentId, setDepartmentId] = useState(e.departmentId ?? '')
  const [designationId, setDesignationId] = useState(e.designationId ?? '')
  const [locationId, setLocationId] = useState(e.locationId ?? '')
  const [employmentType, setEmploymentType] = useState(e.employmentType ?? 'full_time')
  const [dateOfJoining, setDateOfJoining] = useState(e.dateOfJoining ?? '')
  const [probationEndDate, setProbationEndDate] = useState(e.probationEndDate ?? '')
  const [dateOfConfirmation, setDateOfConfirmation] = useState(e.dateOfConfirmation ?? '')
  const [noticePeriodDays, setNoticePeriodDays] = useState(
    e.noticePeriodDays != null ? String(e.noticePeriodDays) : '',
  )

  const handleSave = async () => {
    if (!fullName.trim()) {
      toast({ title: 'Name is required', variant: 'destructive' })
      return
    }
    if (noticePeriodDays.trim()) {
      const days = Number(noticePeriodDays)
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        toast({
          title: 'Notice period must be a whole number of days (0–365)',
          variant: 'destructive',
        })
        return
      }
    }
    try {
      if (!employeeCode.trim()) {
        toast({ title: 'Employee code is required', variant: 'destructive' })
        return
      }
      await update.mutateAsync({
        id: e.id,
        fullName: fullName.trim(),
        workPhone: workPhone.trim() || undefined,
        personalPhone: personalPhone.trim() || undefined,
        employeeCode: employeeCode.trim().toUpperCase(),
        departmentId: departmentId || undefined,
        designationId: designationId || undefined,
        locationId: locationId || undefined,
        employmentType,
        dateOfJoining: dateOfJoining || undefined,
        probationEndDate: probationEndDate || undefined,
        dateOfConfirmation: dateOfConfirmation || undefined,
        noticePeriodDays: noticePeriodDays.trim()
          ? Number(noticePeriodDays)
          : undefined,
      })
      toast({ title: 'Profile updated', description: fullName.trim() })
      onClose()
    } catch (err) {
      toast({
        title: 'Could not save',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
        </DialogHeader>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
          <div>
            <label className="label" style={{ display: 'block', marginBottom: 6 }}>
              Full name <span style={{ color: 'var(--coral)' }}>*</span>
            </label>
            <input
              className="input"
              value={fullName}
              onChange={(ev) => setFullName(ev.target.value)}
              maxLength={120}
              style={{ width: '100%' }}
              autoFocus
            />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Employee code <span style={{ color: 'var(--coral)' }}>*</span>
              </label>
              <input
                className="input font-mono"
                value={employeeCode}
                onChange={(ev) => setEmployeeCode(ev.target.value.toUpperCase())}
                maxLength={24}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Joining date
              </label>
              <DateField value={dateOfJoining} onChange={setDateOfJoining} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Department
              </label>
              <select
                className="input"
                value={departmentId}
                onChange={(ev) => {
                  const next = ev.target.value
                  setDepartmentId(next)
                  // Common (no-department) designations survive a department
                  // switch; department-specific ones reset.
                  const keep = (designations.data?.data ?? []).some(
                    (d) => d.id === designationId && (!d.departmentId || d.departmentId === next),
                  )
                  if (!keep) setDesignationId('')
                }}
                style={{ width: '100%' }}
              >
                <option value="">—</option>
                {(departments.data?.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Designation
              </label>
              {/* Pickable in ANY order — a department-linked designation
                  auto-fills the Department (founder round 16). */}
              <select
                className="input"
                value={designationId}
                onChange={(ev) => {
                  const next = ev.target.value
                  setDesignationId(next)
                  const picked = (designations.data?.data ?? []).find((d) => d.id === next)
                  if (picked?.departmentId) setDepartmentId(picked.departmentId)
                }}
                style={{ width: '100%' }}
              >
                <option value="">—</option>
                {(designations.data?.data ?? [])
                  .filter((d) => d.isActive || d.id === designationId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                      {d.level ? ` · L${d.level}` : ''}
                      {!d.departmentId ? '' : d.departmentName ? ` (${d.departmentName})` : ''}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Employment type
              </label>
              <select
                className="input"
                value={employmentType}
                onChange={(ev) => setEmploymentType(ev.target.value as typeof employmentType)}
                style={{ width: '100%' }}
              >
                {(['full_time', 'part_time', 'contract', 'intern', 'consultant', 'probation'] as const).map((t) => (
                  <option key={t} value={t}>{t.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Work location
              </label>
              <select
                className="input"
                value={locationId}
                onChange={(ev) => setLocationId(ev.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">—</option>
                {(locations.data?.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Probation ends
              </label>
              <DateField
                value={probationEndDate}
                onChange={setProbationEndDate}
                min={dateOfJoining || undefined}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Confirmed on
              </label>
              <DateField
                value={dateOfConfirmation}
                onChange={setDateOfConfirmation}
                min={dateOfJoining || undefined}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Notice period (days)
              </label>
              <input
                className="input"
                inputMode="numeric"
                value={noticePeriodDays}
                onChange={(ev) => setNoticePeriodDays(ev.target.value)}
                placeholder="30"
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Work phone
              </label>
              <input
                className="input"
                value={workPhone}
                onChange={(ev) => setWorkPhone(ev.target.value)}
                maxLength={20}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>
                Personal phone
              </label>
              <input
                className="input"
                value={personalPhone}
                onChange={(ev) => setPersonalPhone(ev.target.value)}
                maxLength={20}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <Btn kind="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Tabs bar ────────────────────────────────────────────────────────────────

function TabsBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        borderBottom: '1px solid var(--bord)',
        marginBottom: 22,
        overflowX: 'auto',
      }}
    >
      {TABS.map((t) => (
        <button
          key={t}
          onClick={() => setTab(t)}
          style={{
            padding: '10px 16px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12.5,
            fontWeight: tab === t ? 800 : 600,
            letterSpacing: '-0.01em',
            color: tab === t ? '#fff' : 'var(--text-mute)',
            borderBottom: `2px solid ${tab === t ? 'var(--blue)' : 'transparent'}`,
            marginBottom: -1,
            textTransform: 'capitalize',
            whiteSpace: 'nowrap',
          }}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

// ─── Overview tab ────────────────────────────────────────────────────────────

function OverviewTab({ e }: { e: EmployeeDetail }) {
  const primaryEmergency = e.emergencyContacts.find((c) => c.isPrimary) ?? e.emergencyContacts[0]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 18 }}>
      {/* LEFT column ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Card title="Personal & contact">
          <Grid cols={2}>
            <Field label="Work email" value={e.workEmail || '—'} />
            <Field label="Personal email" value={e.personalEmail || '—'} />
            <Field label="Work phone" value={fmtPhone(e.workPhone)} />
            <Field label="Personal phone" value={fmtPhone(e.personalPhone)} />
            <Field label="Date of birth" value={fmtDate(e.dateOfBirth)} />
            <Field
              label="Gender"
              value={e.gender ? e.gender.replace(/_/g, ' ') : '—'}
              capitalize
            />
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
            <Field label="Reporting manager" value={e.reportingManagerName ?? '—'} />
            <Field label="Employment type" value={employmentTypeLabel(e.employmentType)} />
            <Field
              label="Work location"
              value={
                e.locationName
                  ? `${e.locationName}${e.locationCity ? ` (${e.locationCity})` : ''}`
                  : '—'
              }
            />
            <Field label="Timezone" value={e.locationTimezone ?? '—'} mono />
            <Field label="Date of joining" value={fmtDate(e.dateOfJoining)} />
            <Field label="Probation ends" value={fmtDate(e.probationEndDate)} />
            <Field label="Confirmed on" value={fmtDate(e.dateOfConfirmation)} />
            <Field
              label="Notice period"
              value={e.noticePeriodDays ? `${e.noticePeriodDays} days` : '—'}
            />
            {e.dateOfExit && (
              <Field label="Last working day" value={fmtDate(e.dateOfExit)} />
            )}
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
            <Field
              label="Passport"
              value={e.hasPassport ? '•••• •••• ••••' : 'Not on file'}
              mono
            />
            <Field label="PF UAN" value={e.pfUan ?? '—'} mono />
            <Field label="ESIC" value={e.esicNumber ?? (e.esiApplicable ? '—' : 'Not applicable')} mono />
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

      {/* RIGHT column ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Card title="This month">
          <Grid cols={2}>
            <Stat label="Days present" value={e.thisMonth.daysPresent.toString()} />
            <Stat label="Late arrivals" value={e.thisMonth.lateArrivals.toString()} />
            <Stat label="Hours logged" value={`${e.thisMonth.hoursWorked}h`} />
            <Stat label="Leave taken" value={e.thisMonth.leaveTaken.toString()} />
          </Grid>
        </Card>

        <Card title="Leave balance">
          {e.leaveBalances.length === 0 ? (
            <div className="t-mute" style={{ fontSize: 12 }}>No leave policies configured.</div>
          ) : (
            e.leaveBalances.slice(0, 4).map((b) => {
              const total = b.opening + b.accrued
              const usedRatio = total > 0 ? Math.min(1, b.used / total) : 0
              const available = Math.max(0, total - b.used - b.pending)
              return (
                <div key={b.leaveTypeId} style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    <span>{b.leaveTypeName} ({b.code})</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      <strong>{available.toFixed(0)}</strong>
                      <span style={{ color: 'var(--text-mute)' }}> / {total.toFixed(0)}</span>
                    </span>
                  </div>
                  <div
                    style={{
                      width: '100%',
                      height: 5,
                      borderRadius: 99,
                      background: 'var(--surf-2)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${usedRatio * 100}%`,
                        height: '100%',
                        background: b.color ?? '#3E7BFA',
                        transition: 'width 200ms',
                      }}
                    />
                  </div>
                </div>
              )
            })
          )}
        </Card>

        <Card title="Emergency contacts">
          {e.emergencyContacts.length === 0 ? (
            <div className="t-mute" style={{ fontSize: 12 }}>None on file.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {e.emergencyContacts.map((c) => (
                <div
                  key={c.id}
                  style={{
                    padding: 10,
                    background: 'var(--surf-1)',
                    border: '1px solid var(--bord)',
                    borderRadius: 8,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 800 }}>{c.name}</span>
                    {c.isPrimary && <Pill tone="green">Primary</Pill>}
                  </div>
                  <div className="t-mute" style={{ fontSize: 11.5 }}>
                    {c.relationship} · {c.phone}
                    {c.email && ` · ${c.email}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

// ─── Other tab views ─────────────────────────────────────────────────────────

function TimelinePlaceholder({ e }: { e: EmployeeDetail }) {
  // Lifecycle events derived from what we have today (joining +
  // confirmation). A full timeline reads employment_history which we
  // don't yet write to — that lands with the role-change / transfer flows.
  const events: Array<{ date: string | null; title: string; what: string; color: string }> = [
    {
      date: e.dateOfJoining,
      title: 'Joined',
      what: `Started as ${e.designationTitle ?? 'team member'} · ${e.departmentName ?? '—'} · ${e.locationName ?? '—'}`,
      color: 'var(--blue)',
    },
  ]
  if (e.dateOfConfirmation) {
    events.push({
      date: e.dateOfConfirmation,
      title: 'Probation cleared',
      what: 'Confirmed in role',
      color: 'var(--green)',
    })
  }
  if (e.dateOfExit) {
    events.push({
      date: e.dateOfExit,
      title: 'Last working day',
      what: 'Separation in progress',
      color: 'var(--coral)',
    })
  }

  return (
    <div className="card">
      <div className="t-h3" style={{ marginBottom: 18 }}>Lifecycle timeline</div>
      <div style={{ position: 'relative', paddingLeft: 22 }}>
        <div
          style={{
            position: 'absolute',
            left: 7,
            top: 8,
            bottom: 8,
            width: 1.5,
            background: 'var(--bord-2)',
          }}
        />
        {events.map((ev, i) => (
          <div key={i} style={{ position: 'relative', marginBottom: 18 }}>
            <div
              style={{
                position: 'absolute',
                left: -22,
                top: 5,
                width: 14,
                height: 14,
                borderRadius: 99,
                background: ev.color,
                boxShadow: `0 0 0 3px var(--surf-1)`,
              }}
            />
            <div
              className="t-caption"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
            >
              {fmtDate(ev.date)}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, marginTop: 2 }}>{ev.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{ev.what}</div>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 16,
          padding: 12,
          background: 'rgba(254, 216, 0, 0.07)',
          border: '1px solid rgba(254, 216, 0, 0.18)',
          borderRadius: 10,
          fontSize: 11.5,
          color: 'var(--text-mute)',
        }}
      >
        Role changes, transfers and pay revisions will appear here as they happen.
      </div>
    </div>
  )
}

function ModuleLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="card" style={{ padding: 32, textAlign: 'center' }}>
      <div className="t-h3" style={{ marginBottom: 8 }}>{label}</div>
      <p className="t-mute" style={{ marginBottom: 16, fontSize: 13 }}>
        Full {label.toLowerCase()} for this employee is available in the dedicated module.
      </p>
      <Link href={href}>
        <Btn kind="secondary" iconRight={<Icon.arrow size={13} />}>
          Open {label}
        </Btn>
      </Link>
    </div>
  )
}

function ComingSoon({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="card" style={{ padding: 32, textAlign: 'center' }}>
      <div className="t-h3" style={{ marginBottom: 8 }}>{title}</div>
      <p className="t-mute" style={{ fontSize: 13, maxWidth: 480, margin: '0 auto' }}>{desc}</p>
    </div>
  )
}

// ─── Re-usable bits ──────────────────────────────────────────────────────────
// Card/Grid/Field + the fmt helpers moved to components/employees/detail-kit
// (shared with the onboarding review dialog).

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 12,
        background: 'var(--surf-1)',
        borderRadius: 10,
        border: '1px solid var(--bord)',
      }}
    >
      <div className="t-caption" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em' }}>{value}</div>
    </div>
  )
}
