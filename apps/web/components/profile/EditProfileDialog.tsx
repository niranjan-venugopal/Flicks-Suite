'use client'

import { useState, type ChangeEvent, type ReactNode } from 'react'
import { INDIAN_STATES } from '@flicks/shared/constants'
import { Btn, Icon } from '@/components/proto'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { roleLabel, useAuthStore } from '@/lib/stores/auth.store'
import {
  useSelfUpdateEmployee,
  type EmergencyContact,
  type EmployeeDetail,
  type SelfUpdateEmployeePayload,
} from '@/lib/api/queries/use-employees'

// Same list the onboarding wizard offers, plus Friend.
const RELATIONSHIPS = ['Parent', 'Spouse', 'Sibling', 'Child', 'Friend', 'Other']

// Mirrors the API DTO (employees.dto.ts) so a bad value is refused HERE with
// plain copy instead of surfacing class-validator's "personalEmail must be
// an email" from the 400.
const PHONE_RE = /^\+?[0-9][0-9 ().-]{6,29}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Last-resort: strip the `field.` prefix class-validator puts on nested messages. */
function friendlyApiMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : ''
  if (!raw) return 'Try again'
  return raw.replace(/(^|,\s*)[a-zA-Z]+\./g, '$1')
}

/** The contact the self-service edit reads and writes — the primary row (oldest first, per the API ordering). */
export function primaryEmergencyContact(
  record: EmployeeDetail | undefined,
): EmergencyContact | null {
  const list = record?.emergencyContacts ?? []
  return list.find((c) => c.isPrimary) ?? list[0] ?? null
}

interface EditProfileDialogProps {
  open: boolean
  onClose: () => void
  record: EmployeeDetail
}

/**
 * Self-service "Edit profile" (founder round K): contact details only —
 * personal phone / email, current address, emergency contact — saved
 * immediately through PUT /employees/me. Name, work email, designation and
 * role are HR-managed and shown read-only at the top. Radix Dialog like the
 * page's PendingChangesCard; the form lives inside DialogContent so it
 * re-seeds from the record on every open.
 */
export function EditProfileDialog({ open, onClose, record }: EditProfileDialogProps) {
  const save = useSelfUpdateEmployee()
  return (
    // Backdrop / Escape mid-save would strand the in-flight write — block
    // dismissal while pending (same contract as ConfirmDialog).
    <Dialog open={open} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>Contact details you keep up to date yourself.</DialogDescription>
        </DialogHeader>
        <EditProfileForm record={record} save={save} onClose={onClose} />
      </DialogContent>
    </Dialog>
  )
}

function seedForm(record: EmployeeDetail) {
  const addr = record.currentAddress ?? {}
  const contact = primaryEmergencyContact(record)
  return {
    phone: record.personalPhone ?? '',
    email: record.personalEmail ?? '',
    line1: addr.line1 ?? '',
    line2: addr.line2 ?? '',
    city: addr.city ?? '',
    state: addr.state ?? '',
    pin: addr.postal_code ?? '',
    ecName: contact?.name ?? '',
    ecRel: contact?.relationship ?? '',
    ecPhone: contact?.phone ?? '',
    ecEmail: contact?.email ?? '',
  }
}
type FormState = ReturnType<typeof seedForm>
type Key = keyof FormState

