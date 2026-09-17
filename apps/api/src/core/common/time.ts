/**
 * Shared timezone helpers (Round J). The attendance module keeps its private
 * copies of the first two; new code should import from here.
 */

/** True when `tz` is an IANA zone the runtime's ICU data knows. */
export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns YYYY-MM-DD as observed in `tz` for the given UTC instant.
 * Uses 'sv-SE' because it produces ISO-8601 'YYYY-MM-DD HH:mm:ss'.
 */
export function dateInTimezone(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

/** Day-of-week (0=Sunday..6=Saturday) for an instant observed in `tz`. */
export function dayOfWeekInTimezone(instant: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(instant);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

/** Adds `n` days to a YYYY-MM-DD string (calendar arithmetic, UTC-safe). */
export function addDaysISO(dateISO: string, n: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Round L — wall-clock time-of-day on a calendar day in `tz` → the UTC
 * instant. Replaces the attendance module's private copy, which corrected
 * only the hour/minute delta and so landed evening wall times on the NEXT
 * day (('D','22:00','Asia/Kolkata') came back as D+1 16:30Z): here the
 * observed wall clock is compared as a full date-time, so the day is part
 * of the correction. Converges in ≤3 rounds across DST edges.
 *
 *   localTimeToUTC('2026-09-17', '09:00', 'Asia/Kolkata') → 2026-09-17T03:30:00Z
 *   localTimeToUTC('2026-09-17', '22:00', 'Asia/Kolkata') → 2026-09-17T16:30:00Z
 */
export function localTimeToUTC(dateISO: string, hhmm: string, tz: string): Date {
  const zone = isValidTimezone(tz) ? tz : 'Asia/Kolkata';
  const [hh = 0, mm = 0] = hhmm.split(':').map(Number);
  const [y = 1970, mo = 1, d = 1] = dateISO.split('-').map(Number);
  const target = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  // The wall clock observed in `zone` at instant `t`, re-read as if it were UTC.
  const wallAsUTC = (t: number): number => {
    const parts = dtf.formatToParts(new Date(t));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  };
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const diff = wallAsUTC(guess) - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Thu 10 Sep 2026" — assembled from parts so the output is stable across
 * ICU versions (en-IN / en-GB render "Sept" with commas in newer ICU data).
 */
function fmtDate(d: Date, tz: string, locale: string, withYear = true): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday').replace(/\.$/, '');
  const month = MONTHS_SHORT[Number(get('month')) - 1] ?? get('month');
  return `${weekday} ${get('day')} ${month}${withYear ? ` ${get('year')}` : ''}`;
}

function fmtTime(d: Date, tz: string, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour').padStart(2, '0')}:${get('minute').padStart(2, '0')}`;
}

/**
 * "IST" / "GST" / "PDT" — prefer a named abbreviation over "GMT+5:30" (ICU
 * names Asia/Kolkata only under an Indian locale, so try en-IN first).
 */
function tzShort(d: Date, tz: string): string {
  let fallback = tz;
  for (const locale of ['en-IN', 'en-GB', 'en-US']) {
    const part = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName');
    if (!part) continue;
    if (!/^(GMT|UTC)[+-]/.test(part.value)) return part.value;
    fallback = part.value;
  }
  return fallback;
}

/**
 * Human range for emails/notifications, rendered in the RECIPIENT's zone:
 *   timed, same day  → "Thu 10 Sep 2026, 16:00–16:30 IST"
 *   timed, spanning  → "Thu 10 Sep 2026, 22:00 – Fri 11 Sep 2026, 01:00 IST"
 *   all-day, one day → "Thu 10 Sep 2026 (all day)"
 *   all-day, range   → "Thu 10 Sep – Sat 12 Sep 2026 (all day)"
 * All-day rows store UTC midnights with an exclusive end, so their dates are
 * read in UTC regardless of `tz`.
 */
export function formatRangeInTimezone(
  startAt: Date,
  endAt: Date,
  tz: string,
  allDay: boolean,
  locale = 'en-IN',
): string {
  const zone = isValidTimezone(tz) ? tz : 'Asia/Kolkata';
  if (allDay) {
    const lastDay = new Date(endAt.getTime() - 1);
    const s = fmtDate(startAt, 'UTC', locale);
    const e = fmtDate(lastDay, 'UTC', locale);
    return s === e ? `${s} (all day)` : `${fmtDate(startAt, 'UTC', locale, false)} – ${e} (all day)`;
  }
  const sameDay = dateInTimezone(startAt, zone) === dateInTimezone(endAt, zone);
  const suffix = tzShort(startAt, zone);
  if (sameDay) {
    return `${fmtDate(startAt, zone, locale)}, ${fmtTime(startAt, zone, locale)}–${fmtTime(endAt, zone, locale)} ${suffix}`;
  }
  return `${fmtDate(startAt, zone, locale)}, ${fmtTime(startAt, zone, locale)} – ${fmtDate(endAt, zone, locale)}, ${fmtTime(endAt, zone, locale)} ${suffix}`;
}
