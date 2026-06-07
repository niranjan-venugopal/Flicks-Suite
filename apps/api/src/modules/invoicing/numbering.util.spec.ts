import {
  computeFiscalYear,
  formatFyLabel,
  formatNumber,
  validateNumberFormat,
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
  });
});
