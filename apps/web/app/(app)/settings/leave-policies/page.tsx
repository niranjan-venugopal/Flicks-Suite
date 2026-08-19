'use client'

import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import {
  useLeavePolicies,
  useCreateLeavePolicy,
  useUpdateLeavePolicy,
  type LeavePolicy,
  type LeaveAccrualMethod,
} from '@/lib/api/queries/use-settings'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ACCRUAL_OPTIONS: Array<{ v: LeaveAccrualMethod; l: string }> = [
  { v: 'none',            l: 'Frontloaded once a year' },
  { v: 'monthly',         l: 'Monthly accrual' },
  { v: 'quarterly',       l: 'Quarterly accrual' },
  { v: 'annually',        l: 'Annual accrual' },
  { v: 'per_working_day', l: 'Per working day' },
]

function accrualLabel(m: LeaveAccrualMethod, quotaDays: number): string {
  switch (m) {
    case 'none':            return `Frontload ${quotaDays}/yr`
    case 'monthly':         return `${(quotaDays / 12).toFixed(1)}/month`
    case 'quarterly':       return `${(quotaDays / 4).toFixed(1)}/quarter`
    case 'annually':        return `${quotaDays}/year`
    case 'per_working_day': return `Per working day`
    default:                return m
  }
}

function carryLabel(p: LeavePolicy): string {
  if (!p.carryForwardAllowed) return 'No'
  if (!p.maxCarryForwardDays) return 'Unlimited'
  return `Up to ${p.maxCarryForwardDays}`
}

function encashLabel(p: LeavePolicy): string {
  return p.encashable ? 'Yes · on exit' : 'No'
}

// ─── Form ────────────────────────────────────────────────────────────────────

type FormState = {
  name: string
  code: string
  defaultQuotaDays: string
  accrualMethod: LeaveAccrualMethod
  carryForwardAllowed: boolean
  maxCarryForwardDays: string
  encashable: boolean
  isPaid: boolean
  allowHalfDay: boolean
  minNoticeDays: string
  color: string
}

const COLOR_OPTIONS = [
  '#3E7BFA', '#27D280', '#9B7BFA', '#FED800', '#F8786B',
]

