/**
 * Round L — timezone helpers for the web. Ports of the API's
 * core/common/time.ts (dateInTimezone) and attendance.service.ts
 * (localTimeToUTC) so the regularization dialog builds instants in the
 * SHIFT's timezone, never the browser's.
 */

export const DEFAULT_TIMEZONE = 'Asia/Kolkata'

/** True when `tz` is an IANA zone this browser's ICU data knows. */
export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * YYYY-MM-DD as observed in `tz` for the given instant. 'sv-SE' formats as
 * ISO-8601, so the parts come back zero-padded and in order.
 */
export function dateInTimezone(instant: Date, tz: string): string {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Today's YYYY-MM-DD in `tz` (client clock unless `now` is given). */
export function todayInTimezone(tz: string, now: Date = new Date()): string {
  return dateInTimezone(now, tz)
}

/** Adds `n` days to a YYYY-MM-DD string (calendar arithmetic, UTC-safe). */
export function addDaysISO(dateISO: string, n: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Converts a wall-clock time-of-day on a calendar day in `tz` to the UTC
 * instant — the same algorithm as the API's core/common/time.ts: the
 * observed wall clock is compared as a full date-time, so an evening time
 * never slips onto the next day. Converges in ≤3 rounds across DST edges.
 *
 *   localTimeToUTC('2026-05-08', '09:00', 'Asia/Kolkata') → 2026-05-08T03:30:00Z
 *   localTimeToUTC('2026-05-08', '22:00', 'Asia/Kolkata') → 2026-05-08T16:30:00Z
 */
export function localTimeToUTC(dateISO: string, hhmm: string, tz: string): Date {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE
  const [hh = 0, mm = 0] = hhmm.split(':').map(Number)
  const [y = 1970, mo = 1, d = 1] = dateISO.split('-').map(Number)
  const target = Date.UTC(y, mo - 1, d, hh, mm, 0, 0)
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const wallAsUTC = (t: number): number => {
    const parts = dtf.formatToParts(new Date(t))
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0)
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  }
  let guess = target
  for (let i = 0; i < 3; i++) {
    const diff = wallAsUTC(guess) - target
    if (diff === 0) break
    guess -= diff
  }
  return new Date(guess)
}

/**
 * "IST" / "GST" / "PDT" — a named abbreviation for the zone when the ICU
 * data has one (Asia/Kolkata is only named under an Indian locale, so en-IN
 * is tried first), else the browser's own rendering ("GMT+5:30").
 */
export function tzShortName(tz: string, at: Date = new Date()): string {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE
  let fallback = zone
  for (const locale of ['en-IN', 'en-GB', undefined]) {
    try {
      const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')
      if (!part) continue
      if (!/^(GMT|UTC)[+-]/.test(part.value)) return part.value
      fallback = part.value
    } catch {
      /* try the next locale */
    }
  }
  return fallback
}
