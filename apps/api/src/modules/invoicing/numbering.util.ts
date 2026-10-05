/**
 * Fiscal-year + invoice-number formatting helpers (PRD §6.4).
 *
 * Indian FY defaults to April–March (tenants.fiscal_year_start_month = 4). A
 * date on/after the start month belongs to FY[year..year+1]; before it, to
 * FY[year-1..year]. The April-1 reset is implicit: a new FY produces a new
 * (tenant, doc_type, fy_label) sequence row that starts again at starting_number.
 *
 * Round P R2 — two series modes per document type:
 *   'fiscal_year'  PREFIX{sep}FY{sep}NNNN, resets each FY (today's behaviour);
 *   'continuous'   PREFIX{sep?}NNNNN, never resets (e.g. LB2400001) — the
 *                  number carries no FY token, so `fyLabel` may be null and the
 *                  separator may be '' (prefix LB24 + pad 5 → LB2400001).
 */

export const SEPARATORS = ['', '/', '-'] as const;
export type Separator = (typeof SEPARATORS)[number];

export const FY_FORMATS = ['26-27', '2026-27', '2026-2027', '2026'] as const;
export type FyFormat = (typeof FY_FORMATS)[number];

export const SERIES_MODES = ['fiscal_year', 'continuous'] as const;
export type SeriesMode = (typeof SERIES_MODES)[number];

/**
 * How far ahead validateNumberFormat() looks for the 16-char ceiling: a
 * continuous series is expected to issue the next 99,999 numbers, a
 * financial-year series the next 9,999 before it resets.
 *
 * The window is EXACTLY the next `horizon` numbers counting from the one
 * being validated (the next number to be issued, `starting_number` on a
 * fresh series): [next, next + horizon - 1]. With pad 4 in a FY that is
 * 1..9,999 — every 4-digit number — so a 16-char default such as
 * INV/2026-27/0001 saves without a warning (pinned by
 * founder-roundP-r1-invoicing.spec), and pad 5 continuous likewise covers
 * 1..99,999. A pad narrower than the horizon's digit count warns, naming the
 * first power of ten that no longer fits. The web's client-side horizon
 * check must mirror this window (last probed number = nextNumber + horizon
 * - 1), or the tab's pill and the save toast disagree at the 16-char edge.
 */
export const SERIES_HORIZON: Record<SeriesMode, number> = {
  fiscal_year: 9_999,
  continuous: 99_999,
};

export interface FyInfo {
  startYear: number;
  endYear: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  label: string; // formatted per fyFormat
}