const EMPTY: FormState = {
  name: '',
  code: '',
  defaultQuotaDays: '12',
  accrualMethod: 'monthly',
  carryForwardAllowed: false,
  maxCarryForwardDays: '0',
  encashable: false,
  isPaid: true,
  allowHalfDay: true,
  minNoticeDays: '0',
  color: '#3E7BFA',
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LeavePoliciesPage() {
  const { data, isLoading } = useLeavePolicies()
  const create = useCreateLeavePolicy()
  const update = useUpdateLeavePolicy()
  const { toast } = useToast()

  const items = data?.data ?? []
  const active = items.filter((p) => p.isActive).length

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [editing, setEditing] = useState<LeavePolicy | null>(null)
  const [editForm, setEditForm] = useState<FormState>(EMPTY)

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.code.trim()) {
      toast({ title: 'Name and code are required', variant: 'destructive' })
      return
    }
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        defaultQuotaDays: Number(form.defaultQuotaDays) || 0,
        accrualMethod: form.accrualMethod,
        carryForwardAllowed: form.carryForwardAllowed,
        maxCarryForwardDays: Number(form.maxCarryForwardDays) || 0,
        encashable: form.encashable,
        isPaid: form.isPaid,
        allowHalfDay: form.allowHalfDay,
        minNoticeDays: Number(form.minNoticeDays) || 0,
        color: form.color,
      })
      toast({ title: 'Leave policy added', description: form.name.trim() })
      setForm(EMPTY)
      setOpen(false)
    } catch (e: any) {
      toast({
        title: 'Could not add policy',
        description: e?.message,
        variant: 'destructive',
      })
    }
  }

  const startEdit = (p: LeavePolicy) => {
    setEditing(p)
    setEditForm({
      name: p.name,
      code: p.code,
      defaultQuotaDays: String(p.defaultQuotaDays),
      accrualMethod: p.accrualMethod,
      carryForwardAllowed: p.carryForwardAllowed,
      maxCarryForwardDays: String(p.maxCarryForwardDays),
      encashable: p.encashable,
      isPaid: p.isPaid,
      allowHalfDay: p.allowHalfDay,
      minNoticeDays: String(p.minNoticeDays),
      color: p.color ?? '#3E7BFA',
    })
  }

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    try {
      await update.mutateAsync({
        id: editing.id,
        payload: {
          name: editForm.name.trim(),
          defaultQuotaDays: Number(editForm.defaultQuotaDays) || 0,
          accrualMethod: editForm.accrualMethod,
          carryForwardAllowed: editForm.carryForwardAllowed,
          maxCarryForwardDays: Number(editForm.maxCarryForwardDays) || 0,
          encashable: editForm.encashable,
          isPaid: editForm.isPaid,
          allowHalfDay: editForm.allowHalfDay,
          minNoticeDays: Number(editForm.minNoticeDays) || 0,
          color: editForm.color,
        },
      })
      toast({ title: 'Policy updated' })
      setEditing(null)
    } catch (e: any) {
      toast({
        title: 'Could not update',
        description: e?.message,
        variant: 'destructive',
      })
    }
  }

  const handleToggle = async (p: LeavePolicy) => {
    try {
      await update.mutateAsync({
        id: p.id,
        payload: { isActive: !p.isActive },
      })
      toast({
        title: p.isActive ? 'Policy deactivated' : 'Policy reactivated',
        description: p.name,
      })
    } catch (e: any) {
      toast({ title: e?.message, variant: 'destructive' })
    }
  }

  return (
    <SettingsLayout>
      <div className="card">
        <SectionHead
          title="Leave policy"
          sub={`${items.length} type${items.length === 1 ? '' : 's'} · ${active} active · applies to all full-time employees`}
          right={
            <Btn
              kind="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setOpen(true)}
            >
              Add policy
            </Btn>
          }
        />

        {isLoading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 px-6">
            <div className="t-h3 mb-1">No leave policies yet</div>
            <p className="t-mute mb-4">
              Add CL, SL, EL, ML, PL… each with its own quota, accrual, and carry-forward rules.
            </p>
            <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setOpen(true)}>
              Add your first policy
            </Btn>
          </div>
        ) : (
          <div className="tbl-scroll">
          <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bord)' }}>
                <th style={th}>Type</th>
                <th style={th}>Annual quota</th>
                <th style={th}>Accrual</th>
                <th style={th}>Carry forward</th>
                <th style={th}>Encashment</th>
                <th style={th}>Used YTD</th>
                <th style={{ ...th, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p, i, arr) => (
                <tr
                  key={p.id}
                  style={{
                    borderBottom: i < arr.length - 1 ? '1px solid var(--bord)' : 'none',
                    opacity: p.isActive ? 1 : 0.5,
                  }}
                >
                  <td style={{ padding: '12px 14px', fontWeight: 800, fontSize: 13 }}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 99,
                          background: p.color ?? '#3E7BFA',
                          display: 'inline-block',
                        }}
                      />
                      {p.name}
                      <Pill>{p.code}</Pill>
                      {!p.isPaid && <Pill tone="coral">Unpaid</Pill>}
                    </span>
                  </td>
                  <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                    {p.defaultQuotaDays}
                  </td>
                  <td style={td}>{accrualLabel(p.accrualMethod, p.defaultQuotaDays)}</td>
                  <td style={td}>{carryLabel(p)}</td>
                  <td style={td}>{encashLabel(p)}</td>
                  <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
                    {Number(p.approvedYtd).toFixed(1)}
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                    <div className="flex justify-end gap-2">
                      <Btn kind="ghost" size="sm" onClick={() => startEdit(p)}>
                        Edit
                      </Btn>
                      <Btn
                        kind="ghost"
                        size="sm"
                        onClick={() => handleToggle(p)}
                        disabled={update.isPending}
                      >
                        {p.isActive ? 'Deactivate' : 'Reactivate'}
                      </Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Add dialog */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) setForm(EMPTY); setOpen(o) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add leave policy</DialogTitle>
          </DialogHeader>
          <PolicyForm
            form={form}
            setForm={setForm}
            includeCode={true}
            onSubmit={handleAdd}
            onCancel={() => setOpen(false)}
            submitting={create.isPending}
            submitLabel="Add policy"
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit policy</DialogTitle>
          </DialogHeader>
          <PolicyForm
            form={editForm}
            setForm={setEditForm}
            includeCode={false}
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

