'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, Loader2, MapPin, Plus, Trash2, Users } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import {
  useLocations,
  useCreateLocation,
  useUpdateLocation,
  useDeleteLocation,
  useLocationDeletePreview,
  type Location,
} from '@/lib/api/queries/use-settings'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  COUNTRIES,
  IN_STATE_CODES as STATE_CODES,
  TIMEZONES,
  countryName,
} from '@/lib/countries'
import { stateName } from '@flicks/shared/constants'

// Suggest the office timezone from the chosen country so a Dubai branch
// doesn't accidentally stay on IST.
const DEFAULT_TZ: Record<string, string> = {
  IN: 'Asia/Kolkata', AE: 'Asia/Dubai', US: 'America/New_York',
  GB: 'Europe/London', SG: 'Asia/Singapore', AU: 'Australia/Sydney',
  CA: 'America/Toronto', SA: 'Asia/Riyadh', QA: 'Asia/Dubai',
  KW: 'Asia/Riyadh', BH: 'Asia/Riyadh', OM: 'Asia/Dubai',
  DE: 'Europe/Berlin', FR: 'Europe/Paris', NL: 'Europe/Amsterdam',
  LK: 'Asia/Colombo', BD: 'Asia/Dhaka', NP: 'Asia/Kathmandu',
  ID: 'Asia/Jakarta', PH: 'Asia/Manila', MY: 'Asia/Kuala_Lumpur',
  NZ: 'Pacific/Auckland',
}

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
    countryCode: 'IN',
    stateCode: '',
    postalCode: '',
    timezone: 'Asia/Kolkata',
    geofenceLat: '',
    geofenceLng: '',
    geofenceRadiusM: '',
  })

  const [editing, setEditing] = useState<Location | null>(null)
  const [editForm, setEditForm] = useState({
    name: '',
    addressLine1: '',
    city: '',
    countryCode: 'IN',
    stateCode: '',
    postalCode: '',
    timezone: 'Asia/Kolkata',
    geofenceLat: '',
    geofenceLng: '',
    geofenceRadiusM: '',
  })
  const [deleting, setDeleting] = useState<Location | null>(null)

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
      countryCode: 'IN',
      stateCode: '',
      postalCode: '',
      timezone: 'Asia/Kolkata',
      geofenceLat: '',
      geofenceLng: '',
      geofenceRadiusM: '',
    })

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        addressLine1: form.addressLine1.trim() || undefined,
        city: form.city.trim() || undefined,
        countryCode: form.countryCode,
        stateCode: form.stateCode.trim() || undefined,
        postalCode: form.postalCode.trim() || undefined,
        timezone: form.timezone,
        geofenceLat: form.geofenceLat.trim() || undefined,
        geofenceLng: form.geofenceLng.trim() || undefined,
        geofenceRadiusM: form.geofenceRadiusM ? Number(form.geofenceRadiusM) : undefined,
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
      countryCode: loc.countryCode || 'IN',
      stateCode: loc.stateCode ?? '',
      postalCode: loc.postalCode ?? '',
      timezone: loc.timezone || 'Asia/Kolkata',
      geofenceLat: loc.geofenceLat ?? '',
      geofenceLng: loc.geofenceLng ?? '',
      geofenceRadiusM: loc.geofenceRadiusM != null ? String(loc.geofenceRadiusM) : '',
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
          countryCode: editForm.countryCode,
          // '' clears the state (e.g. after a country switch)
          stateCode: editForm.stateCode.trim(),
          postalCode: editForm.postalCode.trim() || undefined,
          timezone: editForm.timezone,
          // '' / 0 clear the geofence
          geofenceLat: editForm.geofenceLat.trim(),
          geofenceLng: editForm.geofenceLng.trim(),
          geofenceRadiusM: editForm.geofenceRadiusM ? Number(editForm.geofenceRadiusM) : 0,
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
    <SettingsLayout>
      <SectionHead
        title="Locations & geofence"
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
                        <div>
                          <div className="font-semibold text-white">{l.name}</div>
                          {l.geofenceRadiusM ? (
                            <Pill tone="blue">Geofence · {l.geofenceRadiusM}m</Pill>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="text-sm text-brand-muted">
                      {[
                        l.addressLine1,
                        l.city,
                        stateName(l.stateCode),
                        l.postalCode,
                        l.countryCode !== 'IN' ? countryName(l.countryCode) : null,
                      ]
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
                        {!l.isActive && (
                          <Btn
                            kind="ghost"
                            size="sm"
                            icon={<Trash2 className="w-3.5 h-3.5" />}
                            onClick={() => setDeleting(l)}
                          >
                            Delete
                          </Btn>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="label">Country</label>
                <select
                  className="input"
                  value={form.countryCode}
                  onChange={(e) => {
                    const countryCode = e.target.value
                    setForm({
                      ...form,
                      countryCode,
                      // Indian GST codes don't apply elsewhere (and vice
                      // versa) — clear state and suggest the local timezone.
                      stateCode: '',
                      timezone: DEFAULT_TZ[countryCode] ?? form.timezone,
                    })
                  }}
                >
                  {COUNTRIES.map(([code, label]) => (
                    <option key={code} value={code}>{label}</option>
                  ))}
                </select>
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
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="label">City</label>
                <input
                  className="input"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  placeholder={form.countryCode === 'IN' ? 'Bengaluru' : 'Dubai'}
                />
              </div>
              <div className="space-y-1.5">
                <label className="label">{form.countryCode === 'IN' ? 'State' : 'State / Emirate'}</label>
                {form.countryCode === 'IN' ? (
                  <select
                    className="input"
                    value={form.stateCode}
                    onChange={(e) => setForm({ ...form, stateCode: e.target.value })}
                  >
                    <option value="">—</option>
                    {STATE_CODES.map((s) => (
                      <option key={s} value={s}>{stateName(s)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    value={form.stateCode}
                    onChange={(e) => setForm({ ...form, stateCode: e.target.value })}
                    placeholder="Dubai"
                    maxLength={40}
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <label className="label">{form.countryCode === 'IN' ? 'PIN' : 'Postal code'}</label>
                <input
                  className="input"
                  value={form.postalCode}
                  onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                  placeholder={form.countryCode === 'IN' ? '560038' : ''}
                  inputMode={form.countryCode === 'IN' ? 'numeric' : 'text'}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="label">Clock-in geofence (optional)</label>
              <div className="grid grid-cols-3 gap-3">
                <input
                  className="input"
                  value={form.geofenceLat}
                  onChange={(e) => setForm({ ...form, geofenceLat: e.target.value })}
                  placeholder="Latitude · 12.9352"
                  inputMode="decimal"
                />
                <input
                  className="input"
                  value={form.geofenceLng}
                  onChange={(e) => setForm({ ...form, geofenceLng: e.target.value })}
                  placeholder="Longitude · 77.6245"
                  inputMode="decimal"
                />
                <input
                  className="input"
                  value={form.geofenceRadiusM}
                  onChange={(e) => setForm({ ...form, geofenceRadiusM: e.target.value.replace(/[^0-9]/g, '') })}
                  placeholder="Radius (m) · 100"
                  inputMode="numeric"
                />
              </div>
              <p className="t-mute text-xs" style={{ margin: 0 }}>
                With all three set, clock-ins outside this circle are marked
                work-from-home (never blocked). Clear the fields to turn it off.
              </p>
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
                <label className="label">Country</label>
                <select
                  className="input"
                  value={editForm.countryCode}
                  onChange={(e) => {
                    const countryCode = e.target.value
                    setEditForm({
                      ...editForm,
                      countryCode,
                      stateCode: '',
                      timezone: DEFAULT_TZ[countryCode] ?? editForm.timezone,
                    })
                  }}
                >
                  {COUNTRIES.map(([code, label]) => (
                    <option key={code} value={code}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="label">Timezone</label>
                <select
                  className="input"
                  value={editForm.timezone}
                  onChange={(e) => setEditForm({ ...editForm, timezone: e.target.value })}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="label">City</label>
                <input
                  className="input"
                  value={editForm.city}
                  onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="label">{editForm.countryCode === 'IN' ? 'State' : 'State / Emirate'}</label>
                {editForm.countryCode === 'IN' ? (
                  <select
                    className="input"
                    value={editForm.stateCode}
                    onChange={(e) => setEditForm({ ...editForm, stateCode: e.target.value })}
                  >
                    <option value="">—</option>
                    {STATE_CODES.map((s) => (
                      <option key={s} value={s}>{stateName(s)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    value={editForm.stateCode}
                    onChange={(e) => setEditForm({ ...editForm, stateCode: e.target.value })}
                    maxLength={40}
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <label className="label">{editForm.countryCode === 'IN' ? 'PIN' : 'Postal code'}</label>
                <input
                  className="input"
                  value={editForm.postalCode}
                  onChange={(e) => setEditForm({ ...editForm, postalCode: e.target.value })}
                  inputMode={editForm.countryCode === 'IN' ? 'numeric' : 'text'}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="label">Clock-in geofence (optional)</label>
              <div className="grid grid-cols-3 gap-3">
                <input
                  className="input"
                  value={editForm.geofenceLat}
                  onChange={(e) => setEditForm({ ...editForm, geofenceLat: e.target.value })}
                  placeholder="Latitude · 12.9352"
                  inputMode="decimal"
                />
                <input
                  className="input"
                  value={editForm.geofenceLng}
                  onChange={(e) => setEditForm({ ...editForm, geofenceLng: e.target.value })}
                  placeholder="Longitude · 77.6245"
                  inputMode="decimal"
                />
                <input
                  className="input"
                  value={editForm.geofenceRadiusM}
                  onChange={(e) => setEditForm({ ...editForm, geofenceRadiusM: e.target.value.replace(/[^0-9]/g, '') })}
                  placeholder="Radius (m) · 100"
                  inputMode="numeric"
                />
              </div>
              <p className="t-mute text-xs" style={{ margin: 0 }}>
                With all three set, clock-ins outside this circle are marked
                work-from-home (never blocked). Clear the fields to turn it off.
              </p>
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

      {deleting && (
        <DeleteLocationDialog
          location={deleting}
          onClose={() => setDeleting(null)}
        />
      )}
    </SettingsLayout>
  )
}

// ─── Delete dialog (deactivate → delete → transfer employees) ────────────────

function DeleteLocationDialog({
  location,
  onClose,
}: {
  location: Location
  onClose: () => void
}) {
  const { toast } = useToast()
  const preview = useLocationDeletePreview(location.id)
  const del = useDeleteLocation()
  const [transferTo, setTransferTo] = useState('')

  const p = preview.data
  const needsTransfer = (p?.employees ?? 0) > 0

  const handleDelete = async () => {
    try {
      const res = await del.mutateAsync({
        id: location.id,
        transferTo: transferTo || undefined,
      })
      const target = p?.otherLocations.find((l) => l.id === transferTo)
      toast({
        title: 'Location deleted',
        description:
          res.movedEmployees > 0 && target
            ? `${res.movedEmployees} employee${res.movedEmployees === 1 ? '' : 's'} moved to ${target.name} — they now follow its holiday calendar.`
            : location.name,
      })
      onClose()
    } catch (err) {
      toast({
        title: 'Could not delete location',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {location.name}?</DialogTitle>
        </DialogHeader>
        {preview.isLoading || !p ? (
          <div className="p-6 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-brand-muted" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {needsTransfer ? (
              <>
                <div
                  className="flex items-start gap-2.5 p-3 rounded-lg"
                  style={{ background: 'var(--surf-2)', border: '1px solid var(--bord-2)' }}
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-brand-yellow" />
                  <p className="text-sm" style={{ margin: 0 }}>
                    <strong>{p.employees}</strong> employee{p.employees === 1 ? ' is' : 's are'} still
                    assigned here. Choose where to move them — they'll follow that
                    location's holiday calendar and policies from then on.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="label">Move employees to</label>
                  <select
                    className="input"
                    value={transferTo}
                    onChange={(e) => setTransferTo(e.target.value)}
                  >
                    <option value="">Select a location…</option>
                    {p.otherLocations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}{l.city ? ` · ${l.city}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <p className="t-mute text-sm" style={{ margin: 0 }}>
                No employees are assigned to this location.
              </p>
            )}
            {p.holidays > 0 && (
              <p className="t-mute text-sm" style={{ margin: 0 }}>
                Its {p.holidays} location-specific holiday{p.holidays === 1 ? '' : 's'} will be
                deleted with it (they won't become company-wide).
              </p>
            )}
            <p className="t-mute text-xs" style={{ margin: 0 }}>
              This can't be undone. Attendance history keeps its records.
            </p>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Btn kind="ghost" onClick={onClose} disabled={del.isPending}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            onClick={handleDelete}
            disabled={del.isPending || preview.isLoading || (needsTransfer && !transferTo)}
          >
            {del.isPending ? 'Deleting…' : needsTransfer && transferTo ? 'Move & delete' : 'Delete location'}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
