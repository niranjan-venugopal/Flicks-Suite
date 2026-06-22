import { computeInvoice, deriveTaxTreatment } from './tax.util';

describe('GST/TDS engine (PRD §6.1 / §6.2)', () => {
  describe('deriveTaxTreatment', () => {
    it('same state → INTRA_STATE', () => {
      expect(
        deriveTaxTreatment({ supplierStateCode: 'KA', customerStateCode: 'KA' }),
      ).toBe('INTRA_STATE');
    });
    it('different state → INTER_STATE', () => {
      expect(
        deriveTaxTreatment({ supplierStateCode: 'KA', customerStateCode: 'MH' }),
      ).toBe('INTER_STATE');
    });
    it('foreign customer → EXPORT regardless of states', () => {
      expect(
        deriveTaxTreatment({
          supplierStateCode: 'KA',
          customerStateCode: 'CA',
          customerCountryCode: 'US',
        }),
      ).toBe('EXPORT');
    });
    it('missing states default to INTER_STATE (no false intra claims)', () => {
      expect(deriveTaxTreatment({})).toBe('INTER_STATE');
    });
  });

  describe('computeInvoice — intra-state CGST/SGST split', () => {
    it('splits 18% into 9% + 9% on the taxable amount', () => {
      const r = computeInvoice({
        lines: [{ quantity: '2', rate: '500.00', gst_rate: '18' }],
        taxTreatment: 'INTRA_STATE',
      });
      expect(r.totals.subtotal).toBe('1000.00');
      expect(r.totals.cgst_amount).toBe('90.00');
      expect(r.totals.sgst_amount).toBe('90.00');
      expect(r.totals.igst_amount).toBe('0.00');
      expect(r.totals.total_amount).toBe('1180.00');
    });
  });

  describe('computeInvoice — inter-state IGST', () => {
    it('charges full-rate IGST and no CGST/SGST', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '1000.00', gst_rate: '18' }],
        taxTreatment: 'INTER_STATE',
      });
      expect(r.totals.igst_amount).toBe('180.00');
      expect(r.totals.cgst_amount).toBe('0.00');
      expect(r.totals.sgst_amount).toBe('0.00');
      expect(r.totals.total_amount).toBe('1180.00');
    });
  });

  describe('computeInvoice — export zero-rating', () => {
    it('zero-rates GST and cess for exports (LUT default)', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '1000.00', gst_rate: '18', cess_rate: '1' }],
        taxTreatment: 'EXPORT',
      });
      expect(r.totals.igst_amount).toBe('0.00');
      expect(r.totals.cess_amount).toBe('0.00');
      expect(r.totals.total_amount).toBe('1000.00');
    });
  });

  describe('computeInvoice — cess on top', () => {
    it('adds cess on the taxable amount', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '100.00', gst_rate: '28', cess_rate: '12' }],
        taxTreatment: 'INTER_STATE',
      });
      expect(r.totals.igst_amount).toBe('28.00');
      expect(r.totals.cess_amount).toBe('12.00');
      expect(r.totals.total_amount).toBe('140.00');
    });
  });

  describe('computeInvoice — invoice-level discount allocation', () => {
    it('percent discount reduces the taxable base before GST', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '1000.00', gst_rate: '18' }],
        taxTreatment: 'INTER_STATE',
        discountType: 'percent',
        discountValue: '10',
      });
      expect(r.totals.discount_amount).toBe('100.00');
      expect(r.totals.taxable_amount).toBe('900.00');
      expect(r.totals.igst_amount).toBe('162.00');
      expect(r.totals.total_amount).toBe('1062.00');
    });

    it('fixed discount allocates proportionally across lines and reconciles to the paisa', () => {
      const r = computeInvoice({
        lines: [
          { quantity: '1', rate: '100.00', gst_rate: '18' },
          { quantity: '1', rate: '200.00', gst_rate: '18' },
          { quantity: '1', rate: '33.33', gst_rate: '18' },
        ],
        taxTreatment: 'INTER_STATE',
        discountType: 'fixed',
        discountValue: '50.00',
      });
      const allocated = r.lines.reduce(
        (a, l) => a + Math.round(parseFloat(l.discount_amount) * 100),
        0,
      );
      expect(allocated).toBe(5000); // exactly ₹50.00 — no lost paisa
      expect(r.totals.discount_amount).toBe('50.00');
      // line sums must equal invoice totals
      const taxableSum = r.lines.reduce(
        (a, l) => a + Math.round(parseFloat(l.taxable_amount) * 100),
        0,
      );
      expect((taxableSum / 100).toFixed(2)).toBe(r.totals.taxable_amount);
    });

    it('discount is clamped to the subtotal', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '100.00', gst_rate: '18' }],
        taxTreatment: 'INTER_STATE',
        discountType: 'fixed',
        discountValue: '500.00',
      });
      expect(r.totals.discount_amount).toBe('100.00');
      expect(r.totals.total_amount).toBe('0.00');
    });
  });

  describe('computeInvoice — TDS / net receivable', () => {
    it('net_receivable = total − tds (tds on the taxable base)', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '10000.00', gst_rate: '18' }],
        taxTreatment: 'INTER_STATE',
        tdsRate: '10',
      });
      expect(r.totals.total_amount).toBe('11800.00');
      expect(r.totals.tds_amount).toBe('1000.00'); // 10% of 10,000 taxable
      expect(r.totals.net_receivable).toBe('10800.00');
    });
  });

  describe('rounding & precision', () => {
    it('uses paisa-exact integer math (no float drift)', () => {
      const r = computeInvoice({
        lines: [{ quantity: '3', rate: '33.33', gst_rate: '18' }],
        taxTreatment: 'INTER_STATE',
      });
      expect(r.totals.subtotal).toBe('99.99');
      expect(r.totals.igst_amount).toBe('18.00'); // 17.9982 → 18.00
      expect(r.totals.total_amount).toBe('117.99');
    });

    it('supports fractional quantities (NUMERIC(15,4))', () => {
      const r = computeInvoice({
        lines: [{ quantity: '2.5000', rate: '100.00', gst_rate: '5' }],
        taxTreatment: 'INTRA_STATE',
      });
      expect(r.totals.subtotal).toBe('250.00');
      expect(r.totals.cgst_amount).toBe('6.25');
      expect(r.totals.sgst_amount).toBe('6.25');
    });
  });

  describe('currency gate — INR=GST/TDS, non-INR=VAT (Sprint 11 §1 / Sprint 14)', () => {
    it('charges a single VAT line for a non-INR invoice (no CGST/SGST split, no cess, no TDS)', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '1000', gst_rate: '20', cess_rate: '2' }],
        taxTreatment: 'INTRA_STATE', // ignored for non-INR — no domestic split
        tdsRate: '10',
        currency: 'USD',
      });
      expect(r.totals.cgst_amount).toBe('0.00');
      expect(r.totals.sgst_amount).toBe('0.00');
      expect(r.totals.igst_amount).toBe('200.00'); // VAT 20% booked in the igst slot
      expect(r.totals.cess_amount).toBe('0.00'); // cess is India-only
      expect(r.totals.tds_amount).toBe('0.00'); // TDS is India-only
      expect(r.totals.total_amount).toBe('1200.00');
      expect(r.totals.net_receivable).toBe('1200.00');
    });

    it('keeps an INR EXPORT invoice zero-rated (LUT)', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '1000', gst_rate: '18' }],
        taxTreatment: 'EXPORT',
        currency: 'INR',
      });
      expect(r.totals.igst_amount).toBe('0.00');
      expect(r.totals.total_amount).toBe('1000.00');
    });

    it('still charges GST + TDS for an INR invoice', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '1000', gst_rate: '18' }],
        taxTreatment: 'INTER_STATE',
        tdsRate: '10',
        currency: 'INR',
      });
      expect(r.totals.igst_amount).toBe('180.00');
      expect(r.totals.tds_amount).toBe('100.00'); // 10% of taxable 1000
      expect(r.totals.net_receivable).toBe('1080.00'); // 1180 − 100
    });

    it('defaults to INR (domestic) when currency is omitted', () => {
      const r = computeInvoice({
        lines: [{ quantity: '1', rate: '1000', gst_rate: '18' }],
        taxTreatment: 'INTER_STATE',
      });
      expect(r.totals.igst_amount).toBe('180.00');
    });
  });
});
