'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import { api } from '@/lib/api/client'
import {
  useMyCurrentTimesheet,
  useSubmitTimesheet,
  useSaveTimesheetEntries,
  useTimesheetEntries,
  usePreviousWeekCategories,
  type TimesheetPeriod,
} from '@/lib/api/queries/use-timesheets'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Must mirror the DB `timesheet_entry_category` enum and the API DTO
// (apps/api/src/modules/timesheet/timesheet.dto.ts).
const CATEGORY_OPTIONS: ReadonlyArray<{ value: string; label: string; billable: boolean }> = [
  { value: 'development',   label: 'Development',          billable: true  },
  { value: 'design',        label: 'Design',               billable: true  },
  { value: 'testing',       label: 'Testing / QA',         billable: true  },
  { value: 'research',      label: 'Research',             billable: true  },
  { value: 'support',       label: 'Customer support',     billable: true  },
  { value: 'documentation', label: 'Documentation',        billable: false },
  { value: 'meetings',      label: 'Meetings',             billable: false },
  { value: 'management',    label: 'Management',           billable: false },
  { value: 'training',      label: 'Training / learning',  billable: false },
  { value: 'admin',         label: 'Admin / internal ops', billable: false },
  { value: 'other',         label: 'Other',                billable: false },
]
const CATEGORY_DEFAULTS = ['development', 'meetings', 'documentation', 'other'] as const
const isBillableCategory = (value: string) =>
  CATEGORY_OPTIONS.find((c) => c.value === value)?.billable ?? false

interface RowState {
  category: string
  projectId: string | null // §15.3 — PM project the hours count against
  taskId: string | null //          and optionally a specific issue
  hours: number[] // index 0=Mon ... 6=Sun
}

// ─── PM linkage (§15.3): self-gating — when the PM module is off (or the
// user has no access) the projects query 403s and the pickers never render.
function usePmProjectOptions() {
  return useQuery({
    queryKey: ['pm', 'projects', 'timesheet-picker'],
    queryFn: () =>
      api.get<{ data: { projects: Array<{ id: string; name: string; status: string }> } }>(
        '/api/v1/pm/projects',
      ),
    retry: false,
    staleTime: 300_000,
  })
}

