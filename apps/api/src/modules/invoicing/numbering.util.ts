/**
 * Fiscal-year + invoice-number formatting helpers (PRD §6.4).
 *
 * Indian FY defaults to April–March (tenants.fiscal_year_start_month = 4). A
 * date on/after the start month belongs to FY[year..year+1]; before it, to
 * FY[year-1..year]. The April-1 reset is implicit: a new FY produces a new
 * (tenant, doc_type, fy_label) sequence row that starts again at starting_number.
 */

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
  separator: string;
  fyLabel: string;
  zeroPadding: number;
  number: number;
}

export function formatNumber(parts: NumberFormatParts): string {
  const padded = String(parts.number).padStart(parts.zeroPadding, '0');
  return [parts.prefix, parts.fyLabel, padded]
    .filter((p) => p !== '')
    .join(parts.separator);
}

const NUMBER_CHARSET = /^[A-Za-z0-9/-]+$/;
const MAX_NUMBER_LENGTH = 16;

export interface NumberValidationResult {
  valid: boolean;
  errors: string[];
  sample: string;
}

/**
 * Hard validation (PRD §6.4): the formatted number must be ≤16 chars and use
 * only alphanumerics + `-` and `/`. Validated against the starting number as a
 * representative sample.
 */
export function validateNumberFormat(parts: NumberFormatParts): NumberValidationResult {
  const sample = formatNumber(parts);
  const errors: string[] = [];
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
  return { valid: errors.length === 0, errors, sample };
}

export const DEFAULT_PREFIXES: Record<string, string> = {
  INVOICE: 'INV',
  QUOTE: 'QT',
  CREDIT_NOTE: 'CN',
  DEBIT_NOTE: 'DN',
};

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
