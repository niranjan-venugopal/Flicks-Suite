'use client'

import { useMemo, useState } from 'react'
import { Briefcase, Loader2, Plus, Users } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import {
  useDepartments,
  useDesignations,
  useCreateDesignation,
  useUpdateDesignation,
  type Designation,
} from '@/lib/api/queries/use-settings'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

export default function DesignationsSettingsPage() {
  const { data, isLoading } = useDesignations()
  const { data: deptData } = useDepartments()
  const create = useCreateDesignation()
  const update = useUpdateDesignation()
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: '', level: '', departmentId: '' })
  const [editing, setEditing] = useState<Designation | null>(null)
  const [editForm, setEditForm] = useState({ title: '', level: '', departmentId: '' })

  const items = data?.data ?? []
  const depts = deptData?.data ?? []
  const activeCount = useMemo(() => items.filter((d) => d.isActive).length, [items])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim()) return
    try {
      // Build payload conditionally — never send empty strings, which would
      // fail server-side @IsUUID() on departmentId despite @IsOptional()
      // (class-validator treats '' as a defined value).
      const payload: Parameters<typeof create.mutateAsync>[0] = {
        title: form.title.trim(),
      }
      if (form.level.trim()) {
        const n = Number(form.level)
        if (Number.isFinite(n)) payload.level = n
      }
      if (form.departmentId) payload.departmentId = form.departmentId

      await create.mutateAsync(payload)
      toast({ title: 'Designation added', description: form.title.trim() })
      setForm({ title: '', level: '', departmentId: '' })
      setOpen(false)
    } catch (err: any) {
      toast({
        title: 'Could not add designation',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const startEdit = (d: Designation) => {
    setEditing(d)
    setEditForm({
      title: d.title,
      level: d.level?.toString() ?? '',
      departmentId: d.departmentId ?? '',
    })
  }

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    try {
      const payload: Parameters<typeof update.mutateAsync>[0]['payload'] = {
        title: editForm.title.trim(),
      }
      if (editForm.level.trim()) {
        const n = Number(editForm.level)
        if (Number.isFinite(n)) payload.level = n
      }
      if (editForm.departmentId) payload.departmentId = editForm.departmentId

      await update.mutateAsync({ id: editing.id, payload })
      toast({ title: 'Designation updated' })
      setEditing(null)
    } catch (err: any) {
      toast({
        title: 'Could not update',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleToggleActive = async (d: Designation) => {
    try {
      await update.mutateAsync({
        id: d.id,
        payload: { isActive: !d.isActive },
      })
      toast({
        title: d.isActive ? 'Designation deactivated' : 'Designation reactivated',
        description: d.title,
      })
    } catch (err: any) {
      toast({
        title: 'Could not change status',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  return (
    <SettingsLayout>
      <SectionHead
        title="Designations"
        sub="Job titles assigned to employees. Levels (L1–L10) drive seniority bands and pay grade reports."
        right={
          <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setOpen(true)}>
            Add designation
          </Btn>
        }
      />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <div className="card p-4">
            <div className="t-caption">Total designations</div>
            <div className="text-2xl font-bold text-white mt-1">{items.length}</div>
          </div>
          <div className="card p-4">
            <div className="t-caption">Active</div>
            <div className="text-2xl font-bold text-white mt-1">{activeCount}</div>
          </div>
          <div className="card p-4">
            <div className="t-caption">Linked to departments</div>
            <div className="text-2xl font-bold text-white mt-1">
              {items.filter((d) => d.departmentId).length}
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="card p-12 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : items.length === 0 ? (
          <div className="card p-12 text-center">
            <div className="w-12 h-12 rounded-xl bg-brand-purple/10 flex items-center justify-center mx-auto mb-4">
              <Briefcase className="w-5 h-5 text-brand-purple" />
            </div>
            <h3 className="t-h3 mb-1">No designations yet</h3>
            <p className="t-mute mb-4">Add titles like "Software Engineer" or "Account Executive" with optional seniority levels.</p>
            <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setOpen(true)}>
              Add your first designation
            </Btn>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="tbl w-full">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Level</th>
                  <th>Department</th>
                  <th>Headcount</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id} className={d.isActive ? '' : 'opacity-50'}>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-brand-purple/10 flex items-center justify-center shrink-0">
                          <Briefcase className="w-3.5 h-3.5 text-brand-purple" />
                        </div>
                        <div className="font-semibold text-white">{d.title}</div>
                      </div>
                    </td>
                    <td>
                      {d.level ? <Pill tone="purple">L{d.level}</Pill> : <span className="text-brand-muted">—</span>}
                    </td>
                    <td className="text-sm text-brand-muted">
                      {d.departmentName ?? 'All departments'}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <Users className="w-3.5 h-3.5 text-brand-muted" />
                        {d.headcount}
                      </span>
                    </td>
                    <td>
                      {d.isActive ? (
                        <Pill tone="green" dot>Active</Pill>
                      ) : (
                        <Pill>Inactive</Pill>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-2">
                        <Btn kind="ghost" size="sm" onClick={() => startEdit(d)}>
                          Edit
                        </Btn>
                        <Btn
                          kind="ghost"
                          size="sm"
                          onClick={() => handleToggleActive(d)}
                          disabled={update.isPending}
                        >
                          {d.isActive ? 'Deactivate' : 'Reactivate'}
                        </Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {/* Add dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add designation</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-1.5">
              <label className="label">Title</label>
              <input
                className="input"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Senior Software Engineer"
                autoFocus
                required
                maxLength={160}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="label">Level (L1–L10)</label>
                <input
                  className="input"
                  value={form.level}
                  onChange={(e) => setForm({ ...form, level: e.target.value })}
                  placeholder="5"
                  type="number"
                  min={1}
                  max={20}
                />
              </div>
              <div className="space-y-1.5">
                <label className="label">Department</label>
                <select
                  className="input"
                  value={form.departmentId}
                  onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
                >
                  <option value="">All departments (common)</option>
                  {depts.filter((d) => d.isActive).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Btn kind="ghost" type="button" onClick={() => setOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" disabled={create.isPending}>
                {create.isPending ? 'Adding…' : 'Add designation'}
              </Btn>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit designation</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="label">Title</label>
              <input
                className="input"
                value={editForm.title}
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                required
                maxLength={160}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="label">Level</label>
                <input
                  className="input"
                  value={editForm.level}
                  onChange={(e) => setEditForm({ ...editForm, level: e.target.value })}
                  type="number"
                  min={1}
                  max={20}
                />
              </div>
              <div className="space-y-1.5">
                <label className="label">Department</label>
                <select
                  className="input"
                  value={editForm.departmentId}
                  onChange={(e) => setEditForm({ ...editForm, departmentId: e.target.value })}
                >
                  <option value="">All departments (common)</option>
                  {depts.filter((d) => d.isActive).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Btn kind="ghost" type="button" onClick={() => setEditing(null)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" disabled={update.isPending}>
                {update.isPending ? 'Saving…' : 'Save changes'}
              </Btn>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsLayout>
  )
}
