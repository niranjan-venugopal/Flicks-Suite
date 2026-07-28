'use client'

import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Btn,
  Icon,
  Pill,
  type PillTone,
  SectionHead,
} from '@/components/proto'
import {
  useApplyLeave,
  useCancelLeave,
  useHolidays,
  useLeaveTypes,
  useMyLeaveBalances,
  useMyLeaveRequests,
  type ApplyLeavePayload,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
} from '@/lib/api/queries/use-leave'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DateRangeField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import type { IconKey } from '@/components/proto'

// ─── Helpers ───────────────────────────────────────────────────────────────

const TYPE_ACCENT: Record<string, { color: string; icon: IconKey }> = {
  CL: { color: '#3E7BFA', icon: 'cal' },
  SL: { color: '#F8786B', icon: 'warn' },
  PL: { color: '#9B7BFA', icon: 'spark' },
  EL: { color: '#9B7BFA', icon: 'spark' },
  ML: { color: '#F8786B', icon: 'warn' },
  CO: { color: '#27D280', icon: 'refresh' },
  WFH: { color: '#3E7BFA', icon: 'home' },
  LOP: { color: '#F8786B', icon: 'warn' },
  BL: { color: '#9B7BFA', icon: 'briefcase' },
  RH: { color: '#FED800', icon: 'flag' },
  MR: { color: '#27D280', icon: 'check' },
}

function accentFor(code: string): { color: string; icon: IconKey } {
  return TYPE_ACCENT[code] ?? { color: '#3E7BFA', icon: 'cal' }
}

function statusPill(s: LeaveRequest['status']) {
  // key + pm-pop: when the status flips (poll/refetch) the chip morphs in
  // place with the 140ms pop instead of swapping silently (catalog).
  switch (s) {
    case 'approved':  return <span key="approved" className="pm-pop" style={{ display: 'inline-flex' }}><Pill tone="green" dot>Approved</Pill></span>
    case 'pending':   return <Pill tone="yellow" dot>Pending</Pill>
    case 'rejected':  return <span key="rejected" className="pm-pop" style={{ display: 'inline-flex' }}><Pill tone="coral" dot>Rejected</Pill></span>
    case 'cancelled': return <Pill>Cancelled</Pill>
    case 'revoked':   return <Pill tone="coral">Revoked</Pill>
    case 'draft':     return <Pill>Draft</Pill>
    default:          return <Pill>{s}</Pill>
  }
}

function typePill(code: string | null | undefined) {
  if (!code) return <Pill>—</Pill>
  const tone: PillTone =
    code === 'CL' ? 'blue' :
    code === 'SL' || code === 'ML' || code === 'LOP' ? 'coral' :
    code === 'CO' || code === 'MR' ? 'green' :
    code === 'RH' ? 'yellow' :
    'purple'
  return <Pill tone={tone}>{code}</Pill>
}

