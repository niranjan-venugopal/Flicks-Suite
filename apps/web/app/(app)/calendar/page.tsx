'use client'

import { useMemo, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  useCalendarEvents,
  useICalUrl,
  type CalendarEvent,
} from '@/lib/api/queries/use-calendar'

// ─── Helpers ───────────────────────────────────────────────────────────────

const WEEKS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function monthLabel(d: Date): string {
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}
function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}
/** Returns the Monday-anchored day-of-week index (Mon = 0, ..., Sun = 6). */
function dowMon(d: Date): number {
  return (d.getDay() + 6) % 7
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function eventToneColor(e: CalendarEvent): { hex: string; cssVar: string } {
  if (e.type === 'holiday') return { hex: '#FED800', cssVar: 'var(--yellow)' }
  if (e.type === 'my_leave') return { hex: '#3E7BFA', cssVar: 'var(--blue)' }
  return { hex: '#9B7BFA', cssVar: 'var(--purple)' } // team_leave
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const [cursor, setCursor] = useState(new Date())
  const [subscribeOpen, setSubscribeOpen] = useState(false)

  // Fetch a window covering the visible grid (6 weeks)
  const fetchRange = useMemo(() => {
    const monthStart = startOfMonth(cursor)
    const offset = dowMon(monthStart)
    const gridStart = new Date(monthStart)
    gridStart.setDate(monthStart.getDate() - offset)
    const gridEnd = new Date(gridStart)
    gridEnd.setDate(gridStart.getDate() + 41) // 6 weeks
    return { from: toISODate(gridStart), to: toISODate(gridEnd) }
  }, [cursor])

  const events = useCalendarEvents(fetchRange.from, fetchRange.to)

  // Build the 6-week grid of cells.
  const cells = useMemo(() => {
    const monthStart = startOfMonth(cursor)
    const offset = dowMon(monthStart)
    const gridStart = new Date(monthStart)
    gridStart.setDate(monthStart.getDate() - offset)
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart)
      d.setDate(gridStart.getDate() + i)
      return d
    })
  }, [cursor])

  // Bucket events by ISO date for fast lookup.
  const eventsByDate = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>()
    if (!events.data) return m
    for (const e of events.data) {
      // expand range into individual days
      const start = new Date(`${e.startDate}T00:00:00`)
      const end = new Date(`${e.endDate}T00:00:00`)
      const cur = new Date(start)
      while (cur <= end) {
        const key = toISODate(cur)
        const arr = m.get(key) ?? []
        arr.push(e)
        m.set(key, arr)
        cur.setDate(cur.getDate() + 1)
      }
    }
    return m
  }, [events.data])

  const today = new Date()
  const currentMonth = cursor.getMonth()

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Leave calendar"
          sub="Organization-wide · holidays, leaves, and team availability"
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn
                kind="secondary"
                size="sm"
                icon={<Icon.cal size={13} />}
                onClick={() => setSubscribeOpen(true)}
              >
                Subscribe (iCal)
              </Btn>
            </div>
          }
        />

        {/* Legend */}
        <div style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
          <LegendChip color="var(--yellow)" label="Holiday" />
          <LegendChip color="var(--blue)" label="My leave" />
          <LegendChip color="var(--purple)" label="Team leave" />
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Toolbar */}
          <div
            style={{
              padding: '14px 18px',
              borderBottom: '1px solid var(--bord)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Btn
              kind="ghost"
              size="sm"
              icon={<Icon.chevL size={12} />}
              onClick={() => setCursor((c) => addMonths(c, -1))}
              aria-label="Previous month"
            />
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {monthLabel(cursor)}
            </div>
            <Btn
              kind="ghost"
              size="sm"
              icon={<Icon.chevR size={12} />}
              onClick={() => setCursor((c) => addMonths(c, 1))}
              aria-label="Next month"
            />
            <div style={{ flex: 1 }} />
            <Btn kind="secondary" size="sm" onClick={() => setCursor(new Date())}>
              Today
            </Btn>
            {events.isLoading && (
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-mute)' }} />
            )}
          </div>

          {/* Weekday header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, 1fr)',
              borderBottom: '1px solid var(--bord)',
              background: 'var(--surf-1)',
            }}
          >
            {WEEKS.map((w) => (
              <div
                key={w}
                style={{
                  padding: '10px 12px',
                  fontSize: 11,
                  fontWeight: 800,
                  color: 'var(--text-mute)',
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  textAlign: 'center',
                  borderRight: '1px solid var(--bord)',
                }}
              >
                {w}
              </div>
            ))}
          </div>

          {/* Grid cells */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, 1fr)',
              gridAutoRows: 'minmax(96px, 1fr)',
            }}
          >
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === currentMonth
              const isToday = isSameDay(d, today)
              const dayEvents = eventsByDate.get(toISODate(d)) ?? []
              const hasHoliday = dayEvents.some((e) => e.type === 'holiday')

              return (
                <div
                  key={i}
                  style={{
                    padding: 8,
                    borderRight: '1px solid var(--bord)',
                    borderBottom: '1px solid var(--bord)',
                    background: inMonth ? 'transparent' : 'var(--surf-1)',
                    minHeight: 96,
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: isToday ? 800 : 700,
                        color: isToday ? '#fff' : inMonth ? 'var(--text-2)' : 'var(--text-faint)',
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: isToday ? 'var(--blue)' : 'transparent',
                      }}
                    >
                      {d.getDate()}
                    </span>
                    {hasHoliday && <Pill tone="yellow">Holiday</Pill>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {dayEvents.slice(0, 3).map((e) => {
                      const tone = eventToneColor(e)
                      return (
                        <div
                          key={`${e.id}-${i}`}
                          title={e.title}
                          style={{
                            padding: '3px 6px',
                            background: `${tone.hex}22`,
                            borderLeft: `2.5px solid ${tone.hex}`,
                            borderRadius: '0 4px 4px 0',
                            fontSize: 10.5,
                            fontWeight: 700,
                            color: tone.cssVar,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {e.title}
                        </div>
                      )
                    })}
                    {dayEvents.length > 3 && (
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          color: 'var(--text-mute)',
                          padding: '0 6px',
                        }}
                      >
                        +{dayEvents.length - 3} more
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {events.isError && (
          <div
            style={{
              marginTop: 14,
              padding: '12px 14px',
              background: 'rgba(248,120,107,.06)',
              border: '1px solid rgba(248,120,107,.25)',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--coral)',
            }}
          >
            Could not load calendar events. The shell still renders so you can navigate;
            refresh to retry.
          </div>
        )}
      </div>

      <SubscribeDialog open={subscribeOpen} onOpenChange={setSubscribeOpen} />
    </div>
  )
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
      {label}
    </div>
  )
}

// ─── Subscribe dialog ──────────────────────────────────────────────────────

function SubscribeDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const ical = useICalUrl()
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!ical.data?.url) return
    try {
      await navigator.clipboard.writeText(ical.data.url)
      setCopied(true)
      toast({ title: 'Copied', description: 'iCal URL on clipboard.' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ title: 'Could not copy', variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subscribe in Google Calendar / Apple Calendar</DialogTitle>
          <DialogDescription>
            Paste this URL into your calendar app to get holidays + your leaves
            as a live feed.
          </DialogDescription>
        </DialogHeader>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input
            readOnly
            className="input"
            value={ical.data?.url ?? 'Loading…'}
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Btn
            kind="secondary"
            icon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            onClick={handleCopy}
            disabled={!ical.data?.url}
          >
            {copied ? 'Copied' : 'Copy'}
          </Btn>
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
