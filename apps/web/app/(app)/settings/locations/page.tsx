'use client'

import { useMemo, useState } from 'react'
import { Loader2, MapPin, Plus, Users } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { SettingsTabs } from '@/components/layout/SettingsTabs'
import {
  useLocations,
  useCreateLocation,
  useUpdateLocation,
  type Location,
} from '@/lib/api/queries/use-settings'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
]

const STATE_CODES = [
  'AN','AP','AR','AS','BR','CG','CH','DD','DL','DN','GA','GJ','HP','HR','JH',
  'JK','KA','KL','LA','LD','MH','ML','MN','MP','MZ','NL','OR','PB','PY','RJ',
  'SK','TN','TR','TS','UK','UP','WB',
]

export default function LocationsSettingsPage() {
  const { data, isLoading } = useLocations()
  const create = useCreateLocation()
  const update = useUpdateLocation()
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    addressLine1: '',
    city: '',
    stateCode: '',
    postalCode: '',
    timezone: 'Asia/Kolkata',
  })

  const [editing, setEditing] = useState<Location | null>(null)
  const [editForm, setEditForm] = useState({
    name: '',
    addressLine1: '',
    city: '',
    postalCode: '',
  })

  const items = data?.data ?? []
  const activeCount = useMemo(() => items.filter((l) => l.isActive).length, [items])
  const totalHeadcount = useMemo(
    () => items.reduce((sum, l) => sum + (l.headcount ?? 0), 0),
    [items],
  )

  const reset = () =>
    setForm({
      name: '',
      addressLine1: '',
      city: '',
      stateCode: '',
      postalCode: '',
      timezone: 'Asia/Kolkata',
    })

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        addressLine1: form.addressLine1.trim() || undefined,
        city: form.city.trim() || undefined,
        stateCode: form.stateCode || undefined,
        postalCode: form.postalCode.trim() || undefined,
        timezone: form.timezone,
      })
      toast({ title: 'Location added', description: form.name.trim() })
      reset()
      setOpen(false)
    } catch (err: any) {
      toast({
        title: 'Could not add location',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const startEdit = (loc: Location) => {
    setEditing(loc)
    setEditForm({
      name: loc.name,
      addressLine1: loc.addressLine1 ?? '',
      city: loc.city ?? '',
      postalCode: loc.postalCode ?? '',
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
          addressLine1: editForm.addressLine1.trim() || undefined,
          city: editForm.city.trim() || undefined,
          postalCode: editForm.postalCode.trim() || undefined,
        },
      })
      toast({ title: 'Location updated' })
      setEditing(null)
    } catch (err: any) {
      toast({
        title: 'Could not update',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleToggleActive = async (loc: Location) => {
    try {
      await update.mutateAsync({
        id: loc.id,
        payload: { isActive: !loc.isActive },
      })
      toast({
        title: loc.isActive ? 'Location deactivated' : 'Location reactivated',
        description: loc.name,
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
    <div className="relative min-h-full">
      <div className="relative z-10 p-8 max-w-5xl mx-auto">
        <SettingsTabs />
        <SectionHead
          eyebrow="Settings"
          title="Locations"
          sub="Offices and work sites employees can be assigned to. Used for attendance, payroll, and reports."
          right={
            <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setOpen(true)}>
              Add location
            </Btn>
          }
        />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <div className="card p-4">
            <div className="t-caption">Total locations</div>
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
              <MapPin className="w-5 h-5 text-brand-blue" />
            </div>
            <h3 className="t-h3 mb-1">No locations yet</h3>
            <p className="t-mute mb-4">Add your first office so employees can be assigned to it.</p>
            <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setOpen(true)}>
              Add your first location
            </Btn>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="tbl w-full">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Address</th>
                  <th>Timezone</th>
                  <th>Headcount</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id} className={l.isActive ? '' : 'opacity-50'}>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-brand-blue/10 flex items-center justify-center shrink-0">
                          <MapPin className="w-3.5 h-3.5 text-brand-blue" />
                        </div>
                        <div className="font-semibold text-white">{l.name}</div>
                      </div>
                    </td>
                    <td className="text-sm text-brand-muted">
                      {[l.addressLine1, l.city, l.stateCode, l.postalCode]
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </td>
                    <td className="text-sm text-brand-muted">{l.timezone}</td>
                    <td>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <Users className="w-3.5 h-3.5 text-brand-muted" />
                        {l.headcount}
                      </span>
                    </td>
                    <td>
                      {l.isActive ? (
                        <Pill tone="green" dot>Active</Pill>
                      ) : (
                        <Pill>Inactive</Pill>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-2">
                        <Btn kind="ghost" size="sm" onClick={() => startEdit(l)}>
                          Edit
                        </Btn>
                        <Btn
                          kind="ghost"
                          size="sm"
                          onClick={() => handleToggleActive(l)}
                          disabled={update.isPending}
                        >
                          {l.isActive ? 'Deactivate' : 'Reactivate'}
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
      <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); setOpen(o) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add location</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-1.5">
              <label className="label">Name</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Bengaluru HQ"
                autoFocus
                required
                maxLength={160}
              />
            </div>
            <div className="space-y-1.5">
              <label className="label">Address</label>
              <input
                className="input"
                value={form.addressLine1}
                onChange={(e) => setForm({ ...form, addressLine1: e.target.value })}
                placeholder="100ft Road, Indiranagar"
                maxLength={200}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="label">City</label>
                <input
                  className="input"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  placeholder="Bengaluru"
                />
              </div>
              <div className="space-y-1.5">
                <label className="label">State</label>
                <select
                  className="input"
                  value={form.stateCode}
                  onChange={(e) => setForm({ ...form, stateCode: e.target.value })}
                >
                  <option value="">—</option>
                  {STATE_CODES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="label">PIN</label>
                <input
                  className="input"
                  value={form.postalCode}
                  onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                  placeholder="560038"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="label">Timezone</label>
              <select
                className="input"
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Btn kind="ghost" type="button" onClick={() => setOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" disabled={create.isPending}>
                {create.isPending ? 'Adding…' : 'Add location'}
              </Btn>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit location</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="label">Name</label>
              <input
                className="input"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                required
                maxLength={160}
              />
            </div>
            <div className="space-y-1.5">
              <label className="label">Address</label>
              <input
                className="input"
                value={editForm.addressLine1}
                onChange={(e) => setEditForm({ ...editForm, addressLine1: e.target.value })}
                maxLength={200}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="label">City</label>
                <input
                  className="input"
                  value={editForm.city}
                  onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="label">PIN</label>
                <input
                  className="input"
                  value={editForm.postalCode}
                  onChange={(e) => setEditForm({ ...editForm, postalCode: e.target.value })}
                  inputMode="numeric"
                />
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
    </div>
  )
}