function EditProfileForm({
  record,
  save,
  onClose,
}: {
  record: EmployeeDetail
  save: ReturnType<typeof useSelfUpdateEmployee>
  onClose: () => void
}) {
  const { toast } = useToast()
  const { currentUser } = useAuthStore()

  const contact = primaryEmergencyContact(record)
  // Seeded once per open (the form mounts with DialogContent) so a
  // background refetch of the record can't move the "touched" baseline.
  const [initial] = useState<FormState>(() => seedForm(record))
  const [form, setForm] = useState<FormState>(initial)
  const [removeContact, setRemoveContact] = useState(false)

  const set = (k: Key) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))
  const touched = (keys: Key[]) => keys.some((k) => form[k].trim() !== initial[k].trim())

  const isIndia = (record.locationCountryCode ?? 'IN').toUpperCase() === 'IN'
  const stateIsKnown = INDIAN_STATES.some((s) => s.name === form.state)

  const handleSave = async () => {
    // Only the sections the user touched go over the wire; '' clears.
    const payload: SelfUpdateEmployeePayload = {}
    const refuse = (title: string) => {
      toast({ title, variant: 'destructive' })
      return false
    }
    if (touched(['phone'])) {
      payload.personalPhone = form.phone.trim()
      if (payload.personalPhone && !PHONE_RE.test(payload.personalPhone)) return refuse('Personal phone needs at least 7 digits')
    }
    if (touched(['email'])) {
      payload.personalEmail = form.email.trim()
      if (payload.personalEmail && !EMAIL_RE.test(payload.personalEmail)) return refuse('Personal email looks invalid')
    }
    if (touched(['line1', 'line2', 'city', 'state', 'pin'])) {
      payload.currentAddress = {
        line1: form.line1.trim(),
        line2: form.line2.trim(),
        city: form.city.trim(),
        stateCode: form.state.trim(),
        postalCode: form.pin.trim(),
      }
    }

    const ec = {
      name: form.ecName.trim(),
      relationship: form.ecRel.trim(),
      phone: form.ecPhone.trim(),
      email: form.ecEmail.trim(),
    }
    const ecBlank = !ec.name && !ec.relationship && !ec.phone && !ec.email
    const ecTouched = touched(['ecName', 'ecRel', 'ecPhone', 'ecEmail'])
    if (removeContact || (ecTouched && ecBlank)) {
      // Nothing to remove when there was no contact to begin with.
      if (contact) payload.emergencyContact = null
    } else if (ecTouched) {
      if (!ec.name || !ec.relationship || !ec.phone) {
        return refuse('Emergency contact needs a name, relationship and phone')
      }
      if (!PHONE_RE.test(ec.phone)) return refuse('Emergency contact phone needs at least 7 digits')
      if (ec.email && !EMAIL_RE.test(ec.email)) return refuse('Emergency contact email looks invalid')
      payload.emergencyContact = {
        name: ec.name,
        relationship: ec.relationship,
        phone: ec.phone,
        email: ec.email || undefined,
      }
    }

    if (Object.keys(payload).length === 0) {
      onClose()
      return
    }

    try {
      await save.mutateAsync(payload)
      toast({ title: 'Profile updated' })
      onClose()
    } catch (err) {
      toast({
        title: 'Could not update profile',
        description: friendlyApiMessage(err),
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* HR-managed identity — read-only by founder decision */}
      <div
        data-testid="hr-managed"
        style={{
          padding: '10px 12px',
          background: 'var(--surf-1)',
          border: '1px solid var(--bord)',
          borderRadius: 10,
        }}
      >
        {/* One summary line, not four disabled inputs: keeps the whole form
            (Save included) inside 90vh on a 13-inch MacBook and can't be
            mistaken for something editable. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Icon.lock size={13} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
          <div
            style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={[record.userFullName ?? currentUser?.name, record.workEmail ?? currentUser?.email].filter(Boolean).join(' · ')}
          >
            {record.userFullName ?? currentUser?.name ?? '—'}
            <span style={{ color: 'var(--text-mute)', fontWeight: 600 }}>
              {' · '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>{record.workEmail ?? currentUser?.email ?? '—'}</span>
              {' · '}
              {[record.designationTitle ?? currentUser?.designation, roleLabel(currentUser?.role)].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
        <div className="t-mute" style={{ fontSize: 11.5, marginTop: 6 }}>
          Name, work email, designation and role are managed by HR — ask your HR admin.
        </div>
      </div>

      <section>
        <SectionLabel>Personal contact</SectionLabel>
        <Grid>
          <Field label="Personal phone">
            <input
              className="input"
              data-testid="pp-phone"
              value={form.phone}
              onChange={set('phone')}
              placeholder="+91 98765 43210"
              inputMode="tel"
              maxLength={30}
            />
          </Field>
          <Field label="Personal email">
            <input
              className="input"
              data-testid="pp-email"
              type="email"
              value={form.email}
              onChange={set('email')}
              placeholder="you@example.com"
              maxLength={254}
            />
          </Field>
        </Grid>
      </section>

      <section>
        <SectionLabel>Current address</SectionLabel>
        {/* Two rows (line 1 + line 2, then city / state / PIN) so the whole
            form — Save included — fits inside 90vh on a 13-inch MacBook. */}
        <Grid>
          <Field label="Address line 1">
            <input className="input" data-testid="pp-addr-line1" value={form.line1} onChange={set('line1')} maxLength={200} />
          </Field>
          <Field label="Address line 2">
            <input className="input" data-testid="pp-addr-line2" value={form.line2} onChange={set('line2')} maxLength={200} />
          </Field>
        </Grid>
        <Grid cols={3}>
          <Field label="City">
            <input className="input" data-testid="pp-addr-city" value={form.city} onChange={set('city')} maxLength={80} />
          </Field>
          <Field label="State">
            {isIndia ? (
              <select className="input" data-testid="pp-addr-state" value={form.state} onChange={set('state')}>
                <option value="">—</option>
                {/* Legacy rows hold a 2-letter code or a free-typed value —
                    keep it selectable so an untouched save round-trips. */}
                {form.state && !stateIsKnown && <option value={form.state}>{form.state}</option>}
                {INDIAN_STATES.map((s) => (
                  <option key={s.code} value={s.name}>{s.name}</option>
                ))}
              </select>
            ) : (
              <input className="input" data-testid="pp-addr-state" value={form.state} onChange={set('state')} maxLength={60} />
            )}
          </Field>
          <Field label={isIndia ? 'PIN code' : 'Postal / ZIP code'}>
            <input
              className="input"
              data-testid="pp-addr-pin"
              value={form.pin}
              onChange={set('pin')}
              maxLength={12}
              inputMode="numeric"
            />
          </Field>
        </Grid>
      </section>

      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <SectionLabel>Emergency contact</SectionLabel>
          {contact && !removeContact && (
            <button
              type="button"
              data-testid="pp-ec-remove"
              onClick={() => setRemoveContact(true)}
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                fontSize: 11.5,
                fontWeight: 700,
                color: 'var(--coral)',
                cursor: 'pointer',
              }}
            >
              Remove contact
            </button>
          )}
        </div>
        {removeContact ? (
          <div
            className="t-mute"
            style={{
              fontSize: 12,
              padding: '10px 12px',
              border: '1px dashed var(--bord)',
              borderRadius: 10,
            }}
          >
            {contact?.name} will be removed when you save.{' '}
            <button
              type="button"
              onClick={() => setRemoveContact(false)}
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--blue)',
                cursor: 'pointer',
              }}
            >
              Undo
            </button>
          </div>
        ) : (
          <Grid>
            <Field label="Name">
              <input className="input" data-testid="pp-ec-name" value={form.ecName} onChange={set('ecName')} placeholder="Anita Sharma" maxLength={120} />
            </Field>
            <Field label="Relationship">
              <select className="input" data-testid="pp-ec-rel" value={form.ecRel} onChange={set('ecRel')}>
                <option value="">Select…</option>
                {form.ecRel && !RELATIONSHIPS.includes(form.ecRel) && (
                  <option value={form.ecRel}>{form.ecRel}</option>
                )}
                {RELATIONSHIPS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label="Phone">
              <input className="input" data-testid="pp-ec-phone" value={form.ecPhone} onChange={set('ecPhone')} placeholder="+91 98765 43210" inputMode="tel" maxLength={30} />
            </Field>
            <Field label="Email (optional)">
              <input className="input" data-testid="pp-ec-email" type="email" value={form.ecEmail} onChange={set('ecEmail')} maxLength={254} />
            </Field>
          </Grid>
        )}
      </section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <Btn kind="ghost" onClick={onClose} disabled={save.isPending} data-testid="pp-cancel">
          Cancel
        </Btn>
        <Btn kind="primary" onClick={handleSave} disabled={save.isPending} data-testid="pp-save">
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Btn>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="t-caption" style={{ marginBottom: 6 }}>
      {children}
    </div>
  )
}

function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: cols === 3 ? '1fr 1fr 1fr' : '1fr 1fr', gap: 10, marginBottom: 8 }}>
      {children}
    </div>
  )
}

function Field({ label, children, span }: { label: string; children: ReactNode; span?: 2 }) {
  return (
    <div style={{ gridColumn: span === 2 ? 'span 2' : 'auto', minWidth: 0 }}>
      <label className="label">{label}</label>
      {children}
    </div>
  )
}
