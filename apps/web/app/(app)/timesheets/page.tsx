'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import {
  useMyCurrentTimesheet,
  useSubmitTimesheet,
  useSaveTimesheetEntries,
  useTimesheetEntries,
  type TimesheetPeriod,
} from '@/lib/api/queries/use-timesheets'
import { useToast } from '@/components/ui/use-toast'

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DEFAULT_CATEGORIES = ['Project work', 'Internal', 'Customer support', 'Onboarding']

interface RowState {
  category: string
  hours: number[] // index 0=Mon ... 6=Sun
}

function startOfWeekMon(d = new Date()): Date {
  const x = new Date(d)
  const dow = (x.getDay() + 6) % 7 // Mon=0
  x.setDate(x.getDate() - dow)
  x.setHours(0, 0, 0, 0)
  return x
}
function fmtDayHeader(d: Date): { name: string; date: string } {
  return {
    name: d.toLocaleDateString('en-IN', { weekday: 'short' }),
    date: d.toLocaleDateString('en-IN', { day: 'numeric' }),
  }
}
function statusPill(s: TimesheetPeriod['status']) {
  switch (s) {
    case 'draft':            return <Pill tone="yellow" dot>Draft</Pill>
    case 'submitted':        return <Pill tone="blue" dot>Submitted</Pill>
    case 'approved':         return <Pill tone="green" dot>Approved</Pill>
    case 'rejected':         return <Pill tone="coral" dot>Rejected</Pill>
    case 'rework_requested': return <Pill tone="coral" dot>Needs rework</Pill>
    default:                 return <Pill>{s}</Pill>
  }
}
function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export default function TimesheetsPage() {
  const { toast } = useToast()
  const current = useMyCurrentTimesheet()
  const entries = useTimesheetEntries(current.data?.id || null)
  const saveEntries = useSaveTimesheetEntries()
  const submit = useSubmitTimesheet()

  // Build week days based on the API's period if present, else current week.
  const weekStart = useMemo(() => {
    if (current.data?.periodStart) {
      const d = new Date(`${current.data.periodStart}T00:00:00`)
      if (!isNaN(d.getTime())) return startOfWeekMon(d)
    }
    return startOfWeekMon()
  }, [current.data?.periodStart])
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart)
      d.setDate(weekStart.getDate() + i)
      return d
    }),
    [weekStart],
  )

  // Local editable grid state. Seeded from API entries if present, else 4 empty rows.
  const [rows, setRows] = useState<RowState[]>([])

  useEffect(() => {
    if (!entries.data) return
    const byCategory = new Map<string, number[]>()
    for (const e of entries.data.entries) {
      if (!byCategory.has(e.category)) byCategory.set(e.category, Array(7).fill(0))
      const arr = byCategory.get(e.category)!
      const idx = weekDays.findIndex((d) => toISO(d) === e.entryDate)
      if (idx >= 0) arr[idx] = e.hours
    }
    const next: RowState[] = []
    for (const [category, hours] of byCategory) next.push({ category, hours })
    while (next.length < DEFAULT_CATEGORIES.length) {
      const c = DEFAULT_CATEGORIES[next.length]!
      if (!byCategory.has(c)) next.push({ category: c, hours: Array(7).fill(0) })
      else break
    }
    setRows(next)
  }, [entries.data, weekDays])

  const dayTotals = weekDays.map((_, i) => rows.reduce((s, r) => s + (r.hours[i] ?? 0), 0))
  const weekTotal = dayTotals.reduce((a, b) => a + b, 0)
  const status = current.data?.status ?? 'draft'
  const isEditable = status === 'draft' || status === 'rework_requested'

  const updateHours = (rowIdx: number, dayIdx: number, raw: string) => {
    const n = Math.max(0, Math.min(24, parseFloat(raw) || 0))
    setRows((prev) =>
      prev.map((r, i) =>
        i !== rowIdx ? r : { ...r, hours: r.hours.map((h, j) => (j === dayIdx ? n : h)) },
      ),
    )
  }
  const updateCategory = (rowIdx: number, name: string) => {
    setRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, category: name } : r)))
  }
  const addRow = () => {
    setRows((prev) => [...prev, { category: 'New category', hours: Array(7).fill(0) }])
  }

  const handleSave = async () => {
    if (!current.data?.id) return
    const payload = {
      timesheetPeriodId: current.data.id,
      entries: rows.flatMap((r) =>
        r.hours.flatMap((h, i) =>
          h > 0
            ? [
                {
                  entryDate: toISO(weekDays[i]!),
                  hours: h,
                  category: r.category,
                  isBillable: r.category.toLowerCase().includes('project'),
                },
              ]
            : [],
        ),
      ),
    }
    try {
      await saveEntries.mutateAsync(payload)
      toast({ title: 'Saved', description: `${payload.entries.length} entries saved.` })
    } catch (e) {
      toast({
        title: 'Could not save',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }
  const handleSubmit = async () => {
    if (!current.data?.id) return
    await handleSave()
    try {
      await submit.mutateAsync(current.data.id)
      toast({ title: 'Week submitted', description: 'Sent to your manager for approval.' })
    } catch (e) {
      toast({
        title: 'Could not submit',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="My timesheet"
          sub={`Week of ${weekDays[0]?.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${weekDays[6]?.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="ghost" size="sm" icon={<Icon.chevL size={12} />} />
              <Btn kind="ghost" size="sm" icon={<Icon.chevR size={12} />} />
              <Btn kind="secondary" size="sm" icon={<Icon.copy size={13} />} disabled={!isEditable}>
                Copy last week
              </Btn>
              <Btn
                kind="primary"
                size="sm"
                icon={<Icon.send size={13} />}
                onClick={handleSubmit}
                disabled={!isEditable || !current.data?.id || submit.isPending}
              >
                {submit.isPending ? 'Submitting…' : 'Submit week'}
              </Btn>
            </div>
          }
        />

        {/* KPIs */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 14,
            marginBottom: 18,
          }}
        >
          <Kpi
            label="Logged this week"
            value={`${weekTotal.toFixed(1)}h`}
            delta="of 40h target"
            trend={weekTotal >= 40 ? 'up' : 'down'}
            icon={<Icon.clock size={14} />}
            accent="blue"
          />
          <Kpi
            label="Billable"
            value={`${rows
              .filter((r) => r.category.toLowerCase().includes('project'))
              .reduce((s, r) => s + r.hours.reduce((a, b) => a + b, 0), 0)
              .toFixed(1)}h`}
            delta={
              weekTotal > 0
                ? `${Math.round((rows.filter((r) => r.category.toLowerCase().includes('project')).reduce((s, r) => s + r.hours.reduce((a, b) => a + b, 0), 0) / weekTotal) * 100)}%`
                : '—'
            }
            icon={<Icon.tag size={14} />}
            accent="green"
          />
          <Kpi
            label="Status"
            value={status.replace('_', ' ')}
            delta={status === 'draft' ? 'Submit by Mon 11am' : undefined}
            icon={<Icon.spark size={14} />}
            accent="yellow"
          />
          <Kpi
            label="Saving"
            value={saveEntries.isPending ? '…' : 'Idle'}
            delta="Auto on submit"
            icon={<Icon.chart size={14} />}
            accent="purple"
          />
        </div>

        {/* Grid */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {current.isLoading ? (
            <div
              style={{
                padding: 48,
                textAlign: 'center',
                color: 'var(--text-mute)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <Loader2 className="w-4 h-4 animate-spin" /> Loading timesheet…
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr style={{ background: 'var(--surf-1)' }}>
                  <th style={{ width: 280 }}>Category</th>
                  {weekDays.map((d, i) => {
                    const h = fmtDayHeader(d)
                    const isToday = toISO(d) === toISO(new Date())
                    return (
                      <th key={i} style={{ textAlign: 'center', minWidth: 78 }}>
                        <div style={{ fontSize: 9 }}>{h.name}</div>
                        <div
                          style={{
                            fontSize: 13,
                            color: isToday ? '#fff' : 'var(--text-2)',
                            marginTop: 2,
                            fontWeight: 800,
                          }}
                        >
                          {h.date}
                        </div>
                      </th>
                    )
                  })}
                  <th style={{ textAlign: 'right', width: 80 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => {
                  const rowTotal = r.hours.reduce((a, b) => a + b, 0)
                  const billable = r.category.toLowerCase().includes('project')
                  return (
                    <tr key={ri}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div
                            style={{
                              width: 6,
                              height: 24,
                              borderRadius: 3,
                              background: billable ? 'var(--blue)' : 'var(--purple)',
                            }}
                          />
                          <input
                            className="input"
                            value={r.category}
                            onChange={(e) => updateCategory(ri, e.target.value)}
                            style={{ height: 34, fontSize: 12.5, fontWeight: 800, padding: '0 10px' }}
                            disabled={!isEditable}
                          />
                        </div>
                      </td>
                      {r.hours.map((h, di) => (
                        <td key={di} style={{ textAlign: 'center', padding: '8px 6px' }}>
                          <input
                            className="input"
                            value={h || ''}
                            placeholder="—"
                            onChange={(e) => updateHours(ri, di, e.target.value)}
                            disabled={!isEditable}
                            style={{
                              width: 62,
                              textAlign: 'center',
                              padding: '8px 4px',
                              height: 34,
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12.5,
                              fontWeight: 800,
                              background: h ? 'var(--surf-2)' : 'var(--surf-1)',
                              color: h ? '#fff' : 'var(--text-faint)',
                            }}
                          />
                        </td>
                      ))}
                      <td
                        style={{
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 800,
                          fontSize: 13,
                        }}
                      >
                        {rowTotal.toFixed(1)}h
                      </td>
                    </tr>
                  )
                })}
                {isEditable && (
                  <tr>
                    <td
                      onClick={addRow}
                      style={{
                        color: 'var(--blue)',
                        fontSize: 12.5,
                        fontWeight: 800,
                        cursor: 'pointer',
                      }}
                    >
                      + Add category
                    </td>
                    {weekDays.map((_, i) => <td key={i} />)}
                    <td />
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--surf-1)', borderTop: '1px solid var(--bord)' }}>
                  <td
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      color: 'var(--text-mute)',
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Day total
                  </td>
                  {dayTotals.map((t, i) => (
                    <td
                      key={i}
                      style={{
                        textAlign: 'center',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 800,
                        fontSize: 13,
                        color: t >= 8 ? 'var(--green)' : t > 0 ? '#fff' : 'var(--text-faint)',
                      }}
                    >
                      {t > 0 ? t.toFixed(1) : '—'}
                    </td>
                  ))}
                  <td
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 800,
                      fontSize: 14,
                      color: 'var(--blue)',
                    }}
                  >
                    {weekTotal.toFixed(1)}h
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <div
          style={{
            marginTop: 18,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-mute)' }}>Status:</span>
          {statusPill(status)}
          <div style={{ flex: 1 }} />
          <Btn
            kind="secondary"
            size="sm"
            onClick={handleSave}
            disabled={!isEditable || !current.data?.id || saveEntries.isPending}
          >
            {saveEntries.isPending ? 'Saving…' : 'Save draft'}
          </Btn>
        </div>

        {!current.data?.id && !current.isLoading && (
          <div
            style={{
              marginTop: 18,
              padding: '12px 14px',
              background: 'rgba(254,216,0,.06)',
              border: '1px solid rgba(254,216,0,.25)',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-2)',
            }}
          >
            ⚠ The timesheet backend currently returns an empty period. The grid renders
            so you can preview the UI, but saves won't persist until the API ships
            (PRD §8, Gate 7).
          </div>
        )}
      </div>
    </div>
  )
}
