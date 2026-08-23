'use client'

import { useMemo, useState } from 'react'
import { CalendarDays, Download, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { Btn, Pill, SectionHead, type PillTone } from '@/components/proto'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { useLocations } from '@/lib/api/queries/use-settings'
import {
  useHolidays,
  useCreateHoliday,
  useUpdateHoliday,
  useDeleteHoliday,
  useImportHolidays,
  useHolidayPresets,
  type Holiday,
} from '@/lib/api/queries/use-leave'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DateField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'

const HOLIDAY_TYPES = ['national', 'regional', 'optional', 'restricted', 'company'] as const

const TYPE_TONE: Record<string, PillTone> = {
  national: 'green',
  regional: 'blue',
  optional: 'yellow',
  restricted: 'yellow',
  company: 'purple',
}

const PRESET_YEARS = [2026, 2027]

// Countries offered by the preset endpoint (kept in sync with the API's
// holiday-presets.ts; unknown selections just return an empty list).
const PRESET_COUNTRIES = [
  ['IN', 'India'],
  ['AE', 'United Arab Emirates'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
] as const

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export default function HolidaysSettingsPage() {
  const { toast } = useToast()
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [locationFilter, setLocationFilter] = useState<'all' | 'company' | string>('all')

  const { data, isLoading } = useHolidays(year, locationFilter)
  const { data: locData } = useLocations()
  const create = useCreateHoliday()
  const update = useUpdateHoliday()
  const del = useDeleteHoliday()

  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<Holiday | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const holidays = data?.holidays ?? []
  const locations = (locData?.data ?? []).filter((l) => l.isActive)

  const byMonth = useMemo(() => {
    const groups = new Map<number, Holiday[]>()
    for (const h of holidays) {
      const m = Number(h.date.slice(5, 7)) - 1
      const list = groups.get(m) ?? []
      list.push(h)
      groups.set(m, list)
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0])
  }, [holidays])

  const companyWide = holidays.filter((h) => !h.locationId).length

  const handleDelete = async (h: Holiday) => {
    if (!window.confirm(`Delete "${h.name}" (${h.date})? Leave-day math will no longer skip it.`)) return
    try {
      await del.mutateAsync(h.id)
      toast({ title: 'Holiday deleted', description: h.name })
    } catch (err) {
      toast({
        title: 'Could not delete',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <SettingsLayout>
      <SectionHead
        title="Holiday calendar"
        sub="Company-wide and per-location holidays. Leave day counts and attendance skip the holidays that apply to each employee's location."
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="secondary" icon={<Download className="w-4 h-4" />} onClick={() => setImportOpen(true)}>
              Import country list
            </Btn>
            <Btn kind="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setAddOpen(true)}>
              Add holiday
            </Btn>
          </div>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <select
          className="input"
          style={{ width: 110 }}
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <select
          className="input"
          style={{ width: 240 }}
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
        >
          <option value="all">All locations</option>
          <option value="company">Company-wide only</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}{l.city ? ` · ${l.city}` : ''}
            </option>
          ))}
        </select>
        <div className="t-mute text-sm" style={{ marginLeft: 'auto' }}>
          {holidays.length} holiday{holidays.length === 1 ? '' : 's'} · {companyWide} company-wide
        </div>
      </div>

      {isLoading ? (
        <div className="card p-12 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-brand-muted" />
        </div>
      ) : holidays.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="w-12 h-12 rounded-xl bg-brand-purple/10 flex items-center justify-center mx-auto mb-4">
            <CalendarDays className="w-5 h-5 text-brand-purple" />
          </div>
          <h3 className="t-h3 mb-1">No holidays for {year}</h3>
          <p className="t-mute mb-4">
            Import your country's list to start, then add regional festivals per office location.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Btn kind="primary" icon={<Download className="w-4 h-4" />} onClick={() => setImportOpen(true)}>
              Import country list
            </Btn>
            <Btn kind="secondary" icon={<Plus className="w-4 h-4" />} onClick={() => setAddOpen(true)}>
              Add manually
            </Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {byMonth.map(([month, list]) => (
            <div key={month} className="card overflow-hidden">
              <div className="px-4 py-2.5" style={{ borderBottom: '1px solid var(--bord)' }}>
                <span className="t-caption">{MONTHS[month]} {year}</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {list.map((h) => {
                    const dt = new Date(`${h.date}T00:00:00`)
                    return (
                      <tr key={h.id} style={{ borderBottom: '1px solid var(--bord)' }}>
                        <td className="px-4 py-2.5" style={{ width: 130, whiteSpace: 'nowrap' }}>
                          <span className="font-mono font-bold">
                            {String(dt.getDate()).padStart(2, '0')}
                          </span>{' '}
                          <span className="t-mute">
                            {dt.toLocaleDateString('en-IN', { weekday: 'short' })}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="font-semibold">{h.name}</div>
                          {h.description && (
                            <div className="t-mute text-xs mt-0.5">{h.description}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5" style={{ width: 110 }}>
                          <Pill tone={TYPE_TONE[h.type] ?? ''}>{h.type}</Pill>
                        </td>
                        <td className="px-4 py-2.5 t-mute" style={{ width: 180 }}>
                          {h.locationName ?? 'All locations'}
                          {h.isRecurring ? ' · yearly' : ''}
                        </td>
                        <td className="px-4 py-2.5" style={{ width: 90, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            className="icon-btn"
                            title="Edit"
                            onClick={() => setEditing(h)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', padding: 4 }}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            className="icon-btn"
                            title="Delete"
                            onClick={() => handleDelete(h)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--coral, #f87171)', padding: 4 }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {(addOpen || editing) && (
        <HolidayDialog
          holiday={editing}
          locations={locations}
          onClose={() => { setAddOpen(false); setEditing(null) }}
          onSave={async (payload) => {
            if (editing) {
              await update.mutateAsync({ id: editing.id, ...payload })
              toast({ title: 'Holiday updated', description: payload.name })
            } else {
              await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0])
              toast({ title: 'Holiday added', description: payload.name })
            }
          }}
          pending={create.isPending || update.isPending}
        />
      )}

      {importOpen && (
        <ImportDialog
          locations={locations}
          defaultYear={PRESET_YEARS.includes(year) ? year : PRESET_YEARS[0]!}
          onClose={() => setImportOpen(false)}
        />
      )}
    </SettingsLayout>
  )
}

// ─── Add / edit dialog ───────────────────────────────────────────────────────

function HolidayDialog({
  holiday,
  locations,
  onClose,
  onSave,
  pending,
}: {
  holiday: Holiday | null
  locations: Array<{ id: string; name: string; city: string | null }>
  onClose: () => void
  onSave: (payload: {
    date: string
    name: string
    type: string
    description?: string
    locationId?: string | null
    isRecurring?: boolean
  }) => Promise<void>
  pending: boolean
}) {
  const { toast } = useToast()
  const [date, setDate] = useState(holiday?.date ?? '')
  const [name, setName] = useState(holiday?.name ?? '')
  const [type, setType] = useState(holiday?.type ?? 'company')
  const [description, setDescription] = useState(holiday?.description ?? '')
  const [locationId, setLocationId] = useState(holiday?.locationId ?? '')
  const [isRecurring, setIsRecurring] = useState(holiday?.isRecurring ?? false)

  const submit = async () => {
    if (!date) {
      toast({ title: 'Pick a date', variant: 'destructive' })
      return
    }
    if (!name.trim()) {
      toast({ title: 'Name is required', variant: 'destructive' })
      return
    }
    try {
      await onSave({
        date,
        name: name.trim(),
        type,
        description: description.trim() || undefined,
        // '' = company-wide. On update the server needs an explicit null to
        // clear a location; on create we just omit it.
        locationId: holiday ? (locationId || null) : (locationId || undefined),
        isRecurring,
      })
      onClose()
    } catch (err) {
      toast({
        title: 'Could not save holiday',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{holiday ? 'Edit holiday' : 'Add holiday'}</DialogTitle>
        </DialogHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>Date</label>
              <DateField value={date} onChange={setDate} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>Type</label>
              <select className="input" value={type} onChange={(e) => setType(e.target.value)} style={{ width: '100%' }}>
                {HOLIDAY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label" style={{ display: 'block', marginBottom: 6 }}>Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Diwali"
              maxLength={120}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <label className="label" style={{ display: 'block', marginBottom: 6 }}>Applies to</label>
            <select className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ width: '100%' }}>
              <option value="">All locations (company-wide)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}{l.city ? ` · ${l.city}` : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" style={{ display: 'block', marginBottom: 6 }}>Notes (optional)</label>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Date follows moon sighting…"
              maxLength={300}
              style={{ width: '100%' }}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={isRecurring}
              onChange={(e) => setIsRecurring(e.target.checked)}
            />
            Repeats every year (fixed-date holiday)
          </label>
          <p className="t-mute text-xs" style={{ margin: 0 }}>
            Optional / restricted holidays are elective — they show on calendars but
            don't reduce leave-day counts or mark attendance.
          </p>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn kind="ghost" onClick={onClose} disabled={pending}>Cancel</Btn>
          <Btn kind="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : holiday ? 'Save changes' : 'Add holiday'}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Country-preset import dialog ────────────────────────────────────────────

function ImportDialog({
  locations,
  defaultYear,
  onClose,
}: {
  locations: Array<{ id: string; name: string; city: string | null; countryCode: string }>
  defaultYear: number
  onClose: () => void
}) {
  const { toast } = useToast()
  const importMutation = useImportHolidays()
  const [country, setCountry] = useState<string>(locations[0]?.countryCode ?? 'IN')
  const [year, setYear] = useState(defaultYear)
  const [locationId, setLocationId] = useState('')
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())

  const presets = useHolidayPresets(country, year)
  const list = presets.data?.holidays ?? []
  const selected = list.filter((h) => !unchecked.has(`${h.date}|${h.name}`))

  const toggle = (key: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const submit = async () => {
    if (selected.length === 0) {
      toast({ title: 'Nothing selected', variant: 'destructive' })
      return
    }
    try {
      const res = await importMutation.mutateAsync({
        holidays: selected.map((h) => ({
          date: h.date,
          name: h.name,
          type: h.type,
          description: h.description,
        })),
        ...(locationId ? { locationId } : {}),
      })
      toast({
        title: `Imported ${res.imported} holiday${res.imported === 1 ? '' : 's'}`,
        description: res.skipped > 0 ? `${res.skipped} already existed and were skipped.` : undefined,
      })
      onClose()
    } catch (err) {
      toast({
        title: 'Import failed',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a country's holiday list</DialogTitle>
        </DialogHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 2 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>Country</label>
              <select className="input" value={country} onChange={(e) => { setCountry(e.target.value); setUnchecked(new Set()) }} style={{ width: '100%' }}>
                {PRESET_COUNTRIES.map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ display: 'block', marginBottom: 6 }}>Year</label>
              <select className="input" value={year} onChange={(e) => { setYear(Number(e.target.value)); setUnchecked(new Set()) }} style={{ width: '100%' }}>
                {PRESET_YEARS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label" style={{ display: 'block', marginBottom: 6 }}>Assign to</label>
            <select className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ width: '100%' }}>
              <option value="">All locations (company-wide)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}{l.city ? ` · ${l.city}` : ''}</option>
              ))}
            </select>
            <p className="t-mute text-xs mt-1.5" style={{ margin: 0 }}>
              With offices in several countries, import each country's list assigned to
              that office's location — employees only get the holidays of their location.
            </p>
          </div>

          {presets.isLoading ? (
            <div style={{ padding: 20, textAlign: 'center' }}>
              <Loader2 className="w-5 h-5 animate-spin text-brand-muted" style={{ margin: '0 auto' }} />
            </div>
          ) : list.length === 0 ? (
            <p className="t-mute text-sm" style={{ margin: 0 }}>
              No preset list for this country/year yet — add holidays manually instead.
            </p>
          ) : (
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--bord)', borderRadius: 9 }}>
              {list.map((h) => {
                const key = `${h.date}|${h.name}`
                const checked = !unchecked.has(key)
                return (
                  <label
                    key={key}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px', cursor: 'pointer',
                      borderBottom: '1px solid var(--bord)',
                      opacity: checked ? 1 : 0.5,
                    }}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggle(key)} />
                    <span className="font-mono text-xs" style={{ width: 84 }}>{h.date}</span>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{h.name}</span>
                    <Pill tone={TYPE_TONE[h.type] ?? ''}>{h.type}</Pill>
                  </label>
                )
              })}
            </div>
          )}
          <p className="t-mute text-xs" style={{ margin: 0 }}>
            Festival dates that follow moon sighting are estimates — verify them close to
            the date. Everything stays editable after import.
          </p>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn kind="ghost" onClick={onClose} disabled={importMutation.isPending}>Cancel</Btn>
          <Btn kind="primary" onClick={submit} disabled={importMutation.isPending || selected.length === 0}>
            {importMutation.isPending ? 'Importing…' : `Import ${selected.length} holiday${selected.length === 1 ? '' : 's'}`}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
