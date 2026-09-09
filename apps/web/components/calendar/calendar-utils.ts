import type { PillTone } from '@/components/proto/Pill'
import type {
  AttendeeResponse,
  CalendarFeedItem,
  CalendarItemType,
  MeetingProvider,
} from '@/lib/api/queries/use-calendar'

// ─────────────────────────────────────────────────────────
// Round J — pure helpers for the calendar views. Everything here is LOCAL
// browser time: the feed carries UTC instants and we render them in the
// viewer's zone (a Dubai teammate sees a Chennai 16:00 meeting at 14:30).
// All-day items carry inclusive `startDate`/`endDate` and never shift.
// ─────────────────────────────────────────────────────────

export type CalendarView = 'day' | 'week' | 'month' | 'agenda'
export const VIEWS: CalendarView[] = ['day', 'week', 'month', 'agenda']
export const VIEW_LABEL: Record<CalendarView, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  agenda: 'Agenda',
}

export const HOUR_PX = 48
export const AGENDA_DAYS = 30

const pad = (n: number) => String(n).padStart(2, '0')

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

export function isISODate(v: string | null | undefined): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(parseISODate(v).getTime())
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

export function startOfWeek(d: Date, weekStartsOn: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = (x.getDay() - weekStartsOn + 7) % 7
  x.setDate(x.getDate() - diff)
  return x
}

export function todayISO(): string {
  return toISODate(new Date())
}

export interface CalendarRange {
  from: string
  to: string
  days: Date[]
}

/** The visible days for a view around `date` (month = the 42-cell grid). */
export function rangeFor(view: CalendarView, date: Date, weekStartsOn: number): CalendarRange {
  let start: Date
  let count: number
  if (view === 'day') {
    start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    count = 1
  } else if (view === 'week') {
    start = startOfWeek(date, weekStartsOn)
    count = 7
  } else if (view === 'month') {
    start = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1), weekStartsOn)
    count = 42
  } else {
    start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    count = AGENDA_DAYS
  }
  const days = Array.from({ length: count }, (_, i) => addDays(start, i))
  return { from: toISODate(days[0]!), to: toISODate(days[days.length - 1]!), days }
}