function fmtRange(start: string, end: string): string {
  if (start === end) return new Date(`${start}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  const s = new Date(`${start}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  const e = new Date(`${end}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  return `${s} – ${e}`
}

function extractCode(typeName: string | null): string {
  if (!typeName) return ''
  const m = typeName.match(/^([A-Z]{2,4})\b/)
  if (m) return m[1]!
  return typeName.split(/\s+/).map((w) => w[0]?.toUpperCase() ?? '').join('').slice(0, 3)
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function LeavePage() {
  const [applyOpen, setApplyOpen] = useState(false)
  const balancesQ = useMyLeaveBalances()
  const myReqs = useMyLeaveRequests()
  const holidays = useHolidays()
  const cancel = useCancelLeave()
  const { toast } = useToast()
  const withdraw = async (id: string) => {
    try {
      await cancel.mutateAsync({ id })
      toast({ title: 'Request withdrawn' })
    } catch (e) {
      toast({ title: 'Could not withdraw', description: e instanceof Error ? e.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Leave"
          sub="Your balance, history, and upcoming time off"
          right={
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setApplyOpen(true)}>
              Apply for leave
            </Btn>
          }
        />

        {/* Balance cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 14,
            marginBottom: 18,
          }}
        >
          {balancesQ.isLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card" style={{ padding: 18, minHeight: 130, opacity: 0.5 }}>
                  <div className="t-caption">Loading…</div>
                </div>
              ))
            : (balancesQ.data?.balances ?? []).slice(0, 4).map((b) => (
                <BalanceCard key={b.leaveTypeId} balance={b} />
              ))}
        </div>

        {/* History + holidays */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18 }}>
          <div className="card">
            <SectionHead title="My leave history" right={<Btn kind="ghost" size="sm">{new Date().getFullYear()}</Btn>} />
            {myReqs.isLoading ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-mute)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Loader2 className="w-4 h-4 animate-spin" /> Loading history…
              </div>
            ) : !myReqs.data || myReqs.data.data.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-mute)', fontSize: 13, fontWeight: 600 }}>
                No leave requests yet. Use Apply for leave to submit one.
              </div>
            ) : (
              <HistoryTable rows={myReqs.data.data} onWithdraw={withdraw} />
            )}
          </div>

          <div className="card">
            <SectionHead
              title="Holiday calendar"
              sub={new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
            />
            <HolidayList holidays={holidays.data?.holidays ?? []} loading={holidays.isLoading} />
          </div>
        </div>
      </div>

      <ApplyLeaveDialog open={applyOpen} onOpenChange={setApplyOpen} />
    </div>
  )
}

// ─── Balance card ──────────────────────────────────────────────────────────

function BalanceCard({ balance: b }: { balance: LeaveBalance }) {
  const total = b.opening + b.accrued
  const used = b.used + b.pending
  const usagePct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const accent = accentFor(b.code)
  const IconCmp = Icon[accent.icon]

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div className="t-caption">{b.leaveTypeName}</div>
        <div
          style={{
            width: 30, height: 30, borderRadius: 8,
            background: accent.color + '22', color: accent.color,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <IconCmp size={14} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 }}>
        <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.03em' }}>
          {b.available.toFixed(b.available % 1 === 0 ? 0 : 1)}
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-mute)' }}>
          / {total.toFixed(total % 1 === 0 ? 0 : 1)} days
        </div>
      </div>
      <div className="progress" style={{ marginBottom: 8 }}>
        <div style={{ width: `${usagePct}%`, background: accent.color }} />
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
        {b.used} used{b.pending > 0 ? ` · ${b.pending} pending` : ''}
      </div>
    </div>
  )
}

// ─── History table ─────────────────────────────────────────────────────────

function HistoryTable({ rows, onWithdraw }: { rows: LeaveRequest[]; onWithdraw: (id: string) => void }) {
  return (
    <table className="tbl" style={{ width: '100%' }}>
      <thead>
        <tr>
          <th>Type</th>
          <th>Dates</th>
          <th>Days</th>
          <th>Status</th>
          <th>Reason</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="pm-row">
            <td>{typePill(extractCode(r.leaveTypeName))}</td>
            <td>{fmtRange(r.startDate, r.endDate)}</td>
            <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 800 }}>{r.totalDays}</td>
            <td>{statusPill(r.status)}</td>
            <td style={{ color: 'var(--text-2)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.reason ?? '—'}
            </td>
            <td style={{ textAlign: 'right' }}>
              {r.status === 'pending' && (
                <button
                  type="button"
                  className="pm-row-acts"
                  onClick={() => onWithdraw(r.id)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-mute)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}
                >
                  Withdraw
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─── Holiday list ──────────────────────────────────────────────────────────

function HolidayList({
  holidays,
  loading,
}: {
  holidays: Array<{ id: string; date: string; name: string; type: string; description: string | null }>
  loading: boolean
}) {
  const upcoming = useMemo(() => {
    const todayMs = new Date().setHours(0, 0, 0, 0)
    return [...holidays]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((h) => ({ ...h, isPast: new Date(`${h.date}T00:00:00`).getTime() < todayMs }))
      .slice(0, 8)
  }, [holidays])

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-mute)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <Loader2 className="w-4 h-4 animate-spin" /> Loading holidays…
      </div>
    )
  }
  if (upcoming.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-mute)', fontSize: 13, fontWeight: 600 }}>
        No holidays configured.
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {upcoming.map((h) => {
        const dt = new Date(`${h.date}T00:00:00`)
        const day = dt.getDate().toString().padStart(2, '0')
        const month = dt.toLocaleDateString('en-IN', { month: 'short' })
        return (
          <div
            key={h.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 12px', background: 'var(--surf-1)',
              border: '1px solid var(--bord)', borderRadius: 9,
              opacity: h.isPast ? 0.55 : 1,
            }}
          >
            <div
              style={{
                width: 42, textAlign: 'center', padding: '4px 0',
                background: 'var(--surf-2)', borderRadius: 8,
                border: '1px solid var(--bord-2)',
              }}
            >
              <div style={{ fontSize: 9, fontWeight: 800, color: 'var(--text-mute)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                {month}
              </div>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>{day}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {h.name}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                {h.description ?? h.type}
              </div>
            </div>
            {h.type === 'optional' && <Pill tone="yellow">Optional</Pill>}
          </div>
        )
      })}
    </div>
  )
}

// ─── Apply leave dialog ────────────────────────────────────────────────────

function ApplyLeaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const types = useLeaveTypes()
  const balances = useMyLeaveBalances()
  const apply = useApplyLeave()
  const { toast } = useToast()

  const [leaveTypeId, setLeaveTypeId] = useState<string | null>(null)
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10))
  const [isHalfDay, setIsHalfDay] = useState(false)
  const [reason, setReason] = useState('')

  const allTypes = types.data?.data ?? []
  const balanceByType = useMemo(() => {
    const m = new Map<string, LeaveBalance>()
    for (const b of balances.data?.balances ?? []) m.set(b.leaveTypeId, b)
    return m
  }, [balances.data])

  const totalDays = useMemo(() => {
    if (!startDate || !endDate) return 0
    const s = new Date(`${startDate}T00:00:00`).getTime()
    const e = new Date(`${endDate}T00:00:00`).getTime()
    if (e < s) return 0
    return Math.round((e - s) / 86_400_000) + 1 - (isHalfDay ? 0.5 : 0)
  }, [startDate, endDate, isHalfDay])

  const selectedType = allTypes.find((t) => t.id === leaveTypeId)
  const selectedBalance = leaveTypeId ? balanceByType.get(leaveTypeId) : undefined

  const reset = () => {
    setLeaveTypeId(null)
    setStartDate(new Date().toISOString().slice(0, 10))
    setEndDate(new Date().toISOString().slice(0, 10))
    setIsHalfDay(false)
    setReason('')
  }

  const handleSubmit = async () => {
    if (!leaveTypeId) {
      toast({ title: 'Pick a leave type', variant: 'destructive' })
      return
    }
    if (reason.trim().length < 5) {
      toast({ title: 'Reason is required', description: 'At least 5 characters.', variant: 'destructive' })
      return
    }
    const payload: ApplyLeavePayload = { leaveTypeId, startDate, endDate, isHalfDay, reason }
    try {
      await apply.mutateAsync(payload)
      toast({ title: 'Leave submitted', description: 'Your manager will see it in their approvals inbox.' })
      reset()
      onOpenChange(false)
    } catch (e) {
      toast({
        title: 'Could not submit',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Apply for leave</DialogTitle>
        </DialogHeader>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="label">Leave type</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {allTypes.slice(0, 8).map((t: LeaveType) => {
                const active = leaveTypeId === t.id
                const bal = balanceByType.get(t.id)
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setLeaveTypeId(t.id)}
                    style={{
                      padding: '10px 8px', borderRadius: 9,
                      background: active ? 'var(--surf-3)' : 'var(--surf-1)',
                      border: `1.5px solid ${active ? 'var(--blue)' : 'var(--bord)'}`,
                      cursor: 'pointer', textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em' }}>
                      {t.code}
                    </div>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                      {bal ? `${bal.available} left` : '—'}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <div className="label">Dates</div>
            <DateRangeField
              start={startDate}
              end={endDate}
              onChange={(r) => {
                setStartDate(r.start)
                setEndDate(r.end)
              }}
            />
          </div>

          <div
            style={{
              display: 'flex', gap: 14,
              padding: '10px 14px', background: 'var(--surf-1)',
              border: '1px solid var(--bord)', borderRadius: 9,
              fontSize: 12, fontWeight: 600,
            }}
          >
            <span>{totalDays} {totalDays === 1 ? 'day' : 'days'}</span>
            <span style={{ color: 'var(--text-faint)' }}>·</span>
            <span>
              {selectedBalance
                ? `${selectedBalance.available} ${selectedType?.code} → ${Math.max(0, selectedBalance.available - totalDays)} ${selectedType?.code} after`
                : 'Pick a leave type to preview balance'}
            </span>
            <div style={{ flex: 1 }} />
            {(selectedType?.allowHalfDay ?? true) && totalDays <= 1 && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-2)' }}>
                <input
                  type="checkbox"
                  checked={isHalfDay}
                  onChange={(e) => setIsHalfDay(e.target.checked)}
                  style={{ accentColor: 'var(--blue)' }}
                />
                Half day
              </label>
            )}
          </div>

          <div>
            <div className="label">Reason</div>
            <textarea
              className="input"
              style={{ height: 80, padding: 12, resize: 'none' }}
              placeholder="Why are you taking this leave?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
          <Btn kind="ghost" onClick={() => onOpenChange(false)} disabled={apply.isPending}>
            Cancel
          </Btn>
          <div style={{ flex: 1 }} />
          <Btn
            kind="primary"
            icon={<Icon.send size={14} />}
            onClick={handleSubmit}
            disabled={apply.isPending || !leaveTypeId || totalDays <= 0}
          >
            {apply.isPending ? 'Submitting…' : 'Submit to manager'}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