export function computeFiscalYear(
  isoDate: string,
  startMonth = 4,
  fyFormat = '26-27',
): FyInfo {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12
  const startYear = month >= startMonth ? year : year - 1;
  const endYear = startYear + 1;
  const mm = String(startMonth).padStart(2, '0');
  // FY runs [startYear-startMonth-01 .. endYear-(startMonth-1 end)]; for April
  // start that's endYear-03-31. Compute the day before the next start.
  const startDate = `${startYear}-${mm}-01`;
  // FY ends the day before the next FY start. For a January (calendar-year)
  // start that is Dec 31 of the SAME year; otherwise the (startMonth-1) month
  // end of the following year.
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYearForDate = startMonth === 1 ? startYear : endYear;
  const endDay = lastDayOfMonth(endYearForDate, endMonth);
  const endDate = `${endYearForDate}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  return {
    startYear,
    endYear,
    startDate,
    endDate,
    label: formatFyLabel(fyFormat, startYear, endYear),
  };
}

export function formatFyLabel(
  fyFormat: string,
  startYear: number,
  endYear: number,
): string {
  const s2 = String(startYear).slice(2);
  const e2 = String(endYear).slice(2);
  switch (fyFormat) {
    case '2026-2027':
      return `${startYear}-${endYear}`;
    case '2026-27':
      return `${startYear}-${e2}`;
    case '2026':
      return `${startYear}`;
    case '26-27':
    default:
      return `${s2}-${e2}`;
  }
}

export interface NumberFormatParts {
  prefix: string;
  /** '' | '/' | '-' — '' simply concatenates the parts. */
  separator: string;
  /** null / '' in a continuous series: no FY token is printed. */
  fyLabel: string | null;
  zeroPadding: number;
  number: number;
}

/**
 * formatted = [prefix, fyLabel, padded].filter(non-empty).join(separator).
 * The web's client-side buildNumber mirrors this exactly (K3/K4).
 */
export function formatNumber(parts: NumberFormatParts): string {
  const padded = String(parts.number).padStart(parts.zeroPadding, '0');
  return [parts.prefix ?? '', parts.fyLabel ?? '', padded]
    .filter((p) => p !== '')
    .join(parts.separator ?? '');
}

const NUMBER_CHARSET = /^[A-Za-z0-9/-]+$/;
export const MAX_NUMBER_LENGTH = 16;

export interface NumberValidationResult {
  valid: boolean;
  errors: string[];
  /** Soft advice — the save still goes through. */
  warnings: string[];
  sample: string;
}

export interface NumberValidationOptions {
  /**
   * How many numbers, counting from `parts.number`, the series is expected
   * to issue (SERIES_HORIZON[mode]). When any of them would exceed
   * MAX_NUMBER_LENGTH a warning names the first one that breaks the rule.
   */
  horizon?: number;
}

/**
 * Hard validation (PRD §6.4): the formatted number must be ≤16 chars and use
 * only alphanumerics + `-` and `/`. Validated against `parts.number` (the next
 * number to be issued) as a representative sample. `errors` keep their
 * meaning — a non-empty list means the config is refused; `warnings` are
 * advisory (the 16-char ceiling inside the horizon).
 */
export function validateNumberFormat(
  parts: NumberFormatParts,
  opts: NumberValidationOptions = {},
): NumberValidationResult {
  const sample = formatNumber(parts);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (sample.length > MAX_NUMBER_LENGTH) {
    errors.push(
      `Formatted number "${sample}" is ${sample.length} chars (max ${MAX_NUMBER_LENGTH}).`,
    );
  }
  if (!NUMBER_CHARSET.test(sample)) {
    errors.push(
      'Only letters, digits, "-" and "/" are allowed in the invoice number.',
    );
  }

  if (errors.length === 0 && opts.horizon && opts.horizon > 0) {
    const overflow = firstOverLength(parts, opts.horizon);
    if (overflow) {
      warnings.push(
        `Numbers from ${overflow.number} onward would be ${overflow.sample.length} characters ` +
          `(e.g. "${overflow.sample}"; GST allows ${MAX_NUMBER_LENGTH}). ` +
          'Shorten the prefix or the pad width before the series gets there.',
      );
    }
  }
  return { valid: errors.length === 0, errors, warnings, sample };
}

/**
 * The first number in (parts.number, parts.number + horizon - 1] — the next
 * `horizon` numbers, the sample itself excluded because it was already
 * checked as a hard error — whose formatted form exceeds MAX_NUMBER_LENGTH.
 * The length only grows when the digit count does, so it is enough to probe
 * each power of ten inside the window. The window end is deliberately
 * `+ horizon - 1`, not `+ horizon` (see SERIES_HORIZON).
 */
function firstOverLength(
  parts: NumberFormatParts,
  horizon: number,
): { number: number; sample: string } | null {
  const last = parts.number + horizon - 1;
  for (let p = 10; p <= last; p *= 10) {
    if (p <= parts.number) continue; // already covered by the sample itself
    const sample = formatNumber({ ...parts, number: p });
    if (sample.length > MAX_NUMBER_LENGTH) return { number: p, sample };
  }
  return null;
}

export const DEFAULT_PREFIXES: Record<string, string> = {
  INVOICE: 'INV',
  QUOTE: 'QT',
  CREDIT_NOTE: 'CRN',
  DEBIT_NOTE: 'DBN',
};

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