/** Steps `date` one page in the view's unit. */
export function stepDate(view: CalendarView, date: Date, dir: 1 | -1): Date {
  if (view === 'day') return addDays(date, dir)
  if (view === 'week') return addDays(date, 7 * dir)
  if (view === 'month') return addMonths(date, dir)
  return addDays(date, AGENDA_DAYS * dir)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function weekdayShort(dow: number): string {
  return WEEKDAYS[dow]?.slice(0, 3) ?? ''
}

export function fmtTime(v: Date | string): string {
  const d = typeof v === 'string' ? new Date(v) : v
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDayLong(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function fmtDayMedium(d: Date): string {
  return `${weekdayShort(d.getDay())} ${d.getDate()} ${MONTHS[d.getMonth()]?.slice(0, 3)}`
}

export function fmtRangeTitle(view: CalendarView, range: CalendarRange, date: Date): string {
  if (view === 'month') return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
  if (view === 'day') return fmtDayLong(date)
  const a = range.days[0]!
  const b = range.days[range.days.length - 1]!
  const ma = MONTHS[a.getMonth()]?.slice(0, 3)
  const mb = MONTHS[b.getMonth()]?.slice(0, 3)
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${b.getDate()} ${ma} ${b.getFullYear()}`
  if (a.getFullYear() === b.getFullYear()) return `${a.getDate()} ${ma} – ${b.getDate()} ${mb} ${b.getFullYear()}`
  return `${a.getDate()} ${ma} ${a.getFullYear()} – ${b.getDate()} ${mb} ${b.getFullYear()}`
}

/** Inclusive local calendar days an item covers (timed → viewer's zone). */
export function localDates(item: CalendarFeedItem): { start: string; end: string } {
  if (item.allDay) return { start: item.startDate, end: item.endDate }
  const s = new Date(item.startAt)
  const e = new Date(new Date(item.endAt).getTime() - 1)
  return { start: toISODate(s), end: toISODate(e) }
}

export function occursOn(item: CalendarFeedItem, iso: string): boolean {
  const { start, end } = localDates(item)
  return start <= iso && end >= iso
}

export const TYPE_LABEL: Record<CalendarItemType, string> = {
  holiday: 'Holiday',
  my_leave: 'My leave',
  team_leave: 'Team leave',
  event: 'Event',
  meeting: 'Meeting',
  birthday: 'Birthday',
  anniversary: 'Work anniversary',
  crm_activity: 'CRM',
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** Display colour for an item (CSS colour string). */
export function kindColor(item: CalendarFeedItem): string {
  switch (item.type) {
    case 'holiday':
      return 'var(--yellow)'
    case 'my_leave':
      return item.color && HEX.test(item.color) ? item.color : 'var(--blue)'
    case 'team_leave':
      return 'var(--purple)'
    case 'birthday':
      return 'var(--purple)'
    case 'anniversary':
      return 'var(--green)'
    case 'crm_activity':
      return 'var(--blue-2)'
    default:
      return item.color && HEX.test(item.color) ? item.color : 'var(--green)'
  }
}

/** Translucent fill from any CSS colour (color-mix keeps CSS vars usable). */
export function tint(color: string, pct = 16): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

// ─── Filters (legend toggles, persisted per browser) ──────────────────────────

export const FILTER_KEYS = ['holidays', 'my_leave', 'team_leave', 'events', 'celebrations', 'crm'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]
export const FILTER_META: Record<FilterKey, { label: string; color: string }> = {
  holidays: { label: 'Holidays', color: 'var(--yellow)' },
  my_leave: { label: 'My leave', color: 'var(--blue)' },
  team_leave: { label: 'Team leave', color: 'var(--purple)' },
  events: { label: 'Meetings & events', color: 'var(--green)' },
  celebrations: { label: 'Birthdays & anniversaries', color: 'var(--coral)' },
  crm: { label: 'CRM calls & meetings', color: 'var(--blue-2)' },
}
export const DEFAULT_FILTERS: Record<FilterKey, boolean> = {
  holidays: true,
  my_leave: true,
  team_leave: true,
  events: true,
  celebrations: true,
  crm: true,
}

export function filterKeyOf(item: CalendarFeedItem): FilterKey {
  switch (item.type) {
    case 'holiday':
      return 'holidays'
    case 'my_leave':
      return 'my_leave'
    case 'team_leave':
      return 'team_leave'
    case 'birthday':
    case 'anniversary':
      return 'celebrations'
    case 'crm_activity':
      return 'crm'
    default:
      return 'events'
  }
}

const FILTERS_KEY = 'calendar.filters'

export function loadFilters(): Record<FilterKey, boolean> {
  if (typeof window === 'undefined') return { ...DEFAULT_FILTERS }
  try {
    const raw = window.localStorage.getItem(FILTERS_KEY)
    if (!raw) return { ...DEFAULT_FILTERS }
    const parsed = JSON.parse(raw) as Partial<Record<FilterKey, boolean>>
    const out = { ...DEFAULT_FILTERS }
    for (const k of FILTER_KEYS) if (typeof parsed[k] === 'boolean') out[k] = parsed[k] as boolean
    return out
  } catch {
    return { ...DEFAULT_FILTERS }
  }
}

export function saveFilters(f: Record<FilterKey, boolean>): void {
  try {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify(f))
  } catch {
    /* private mode */
  }
}

// ─── Day layout (week / day view lanes) ───────────────────────────────────────

export interface LaidOut {
  item: CalendarFeedItem
  /** px from the top of the 24-hour column */
  top: number
  height: number
  lane: number
  lanes: number
  startMin: number
  endMin: number
}

/**
 * Greedy lane packing for one day's timed items: overlapping blocks share
 * the column width; each overlap cluster gets its own lane count so a lone
 * 09:00 meeting still takes the full width.
 */
export function layoutDay(items: CalendarFeedItem[], iso: string, hourHeight = HOUR_PX): LaidOut[] {
  const dayStart = parseISODate(iso).getTime()
  const dayEnd = dayStart + 86_400_000
  const timed = items
    .filter((it) => !it.allDay && occursOn(it, iso))
    .map((it) => {
      const s = Math.max(new Date(it.startAt).getTime(), dayStart)
      const e = Math.min(new Date(it.endAt).getTime(), dayEnd)
      const startMin = Math.round((s - dayStart) / 60_000)
      const endMin = Math.max(startMin + 15, Math.round((e - dayStart) / 60_000))
      return { item: it, startMin, endMin }
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)

  const out: LaidOut[] = []
  let cluster: Array<{ item: CalendarFeedItem; startMin: number; endMin: number; lane: number }> = []
  let clusterEnd = -1
  const flush = () => {
    const lanes = cluster.reduce((m, c) => Math.max(m, c.lane + 1), 1)
    for (const c of cluster) {
      out.push({
        item: c.item,
        top: (c.startMin / 60) * hourHeight,
        height: Math.max(18, ((c.endMin - c.startMin) / 60) * hourHeight - 2),
        lane: c.lane,
        lanes,
        startMin: c.startMin,
        endMin: c.endMin,
      })
    }
    cluster = []
    clusterEnd = -1
  }
  for (const t of timed) {
    if (cluster.length && t.startMin >= clusterEnd) flush()
    const laneEnds: number[] = []
    for (const c of cluster) laneEnds[c.lane] = Math.max(laneEnds[c.lane] ?? 0, c.endMin)
    let lane = 0
    while ((laneEnds[lane] ?? 0) > t.startMin) lane++
    cluster.push({ ...t, lane })
    clusterEnd = Math.max(clusterEnd, t.endMin)
  }
  if (cluster.length) flush()
  return out
}

export function minutesNow(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}

/** Local `Date` for `iso` at `minutes` past midnight. */
export function atMinutes(iso: string, minutes: number): Date {
  const d = parseISODate(iso)
  d.setMinutes(minutes)
  return d
}

/** 'YYYY-MM-DDTHH:mm' in local time (what DateTimeField speaks). */
export function toLocalInput(d: Date): string {
  return `${toISODate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInput(v: string): Date | null {
  if (!v || v.length < 16) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export function roundUpTo(d: Date, stepMin: number): Date {
  const x = new Date(d)
  x.setSeconds(0, 0)
  const m = x.getMinutes()
  const r = Math.ceil(m / stepMin) * stepMin
  x.setMinutes(r)
  return x
}

/** Human "when" for a detail card, in local time. */
export function fmtWhen(item: CalendarFeedItem): string {
  if (item.allDay) {
    const s = parseISODate(item.startDate)
    const e = parseISODate(item.endDate)
    if (item.startDate === item.endDate) return `${fmtDayMedium(s)} ${s.getFullYear()} · all day`
    return `${fmtDayMedium(s)} – ${fmtDayMedium(e)} ${e.getFullYear()} · all day`
  }
  const s = new Date(item.startAt)
  const e = new Date(item.endAt)
  if (toISODate(s) === toISODate(e) || toISODate(s) === toISODate(new Date(e.getTime() - 1))) {
    return `${fmtDayMedium(s)} ${s.getFullYear()} · ${fmtTime(s)}–${fmtTime(e)}`
  }
  return `${fmtDayMedium(s)} ${fmtTime(s)} – ${fmtDayMedium(e)} ${fmtTime(e)}`
}

export function durationLabel(item: CalendarFeedItem): string {
  const ms = new Date(item.endAt).getTime() - new Date(item.startAt).getTime()
  const m = Math.round(ms / 60_000)
  if (item.allDay) {
    const days = Math.round(ms / 86_400_000)
    return days <= 1 ? 'All day' : `${days} days`
  }
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

export function providerLabel(p: MeetingProvider | undefined | null): string {
  switch (p) {
    case 'teams':
      return 'Microsoft Teams'
    case 'google_meet':
      return 'Google Meet'
    case 'other':
      return 'Video link'
    default:
      return 'No meeting link'
  }
}

/** Client-side mirror of the API's host rule (kept in sync with calendar.service). */
export function providerUrlProblem(p: MeetingProvider, url: string): string | null {
  const v = url.trim()
  if (!v) return null
  let parsed: URL
  try {
    parsed = new URL(v)
  } catch {
    return 'Paste a full https:// link'
  }
  if (parsed.protocol !== 'https:') return 'Meeting links must start with https://'
  const host = parsed.hostname.toLowerCase()
  const ok = (hosts: string[]) => hosts.some((h) => host === h || host.endsWith(`.${h}`))
  if (p === 'teams' && !ok(['teams.microsoft.com', 'teams.live.com'])) return 'A Teams link points at teams.microsoft.com'
  if (p === 'google_meet' && !ok(['meet.google.com'])) return 'A Google Meet link points at meet.google.com'
  return null
}

export function responseTone(r: AttendeeResponse | null | undefined): PillTone {
  if (r === 'accepted') return 'green'
  if (r === 'declined') return 'coral'
  if (r === 'tentative') return 'yellow'
  return ''
}

export function responseLabel(r: AttendeeResponse | null | undefined): string {
  if (r === 'accepted') return 'Accepted'
  if (r === 'declined') return 'Declined'
  if (r === 'tentative') return 'Tentative'
  return 'No reply'
}

/** Legacy IANA aliases some browsers still report (Chromium says Asia/Calcutta). */
const TZ_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Ujung_Pandang': 'Asia/Makassar',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
}

export function browserTimezone(): string {
  try {
    const raw = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    return TZ_ALIASES[raw] ?? raw
  } catch {
    return 'UTC'
  }
}

/** Current UTC offset (minutes) of an IANA zone; null when unknown. */
export function zoneOffsetMinutes(tz: string, at = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at)
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
    const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
    return Math.round((asUTC - at.getTime()) / 60_000)
  } catch {
    return null
  }
}

/** True when two zones currently keep the same clock (aliases, DST-equal). */
export function sameClock(a: string, b: string): boolean {
  if ((TZ_ALIASES[a] ?? a) === (TZ_ALIASES[b] ?? b)) return true
  const oa = zoneOffsetMinutes(a)
  const ob = zoneOffsetMinutes(b)
  return oa !== null && ob !== null && oa === ob
}

/** Sort: all-day first, then by start, then title. */
export function sortItems(items: CalendarFeedItem[]): CalendarFeedItem[] {
  return [...items].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
    if (a.startAt !== b.startAt) return a.startAt < b.startAt ? -1 : 1
    return a.title.localeCompare(b.title)
  })
}
