import {
  computeFiscalYear,
  formatFyLabel,
  formatNumber,
  validateNumberFormat,
  SEPARATORS,
  FY_FORMATS,
  SERIES_MODES,
  SERIES_HORIZON,
  MAX_NUMBER_LENGTH,
} from './numbering.util';

describe('Invoice numbering utilities (PRD §6.4)', () => {
  describe('computeFiscalYear (April start)', () => {
    it('maps an April date to the FY that starts that April', () => {
      const fy = computeFiscalYear('2026-04-01', 4, '26-27');
      expect(fy.label).toBe('26-27');
      expect(fy.startDate).toBe('2026-04-01');
      expect(fy.endDate).toBe('2027-03-31');
    });

    it('maps a March date to the FY that started the previous April', () => {
      const fy = computeFiscalYear('2026-03-31', 4, '26-27');
      expect(fy.label).toBe('25-26');
      expect(fy.startDate).toBe('2025-04-01');
      expect(fy.endDate).toBe('2026-03-31');
    });

    it('honours a January (calendar-year) fiscal start', () => {
      const fy = computeFiscalYear('2026-06-15', 1, '2026');
      expect(fy.startDate).toBe('2026-01-01');
      expect(fy.endDate).toBe('2026-12-31');
    });
  });

  describe('computeFiscalYear — window vs label (Round P R1.4)', () => {
    it('the FY window is format-independent; only the label changes', () => {
      // numbering.service keys the sequence row on fy_start_date for exactly
      // this reason: a saved '2026-27' format must find the same row as
      // '26-27', and the printed label is derived from the format.
      const short = computeFiscalYear('2026-10-04', 4, '26-27');
      const long = computeFiscalYear('2026-10-04', 4, '2026-27');
      expect(long.startDate).toBe(short.startDate);
      expect(long.endDate).toBe(short.endDate);
      expect(short.label).toBe('26-27');
      expect(long.label).toBe('2026-27');
      // The label is purely a function of (format, startYear, endYear).
      expect(formatFyLabel('2026-27', long.startYear, long.endYear)).toBe(long.label);
      expect(formatFyLabel('26-27', short.startYear, short.endYear)).toBe(short.label);
    });
  });

  describe('formatFyLabel', () => {
    it('supports the documented formats', () => {
      expect(formatFyLabel('26-27', 2026, 2027)).toBe('26-27');
      expect(formatFyLabel('2026-27', 2026, 2027)).toBe('2026-27');
      expect(formatFyLabel('2026-2027', 2026, 2027)).toBe('2026-2027');
      expect(formatFyLabel('2026', 2026, 2027)).toBe('2026');
    });
  });

  describe('formatNumber', () => {
    it('joins prefix / FY / zero-padded number with the separator', () => {
      expect(
        formatNumber({
          prefix: 'INV',
          separator: '/',
          fyLabel: '26-27',
          zeroPadding: 4,
          number: 1,
        }),
      ).toBe('INV/26-27/0001');
    });

    it('omits an empty prefix', () => {
      expect(
        formatNumber({
          prefix: '',
          separator: '-',
          fyLabel: '26-27',
          zeroPadding: 3,
          number: 42,
        }),
      ).toBe('26-27-042');
    });
  });

  describe('validateNumberFormat (hard rules)', () => {
    it('accepts a compliant number', () => {
      const r = validateNumberFormat({
        prefix: 'INV',
        separator: '/',
        fyLabel: '26-27',
        zeroPadding: 4,
        number: 1,
      });
      expect(r.valid).toBe(true);
      expect(r.sample).toBe('INV/26-27/0001');
    });

    it('rejects a number longer than 16 characters', () => {
      const r = validateNumberFormat({
        prefix: 'LONGPREFIX',
        separator: '/',
        fyLabel: '2026-2027',
        zeroPadding: 6,
        number: 1,
      });
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/max 16/);
    });

    it('rejects disallowed characters', () => {
      const r = validateNumberFormat({
        prefix: 'IN#V',
        separator: '/',
        fyLabel: '26-27',
        zeroPadding: 4,
        number: 1,
      });
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/letters, digits/);
    });

    it('always returns a warnings array (empty without a horizon)', () => {
      const r = validateNumberFormat({
        prefix: 'INV',
        separator: '/',
        fyLabel: '26-27',
        zeroPadding: 4,
        number: 1,
      });
      expect(r.warnings).toEqual([]);
    });
  });

  // ─── Round P R2: continuous series (no FY token, '' separator, horizon) ────

  describe('constants (K2/K4 contract)', () => {
    it('exposes the allowed separators, FY formats, modes and horizons', () => {
      expect([...SEPARATORS]).toEqual(['', '/', '-']);
      expect([...FY_FORMATS]).toEqual(['26-27', '2026-27', '2026-2027', '2026']);
      expect([...SERIES_MODES]).toEqual(['fiscal_year', 'continuous']);
      expect(SERIES_HORIZON).toEqual({ fiscal_year: 9_999, continuous: 99_999 });
      expect(MAX_NUMBER_LENGTH).toBe(16);
    });
  });

  describe('formatNumber — continuous series (Round P R2)', () => {
    it('omits the FY token when fyLabel is null', () => {
      expect(
        formatNumber({ prefix: 'INV', separator: '/', fyLabel: null, zeroPadding: 4, number: 7 }),
      ).toBe('INV/0007');
    });

    it('treats an empty fyLabel like null', () => {
      expect(
        formatNumber({ prefix: 'INV', separator: '-', fyLabel: '', zeroPadding: 4, number: 7 }),
      ).toBe('INV-0007');
    });

    it("concatenates with the '' separator: prefix LB24 + pad 5 → LB2400001", () => {
      expect(
        formatNumber({ prefix: 'LB24', separator: '', fyLabel: null, zeroPadding: 5, number: 1 }),
      ).toBe('LB2400001');
      expect(
        formatNumber({ prefix: 'LB24', separator: '', fyLabel: null, zeroPadding: 5, number: 2 }),
      ).toBe('LB2400002');
    });

    it("'' separator still works with an FY token (financial-year mode without a separator)", () => {
      expect(
        formatNumber({ prefix: 'INV', separator: '', fyLabel: '2026', zeroPadding: 4, number: 12 }),
      ).toBe('INV20260012');
    });

    it('a number wider than the pad simply grows (no truncation)', () => {
      expect(
        formatNumber({ prefix: 'LB24', separator: '', fyLabel: null, zeroPadding: 5, number: 123456 }),
      ).toBe('LB24123456');
    });

    it('no prefix, no FY token → just the padded number', () => {
      expect(
        formatNumber({ prefix: '', separator: '/', fyLabel: null, zeroPadding: 6, number: 42 }),
      ).toBe('000042');
    });
  });

  describe('validateNumberFormat — 16-char boundary and horizon warnings (Round P R2)', () => {
    it('exactly 16 characters is valid; 17 is an error', () => {
      // 'ABCDEFGHIJ' (10) + '/' + '00001' (5) = 16
      const ok = validateNumberFormat({
        prefix: 'ABCDEFGHIJ',
        separator: '/',
        fyLabel: null,
        zeroPadding: 5,
        number: 1,
      });
      expect(ok.sample).toHaveLength(16);
      expect(ok.valid).toBe(true);
      expect(ok.errors).toEqual([]);

      const over = validateNumberFormat({
        prefix: 'ABCDEFGHIJ',
        separator: '/',
        fyLabel: null,
        zeroPadding: 6,
        number: 1,
      });
      expect(over.sample).toHaveLength(17);
      expect(over.valid).toBe(false);
      expect(over.errors.join(' ')).toMatch(/max 16/);
      // An outright error is not also reported as a warning.
      expect(over.warnings).toEqual([]);
    });

    it('a continuous series with a pad narrower than its horizon warns at the 16-char edge', () => {
      // 'ABCDEFGHIJK' (11) + '/' + '0001' = 16 today; the next 99,999
      // numbers include 10000 (5 digits) → 17 chars.
      const r = validateNumberFormat(
        { prefix: 'ABCDEFGHIJK', separator: '/', fyLabel: null, zeroPadding: 4, number: 1 },
        { horizon: SERIES_HORIZON.continuous },
      );
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/from 10000 onward/);
      expect(r.warnings[0]).toMatch(/17 characters/);
      expect(r.warnings[0]).toMatch(/ABCDEFGHIJK\/10000/);
    });

    it('the same pad-4 config under the financial-year horizon (next 9,999 numbers) does not warn', () => {
      // 1..9,999 all fit in 4 digits — the default FY pad never warns at 16.
      const r = validateNumberFormat(
        { prefix: 'ABCDEFGHIJK', separator: '/', fyLabel: null, zeroPadding: 4, number: 1 },
        { horizon: SERIES_HORIZON.fiscal_year },
      );
      expect(r.valid).toBe(true);
      expect(r.warnings).toEqual([]);
    });

    it('the default-width continuous config (pad 5) never warns at exactly 16 chars', () => {
      // 'ABCDEFGHIJ' (10) + '/' + '00001' = 16; the next 99,999 numbers end
      // at 99,999 — still 5 digits.
      const r = validateNumberFormat(
        { prefix: 'ABCDEFGHIJ', separator: '/', fyLabel: null, zeroPadding: 5, number: 1 },
        { horizon: SERIES_HORIZON.continuous },
      );
      expect(r.sample).toHaveLength(16);
      expect(r.valid).toBe(true);
      expect(r.warnings).toEqual([]);
    });

    it('a financial-year series with pad 3 warns that 4 digits overflow inside the next 9,999', () => {
      // 'ABCDEF' (6) + '/' + '26-27' (5) + '/' + '001' (3) = 16.
      const r = validateNumberFormat(
        { prefix: 'ABCDEF', separator: '/', fyLabel: '26-27', zeroPadding: 3, number: 1 },
        { horizon: SERIES_HORIZON.fiscal_year },
      );
      expect(r.valid).toBe(true);
      expect(r.sample).toBe('ABCDEF/26-27/001');
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/from 1000 onward/);
      expect(r.warnings[0]).toMatch(/ABCDEF\/26-27\/1000/);
    });

    it('the horizon is measured from the number being validated, not from 1', () => {
      // Next number 95,000 with pad 5: 100000 is within the next 99,999 → warn.
      const near = validateNumberFormat(
        { prefix: 'ABCDEFGHIJ', separator: '/', fyLabel: null, zeroPadding: 5, number: 95_000 },
        { horizon: SERIES_HORIZON.continuous },
      );
      expect(near.sample).toBe('ABCDEFGHIJ/95000');
      expect(near.warnings).toHaveLength(1);
      expect(near.warnings[0]).toMatch(/from 100000 onward/);
      // Short prefix: nothing within reach overflows.
      const roomy = validateNumberFormat(
        { prefix: 'LB24', separator: '', fyLabel: null, zeroPadding: 5, number: 1 },
        { horizon: SERIES_HORIZON.continuous },
      );
      expect(roomy.sample).toBe('LB2400001');
      expect(roomy.valid).toBe(true);
      expect(roomy.warnings).toEqual([]);
    });

    it('the default INV/2026-27/0001 (16 chars) saves without a warning', () => {
      const r = validateNumberFormat(
        { prefix: 'INV', separator: '/', fyLabel: '2026-27', zeroPadding: 4, number: 1 },
        { horizon: SERIES_HORIZON.fiscal_year },
      );
      expect(r.sample).toBe('INV/2026-27/0001');
      expect(r.valid).toBe(true);
      expect(r.warnings).toEqual([]);
    });
  });
});
