'use client'

import { useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import {
  useShifts,
  useCreateShift,
  useUpdateShift,
  type ShiftTemplate,
} from '@/lib/api/queries/use-settings'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAYS = [
  { v: 1, l: 'Mon' },
  { v: 2, l: 'Tue' },
  { v: 3, l: 'Wed' },
  { v: 4, l: 'Thu' },
  { v: 5, l: 'Fri' },
  { v: 6, l: 'Sat' },
  { v: 0, l: 'Sun' },
] as const

function daysLabel(working: number[]): string {
  const set = new Set(working)
  // Common patterns
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return 'Mon–Fri'
  if (set.size === 6 && [1, 2, 3, 4, 5, 6].every((d) => set.has(d))) return 'Mon–Sat'
  if (set.size === 7) return '7 days'
  // Otherwise list them in week order
  return DAYS.filter((d) => set.has(d.v)).map((d) => d.l).join(', ')
}

// Cycle palette by index so each row shows a different accent.
const PALETTE = [
  { c: 'var(--blue)',   tint: 'rgba(62, 123, 250, 0.13)' },
  { c: 'var(--green)',  tint: 'rgba(39, 210, 128, 0.13)' },
  { c: 'var(--purple)', tint: 'rgba(155, 123, 250, 0.13)' },
  { c: 'var(--yellow)', tint: 'rgba(254, 216, 0, 0.13)' },
  { c: 'var(--coral)',  tint: 'rgba(248, 120, 107, 0.13)' },
] as const

// ─── Form state ──────────────────────────────────────────────────────────────

type FormState = {
  name: string
  description: string
  startTime: string
  endTime: string
  breakMinutes: string
  gracePeriodMinutes: string
  workingDays: number[]
  isDefault: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  startTime: '09:00',
  endTime: '18:00',
  breakMinutes: '60',
  gracePeriodMinutes: '15',
  workingDays: [1, 2, 3, 4, 5],
  isDefault: false,
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function WorkingHoursPage() {
  const { data, isLoading } = useShifts()
  const create = useCreateShift()
  const update = useUpdateShift()
  const { toast } = useToast()

  const items = data?.data ?? []
  const assignedTotal = useMemo(
    () => items.reduce((sum, s) => sum + (s.assigned ?? 0), 0),
    [items],
  )

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<ShiftTemplate | null>(null)
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM)

  const toggleDay = (d: number, target: 'add' | 'edit') => {
    const setter = target === 'add' ? setForm : setEditForm
    setter((p) => {
      const has = p.workingDays.includes(d)
      return {
        ...p,
        workingDays: has
          ? p.workingDays.filter((x) => x !== d)
          : [...p.workingDays, d].sort(),
      }
    })
  }

  const validate = (f: FormState): string | null => {
    if (!f.name.trim()) return 'Name is required.'
    if (f.workingDays.length === 0) return 'Pick at least one working day.'
    if (!/^[0-2]\d:[0-5]\d$/.test(f.startTime)) return 'Start time must be HH:MM.'
    if (!/^[0-2]\d:[0-5]\d$/.test(f.endTime)) return 'End time must be HH:MM.'
    return null
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const err = validate(form)
    if (err) {
      toast({ title: err, variant: 'destructive' })
      return
    }
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        startTime: form.startTime,
        endTime: form.endTime,
        workingDays: form.workingDays,
        breakMinutes: Number(form.breakMinutes) || 60,
        gracePeriodMinutes: Number(form.gracePeriodMinutes) || 15,
        isDefault: form.isDefault,
      })
      toast({ title: 'Shift template added', description: form.name.trim() })
      setForm(EMPTY_FORM)
      setOpen(false)
    } catch (e: any) {
      toast({
        title: 'Could not add shift',
        description: e?.message,
        variant: 'destructive',
      })
    }
  }

  const startEdit = (s: ShiftTemplate) => {
    setEditing(s)
    setEditForm({
      name: s.name,
      description: s.description ?? '',
      startTime: s.startTime,
      endTime: s.endTime,
      breakMinutes: String(s.breakMinutes),
      gracePeriodMinutes: String(s.gracePeriodMinutes),
      workingDays: [...s.workingDays].sort(),
      isDefault: s.isDefault,
    })
  }

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    const err = validate(editForm)
    if (err) {
      toast({ title: err, variant: 'destructive' })
      return
    }
    try {
      await update.mutateAsync({
        id: editing.id,
        payload: {
          name: editForm.name.trim(),
          description: editForm.description.trim() || undefined,
          startTime: editForm.startTime,
          endTime: editForm.endTime,
          workingDays: editForm.workingDays,
          breakMinutes: Number(editForm.breakMinutes) || 60,
          gracePeriodMinutes: Number(editForm.gracePeriodMinutes) || 15,
          isDefault: editForm.isDefault,
        },
      })
      toast({ title: 'Shift template updated' })
      setEditing(null)
    } catch (e: any) {
      toast({
        title: 'Could not update',
        description: e?.message,
        variant: 'destructive',
      })
    }
  }

  const handleToggleActive = async (s: ShiftTemplate) => {
    try {
      await update.mutateAsync({
        id: s.id,
        payload: { isActive: !s.isActive },
      })
      toast({
        title: s.isActive ? 'Shift deactivated' : 'Shift reactivated',
        description: s.name,
      })
    } catch (e: any) {
      toast({ title: e?.message, variant: 'destructive' })
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <SettingsLayout>
      <div className="card">
        <SectionHead
          title="Working hours & shifts"
          sub={`${items.length} shift template${items.length === 1 ? '' : 's'} · ${assignedTotal} employee${assignedTotal === 1 ? '' : 's'} assigned`}
          right={
            <Btn
              kind="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setOpen(true)}
            >
              Add shift
            </Btn>
          }
        />

        {isLoading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 px-6">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(62, 123, 250, 0.13)', color: 'var(--blue)' }}
            >
              <Icon.clock size={20} />
            </div>
            <div className="t-h3 mb-1">No shift templates yet</div>
            <p className="t-mute mb-4">
              Create a shift to set working days, hours, and break rules for your employees.
            </p>
            <Btn
              kind="primary"
              icon={<Plus className="w-4 h-4" />}
              onClick={() => setOpen(true)}
            >
              Add your first shift
            </Btn>
          </div>
        ) : (
          <div>
            {items.map((s, i) => {
              const accent = PALETTE[i % PALETTE.length]
              return (
                <div
                  key={s.id}
                  style={{
                    padding: 14,
                    borderTop: i ? '1px solid var(--bord)' : 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    opacity: s.isActive ? 1 : 0.5,
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 9,
                      background: accent.tint,
                      color: accent.c,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon.clock size={16} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 800,
                        marginBottom: 2,
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                      }}
                    >
                      {s.name}
                      {s.isDefault && <Pill tone="blue">Default</Pill>}
                      {!s.isActive && <Pill>Inactive</Pill>}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: 'var(--text-mute)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {s.startTime} – {s.endTime} · {daysLabel(s.workingDays)} · {s.breakMinutes}min break
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', minWidth: 72 }}>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>{s.assigned || '—'}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                      assigned
                    </div>
                  </div>
                  <Btn kind="ghost" size="sm" onClick={() => startEdit(s)}>
                    Edit
                  </Btn>
                  <Btn
                    kind="ghost"
                    size="sm"
                    onClick={() => handleToggleActive(s)}
                    disabled={update.isPending}
                  >
                    {s.isActive ? 'Deactivate' : 'Reactivate'}
                  </Btn>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add dialog */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) setForm(EMPTY_FORM); setOpen(o) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add shift template</DialogTitle>
          </DialogHeader>
          <ShiftForm
            form={form}
            setForm={setForm}
            onToggleDay={(d) => toggleDay(d, 'add')}
            onSubmit={handleAdd}
            onCancel={() => setOpen(false)}
            submitting={create.isPending}
            submitLabel="Add shift"
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit shift template</DialogTitle>
          </DialogHeader>
          <ShiftForm
            form={editForm}
            setForm={setEditForm}
            onToggleDay={(d) => toggleDay(d, 'edit')}
            onSubmit={handleEdit}
            onCancel={() => setEditing(null)}
            submitting={update.isPending}
            submitLabel="Save changes"
          />
        </DialogContent>
      </Dialog>
    </SettingsLayout>
  )
}

// ─── Shared form (Add + Edit) ────────────────────────────────────────────────

function ShiftForm({
  form,
  setForm,
  onToggleDay,
  onSubmit,
  onCancel,
  submitting,
  submitLabel,
}: {
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  onToggleDay: (d: number) => void
  onSubmit: (e: React.FormEvent) => void
  onCancel: () => void
  submitting: boolean
  submitLabel: string
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label className="label">Name</label>
        <input
          className="input"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="General, Sales 6-day, Support rotational…"
          autoFocus
          required
          maxLength={120}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="label">Start</label>
          <input
            className="input"
            type="time"
            value={form.startTime}
            onChange={(e) => setForm({ ...form, startTime: e.target.value })}
            required
          />
        </div>
        <div className="space-y-1.5">
          <label className="label">End</label>
          <input
            className="input"
            type="time"
            value={form.endTime}
            onChange={(e) => setForm({ ...form, endTime: e.target.value })}
            required
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="label">Working days</label>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d) => {
            const on = form.workingDays.includes(d.v)
            return (
              <button
                key={d.v}
                type="button"
                onClick={() => onToggleDay(d.v)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                style={{
                  background: on ? 'var(--blue)' : 'var(--surf-1)',
                  color: on ? '#fff' : 'var(--text-2)',
                  border: '1px solid ' + (on ? 'var(--blue)' : 'var(--bord)'),
                }}
              >
                {d.l}
              </button>
            )
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="label">Break (minutes)</label>
          <input
            className="input"
            type="number"
            min={0}
            max={240}
            value={form.breakMinutes}
            onChange={(e) => setForm({ ...form, breakMinutes: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <label className="label">Grace period (minutes)</label>
          <input
            className="input"
            type="number"
            min={0}
            max={120}
            value={form.gracePeriodMinutes}
            onChange={(e) =>
              setForm({ ...form, gracePeriodMinutes: e.target.value })
            }
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={form.isDefault}
          onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
        />
        <span>Set as default shift for new employees</span>
      </label>
      <div className="flex justify-end gap-3 pt-2">
        <Btn kind="ghost" type="button" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn kind="primary" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </Btn>
      </div>
    </form>
  )
}