// ─── Cell styles ─────────────────────────────────────────────────────────────

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 11.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-mute)',
}

const td: React.CSSProperties = {
  padding: '12px 14px',
  fontSize: 12.5,
  color: 'var(--text-2)',
}

// ─── Shared policy form ──────────────────────────────────────────────────────

function PolicyForm({
  form,
  setForm,
  includeCode,
  onSubmit,
  onCancel,
  submitting,
  submitLabel,
}: {
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  includeCode: boolean
  onSubmit: (e: React.FormEvent) => void
  onCancel: () => void
  submitting: boolean
  submitLabel: string
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5 col-span-2">
          <label className="label">Name</label>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Casual Leave"
            required
            autoFocus={includeCode}
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <label className="label">Code</label>
          <input
            className="input font-mono uppercase"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            placeholder="CL"
            required
            disabled={!includeCode}
            maxLength={20}
            pattern="[A-Z0-9]+"
            title="Uppercase letters and digits only"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="label">Annual quota (days)</label>
          <input
            className="input"
            type="number"
            min={0}
            max={365}
            value={form.defaultQuotaDays}
            onChange={(e) => setForm({ ...form, defaultQuotaDays: e.target.value })}
            required
          />
        </div>
        <div className="space-y-1.5">
          <label className="label">Accrual</label>
          <select
            className="input"
            value={form.accrualMethod}
            onChange={(e) =>
              setForm({ ...form, accrualMethod: e.target.value as LeaveAccrualMethod })
            }
          >
            {ACCRUAL_OPTIONS.map((o) => (
              <option key={o.v} value={o.v}>{o.l}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer mt-6">
          <input
            type="checkbox"
            checked={form.carryForwardAllowed}
            onChange={(e) => setForm({ ...form, carryForwardAllowed: e.target.checked })}
          />
          <span>Allow carry forward</span>
        </label>
        <div className="space-y-1.5">
          <label className="label">Max carry forward (days)</label>
          <input
            className="input"
            type="number"
            min={0}
            max={365}
            value={form.maxCarryForwardDays}
            onChange={(e) => setForm({ ...form, maxCarryForwardDays: e.target.value })}
            disabled={!form.carryForwardAllowed}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="label">Min notice (days)</label>
          <input
            className="input"
            type="number"
            min={0}
            max={60}
            value={form.minNoticeDays}
            onChange={(e) => setForm({ ...form, minNoticeDays: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <label className="label">Color</label>
          <div className="flex gap-1.5">
            {COLOR_OPTIONS.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => setForm({ ...form, color: hex })}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: hex,
                  border: form.color === hex ? '2px solid white' : '2px solid transparent',
                  cursor: 'pointer',
                }}
                aria-label={hex}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 pt-2">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.isPaid}
            onChange={(e) => setForm({ ...form, isPaid: e.target.checked })}
          />
          <span>Paid leave</span>
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.encashable}
            onChange={(e) => setForm({ ...form, encashable: e.target.checked })}
          />
          <span>Encashable</span>
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.allowHalfDay}
            onChange={(e) => setForm({ ...form, allowHalfDay: e.target.checked })}
          />
          <span>Allow half-day</span>
        </label>
      </div>

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
