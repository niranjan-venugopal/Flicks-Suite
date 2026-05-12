'use client'

import { useMemo, useState } from 'react'
import { Loader2, Plus, Users } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import {
  useDepartments,
  useCreateDepartment,
  useUpdateDepartment,
  type Department,
} from '@/lib/api/queries/use-settings'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

export default function DepartmentsSettingsPage() {
  const { data, isLoading } = useDepartments()
  const create = useCreateDepartment()
  const update = useUpdateDepartment()
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [editing, setEditing] = useState<Department | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')

  const items = data?.data ?? []
  const activeCount = useMemo(() => items.filter((d) => d.isActive).length, [items])
  const totalHeadcount = useMemo(
    () => items.reduce((sum, d) => sum + (d.headcount ?? 0), 0),
    [items],
  )

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
      })
      toast({ title: 'Department added', description: name.trim() })
      setName('')
      setDescription('')
      setOpen(false)
    } catch (err: any) {
      toast({
        title: 'Could not add department',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    try {
      await update.mutateAsync({
        id: editing.id,
        payload: {
          name: editName.trim(),
          description: editDescription.trim() || undefined,
        },
      })
      toast({ title: 'Department updated' })
      setEditing(null)
    } catch (err: any) {
      toast({
        title: 'Could not update',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleToggleActive = async (dept: Department) => {
    try {
      await update.mutateAsync({
        id: dept.id,
        payload: { isActive: !dept.isActive },
      })
      toast({
        title: dept.isActive ? 'Department deactivated' : 'Department reactivated',
        description: dept.name,
      })
    } catch (err: any) {
      toast({
        title: 'Could not change status',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const startEdit = (dept: Department) => {
    setEditing(dept)
    setEditName(dept.name)
    setEditDescription(dept.description ?? '')
  }

  return (
    <SettingsLayout>
      <SectionHead
        title="Departments"
        sub="Organise your workforce into business units used for reports, approvals, and leave policies."
        right={
          <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setOpen(true)}>
            Add department
          </Btn>
        }
      />

        {/* KPI strip */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <div className="card p-4">
            <div className="t-caption">Total departments</div>
            <div className="text-2xl font-bold text-white mt-1">{items.length}</div>
          </div>
          <div className="card p-4">
            <div className="t-caption">Active</div>
            <div className="text-2xl font-bold text-white mt-1">{activeCount}</div>
          </div>
          <div className="card p-4">
            <div className="t-caption">Headcount placed</div>
            <div className="text-2xl font-bold text-white mt-1">{totalHeadcount}</div>
          </div>
        </div>

        {isLoading ? (
          <div className="card p-12 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
          </div>
        ) : items.length === 0 ? (
          <div className="card p-12 text-center">
            <div className="w-12 h-12 rounded-xl bg-brand-blue/10 flex items-center justify-center mx-auto mb-4">
              <Users className="w-5 h-5 text-brand-blue" />
            </div>
            <h3 className="t-h3 mb-1">No departments yet</h3>
            <p className="t-mute mb-4">Add Engineering, Sales, Operations… anything that maps to how your org is structured.</p>
            <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setOpen(true)}>
              Add your first department
            </Btn>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="tbl w-full">
              <thead>
                <tr>
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
                      <div className="font-semibold text-white">{d.name}</div>
                      {d.description && (
                        <div className="text-xs text-brand-muted mt-0.5 max-w-md truncate">
                          {d.description}
                        </div>
                      )}
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
            <DialogTitle>Add department</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-1.5">
              <label className="label">Name</label>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Engineering"
                autoFocus
                required
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <label className="label">Description (optional)</label>
              <input
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Product engineering and platform"
                maxLength={200}
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Btn kind="ghost" type="button" onClick={() => setOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" disabled={create.isPending}>
                {create.isPending ? 'Adding…' : 'Add department'}
              </Btn>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit department</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="label">Name</label>
              <input
                className="input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <label className="label">Description</label>
              <input
                className="input"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                maxLength={200}
              />
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