function TaskSelect({
  projectId,
  taskId,
  disabled,
  onChange,
}: {
  projectId: string
  taskId: string | null
  disabled: boolean
  onChange: (taskId: string | null) => void
}) {
  const issues = useQuery({
    queryKey: ['pm', 'issues', 'timesheet-picker', projectId],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; title: string; number: number }> }>(
        `/api/v1/pm/issues?project_id=${projectId}&limit=200`,
      ),
    retry: false,
    staleTime: 120_000,
  })
  const list = issues.data?.data ?? []
  return (
    <select
      className="input"
      value={taskId ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      style={{ height: 28, fontSize: 11, fontWeight: 700, padding: '0 8px', color: taskId ? undefined : 'var(--text-mute)' }}
    >
      <option value="">No task</option>
      {taskId && !list.some((i) => i.id === taskId) ? <option value={taskId}>Linked task</option> : null}
      {list.map((i) => (
        <option key={i.id} value={i.id}>{i.title}</option>
      ))}
    </select>
  )
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
  const copyPrevious = usePreviousWeekCategories()
  const role = useAuthStore((s) => s.currentUser?.role)
  const pmProjects = usePmProjectOptions()
  const pmProjectRows = useMemo(
    () => (pmProjects.data?.data?.projects ?? []).filter((p) => p.status !== 'completed' && p.status !== 'canceled'),
    [pmProjects.data],
  )
  const pmOn = pmProjectRows.length > 0
  // Categories are workspace-level; per PRD §8 only admins curate them. Employees
  // pick from what's already configured but cannot add new rows themselves.
  const canManageCategories =
    role === 'OWNER' || role === 'HR_ADMIN' || role === 'MANAGER' || role === 'FAM'

  // Build week days based on the API's period if present, else current week.
  const weekStart = useMemo(() => {
    if (current.data?.periodStart) {
      const d = new Date(`${current.data.periodStart}T00:00:00`)
      // The server's period_start IS the week start (per the tenant's
      // week-starts-on setting) — never re-snap it to Monday here.
      if (!isNaN(d.getTime())) return d
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
    // One grid row per (category, project, task) combination (§15.3).
    const byKey = new Map<string, RowState>()
    for (const e of entries.data.entries) {
      const key = `${e.category}|${e.projectId ?? ''}|${e.taskId ?? ''}`
      if (!byKey.has(key)) {
        byKey.set(key, {
          category: e.category,
          projectId: e.projectId ?? null,
          taskId: e.taskId ?? null,
          hours: Array(7).fill(0),
        })
      }
      const idx = weekDays.findIndex((d) => toISO(d) === e.entryDate)
      if (idx >= 0) byKey.get(key)!.hours[idx] = e.hours
    }
    const next: RowState[] = [...byKey.values()]
    const usedCategories = new Set(next.map((r) => r.category))
    for (const c of CATEGORY_DEFAULTS) {
      if (next.length >= CATEGORY_DEFAULTS.length) break
      if (!usedCategories.has(c)) next.push({ category: c, projectId: null, taskId: null, hours: Array(7).fill(0) })
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
  const updateProject = (rowIdx: number, projectId: string | null) => {
    // Changing project clears the task — tasks belong to a project.
    setRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, projectId, taskId: null } : r)))
  }
  const updateTask = (rowIdx: number, taskId: string | null) => {
    setRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, taskId } : r)))
  }
  const addRow = () => {
    if (!canManageCategories) return
    const used = new Set(rows.map((r) => r.category))
    const next = CATEGORY_OPTIONS.find((c) => !used.has(c.value))?.value ?? 'other'
    setRows((prev) => [...prev, { category: next, projectId: null, taskId: null, hours: Array(7).fill(0) }])
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
                  isBillable: isBillableCategory(r.category),
                  ...(r.projectId ? { projectId: r.projectId } : {}),
                  ...(r.taskId ? { taskId: r.taskId } : {}),
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
  const handleCopyLastWeek = async () => {
    try {
      const { categories } = await copyPrevious.mutateAsync()
      if (categories.length === 0) {
        toast({
          title: 'Nothing to copy',
          description: 'No categories were logged last week.',
        })
        return
      }
      // Bring forward last week's category rows with empty hours (PRD §8.3 —
      // structure, not hours). Keep existing rows; append missing categories.
      setRows((prev) => {
        const have = new Set(prev.map((r) => r.category))
        const added = categories
          .filter((c) => !have.has(c))
          .map((category) => ({ category, projectId: null, taskId: null, hours: Array(7).fill(0) as number[] }))
        return [...prev, ...added]
      })
      toast({ title: 'Copied last week', description: `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} brought forward.` })
    } catch (e) {
      toast({
        title: 'Could not copy',
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
              <Btn
                kind="secondary"
                size="sm"
                icon={<Icon.copy size={13} />}
                disabled={!isEditable || copyPrevious.isPending}
                onClick={handleCopyLastWeek}
              >
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

        {current.data?.latestReworkComment && status === 'draft' && (
          <ReviewBanner
            tone="coral"
            title="Your manager sent this back for changes"
            comment={current.data.latestReworkComment}
            when={current.data.latestReworkAt}
            hint="Update the entries below and resubmit when you're done."
          />
        )}
        {status === 'rejected' && current.data?.rejectionComment && (
          <ReviewBanner
            tone="coral"
            title="This week was rejected"
            comment={current.data.rejectionComment}
            when={current.data.rejectedAt}
            hint="Talk to your manager if you need to reopen it."
          />
        )}

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
              .filter((r) => isBillableCategory(r.category))
              .reduce((s, r) => s + r.hours.reduce((a, b) => a + b, 0), 0)
              .toFixed(1)}h`}
            delta={
              weekTotal > 0
                ? `${Math.round(
                    (rows
                      .filter((r) => isBillableCategory(r.category))
                      .reduce((s, r) => s + r.hours.reduce((a, b) => a + b, 0), 0) /
                      weekTotal) *
                      100,
                  )}%`
                : '—'
            }
            icon={<Icon.tag size={14} />}
            accent="green"
          />
          <Kpi
            label="Status"
            value={
              current.data?.latestReworkComment && status === 'draft'
                ? 'Needs rework'
                : status.replace('_', ' ')
            }
            delta={
              current.data?.latestReworkComment && status === 'draft'
                ? 'See manager note above'
                : status === 'draft'
                  ? 'Submit by Mon 11am'
                  : undefined
            }
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
                  const billable = isBillableCategory(r.category)
                  return (
                    <tr key={ri}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div
                            style={{
                              width: 6,
                              height: pmOn ? 56 : 24,
                              borderRadius: 3,
                              background: billable ? 'var(--blue)' : 'var(--purple)',
                            }}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                            <select
                              className="input"
                              value={r.category}
                              onChange={(e) => updateCategory(ri, e.target.value)}
                              style={{ height: 34, fontSize: 12.5, fontWeight: 800, padding: '0 10px' }}
                              disabled={!isEditable}
                            >
                              {CATEGORY_OPTIONS.find((c) => c.value === r.category) ? null : (
                                <option value={r.category}>{r.category}</option>
                              )}
                              {CATEGORY_OPTIONS.map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.label}
                                  {c.billable ? ' · billable' : ''}
                                </option>
                              ))}
                            </select>
                            {pmOn && (
                              <div style={{ display: 'flex', gap: 4 }}>
                                <select
                                  className="input"
                                  value={r.projectId ?? ''}
                                  onChange={(e) => updateProject(ri, e.target.value || null)}
                                  disabled={!isEditable}
                                  style={{ height: 28, fontSize: 11, fontWeight: 700, padding: '0 8px', flex: 1, minWidth: 0, color: r.projectId ? undefined : 'var(--text-mute)' }}
                                >
                                  <option value="">No project</option>
                                  {pmProjectRows.map((p) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                  ))}
                                </select>
                                {r.projectId && (
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <TaskSelect
                                      projectId={r.projectId}
                                      taskId={r.taskId}
                                      disabled={!isEditable}
                                      onChange={(t) => updateTask(ri, t)}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
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
                {isEditable && canManageCategories && (
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
                      + Add category row
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

      </div>
    </div>
  )
}

function ReviewBanner({
  tone,
  title,
  comment,
  when,
  hint,
}: {
  tone: 'coral' | 'yellow'
  title: string
  comment: string
  when?: string | null
  hint?: string
}) {
  const palette =
    tone === 'coral'
      ? { bg: 'rgba(248,120,107,.08)', border: 'rgba(248,120,107,.35)', accent: 'var(--coral)' }
      : { bg: 'rgba(254,216,0,.08)', border: 'rgba(254,216,0,.35)', accent: 'var(--yellow)' }
  const whenLabel = when
    ? new Date(when).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : null
  return (
    <div
      style={{
        marginBottom: 18,
        padding: '14px 16px',
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderLeft: `4px solid ${palette.accent}`,
        borderRadius: 10,
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
      }}
    >
      <Icon.warn size={18} style={{ color: palette.accent, flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-1)' }}>
          {title}
          {whenLabel && (
            <span style={{ fontWeight: 600, color: 'var(--text-mute)', marginLeft: 8 }}>
              · {whenLabel}
            </span>
          )}
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text-2)',
            whiteSpace: 'pre-wrap',
          }}
        >
          “{comment}”
        </div>
        {hint && (
          <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
            {hint}
          </div>
        )}
      </div>
    </div>
  )
}
