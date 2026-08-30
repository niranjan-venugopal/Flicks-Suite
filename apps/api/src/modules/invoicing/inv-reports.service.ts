import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { and, eq, gte, lte, inArray, notInArray, sql, desc, isNull } from 'drizzle-orm';
import {
  invoices,
  creditNotes,
  debitNotes,
  customers,
  gstr1Exports,
  form131Received,
  tenants,
  invoicingSettings,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import type { Db } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { GST_POS_OTHER_COUNTRY } from '@flicks/shared/constants';
import type { GenerateGstr1Dto } from './dto/invoicing.dto';

const OPEN_STATUSES = ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED'];
const NON_REVENUE = ['DRAFT', 'CANCELLED', 'VOIDED'];
// B2C large threshold (inter-state, unregistered customer) — prevailing ₹2.5L.
const B2CL_THRESHOLD_CENTS = 250000 * 100;

const toCents = (v: string | null | undefined) => Math.round(parseFloat(v ?? '0') * 100);
const money = (c: number) => (c / 100).toFixed(2);

/**
 * Invoicing reports (PRD §6.11): dashboard, receivables aging, revenue,
 * TDS receivable, GSTR-1 export (B2B/B2CL/B2CS/EXP/CDNR) and Form 131 tracking.
 * GSTR-1 files are returned inline + logged in gstr1_exports with a hash
 * (R2 storage_key joins when the bucket is wired).
 */
@Injectable()
export class InvReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ─── reports context (country + currency, for a global platform) ────────────

  /**
   * Drives the reports UI on a global platform: the tenant's country (gates the
   * India-only GST/TDS/GSTR-1 cards), its base currency, and the distinct
   * currencies actually present on its invoices (populates the currency
   * selector). All KPI endpoints are scoped to a single currency so totals are
   * never summed across currencies.
   */
  async reportsContext(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [tenant] = await tx
        .select({ countryCode: tenants.country_code, currency: tenants.currency })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const [settings] = await tx
        .select({ defaultCurrency: invoicingSettings.default_currency })
        .from(invoicingSettings)
        .where(eq(invoicingSettings.tenant_id, tenantId))
        .limit(1);
      const present = await tx
        .selectDistinct({ currency: invoices.currency })
        .from(invoices)
        .where(and(eq(invoices.tenant_id, tenantId), isNull(invoices.deleted_at)));

      const baseCurrency = settings?.defaultCurrency ?? tenant?.currency ?? 'INR';
      const currencies = Array.from(
        new Set([baseCurrency, ...present.map((p) => p.currency)]),
      );
      return {
        data: {
          countryCode: tenant?.countryCode ?? 'IN',
          baseCurrency,
          currencies,
        },
      };
    });
  }

  /** Tenant's base currency — used when a report request omits ?currency. */
  private async baseCurrency(tx: Db, tenantId: string): Promise<string> {
    const [settings] = await tx
      .select({ defaultCurrency: invoicingSettings.default_currency })
      .from(invoicingSettings)
      .where(eq(invoicingSettings.tenant_id, tenantId))
      .limit(1);
    if (settings?.defaultCurrency) return settings.defaultCurrency;
    const [tenant] = await tx
      .select({ currency: tenants.currency })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return tenant?.currency ?? 'INR';
  }

  /**
   * GST / GSTR-1 / TDS / Form-131 are India-domestic and only meaningful when
   * the workspace's BASE currency is INR. A company registered with a non-INR
   * base currency (e.g. USD) sees none of these (PRD: global platform).
   */
  private async assertGstEligible(tx: Db, tenantId: string): Promise<void> {
    const base = await this.baseCurrency(tx, tenantId);
    if (base !== 'INR') {
      throw new ForbiddenException(
        'GST / GSTR-1 / TDS reports are available only when the workspace base currency is INR',
      );
    }
  }

  // ─── dashboard / aging / revenue / tds ──────────────────────────────────────

  async dashboard(tenantId: string, currency?: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const cur = currency ?? (await this.baseCurrency(tx, tenantId));
      const [counts] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          open: sql<number>`count(*) filter (where ${invoices.status} in ('SENT','VIEWED','PARTIALLY_PAID','OVERDUE','DISPUTED'))::int`,
          overdue: sql<number>`count(*) filter (where ${invoices.status} = 'OVERDUE')::int`,
          paid: sql<number>`count(*) filter (where ${invoices.status} = 'PAID')::int`,
          outstanding: sql<string>`coalesce(sum(${invoices.amount_outstanding}) filter (where ${invoices.status} in ('SENT','VIEWED','PARTIALLY_PAID','OVERDUE','DISPUTED')), 0)::text`,
          collected: sql<string>`coalesce(sum(${invoices.amount_paid}), 0)::text`,
          tds: sql<string>`coalesce(sum(${invoices.tds_amount}) filter (where ${invoices.status} not in ('DRAFT','CANCELLED','VOIDED')), 0)::text`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenant_id, tenantId),
            eq(invoices.currency, cur),
            isNull(invoices.deleted_at),
          ),
        );
      return { data: { ...counts, currency: cur } };
    });
  }

  /** Receivables aging buckets: Current / 1–30 / 31–60 / 60+ (by due date). */
  async aging(tenantId: string, currency?: string) {
    const { rows, cur } = await this.db.withTenant(tenantId, async (tx) => {
      const cur = currency ?? (await this.baseCurrency(tx, tenantId));
      const rows = await tx
        .select({
          due_date: invoices.due_date,
          outstanding: invoices.amount_outstanding,
          currency: invoices.currency,
        })
        .from(invoices)
        .where(
          and(
            isNull(invoices.deleted_at),
            eq(invoices.tenant_id, tenantId),
            eq(invoices.currency, cur),
            inArray(invoices.status, OPEN_STATUSES),
          ),
        );
      return { rows, cur };
    });
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d60_plus: 0 };
    for (const r of rows) {
      const cents = toCents(r.outstanding);
      if (cents <= 0) continue;
      const overdueDays = Math.floor((today - new Date(`${r.due_date}T00:00:00Z`).getTime()) / 86400000);
      if (overdueDays <= 0) buckets.current += cents;
      else if (overdueDays <= 30) buckets.d1_30 += cents;
      else if (overdueDays <= 60) buckets.d31_60 += cents;
      else buckets.d60_plus += cents;
    }
    return {
      data: {
        currency: cur,
        buckets: [
          { bucket: 'Current', amount: money(buckets.current) },
          { bucket: '1–30 days', amount: money(buckets.d1_30) },
          { bucket: '31–60 days', amount: money(buckets.d31_60) },
          { bucket: '60+ days', amount: money(buckets.d60_plus) },
        ],
        total: money(buckets.current + buckets.d1_30 + buckets.d31_60 + buckets.d60_plus),
      },
    };
  }

  /** Monthly invoiced revenue for the trailing 6 months (non-draft/cancelled). */
  async revenue(tenantId: string, currency?: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const cur = currency ?? (await this.baseCurrency(tx, tenantId));
      const rows = await tx
        .select({
          month: sql<string>`to_char(date_trunc('month', ${invoices.invoice_date}::date), 'YYYY-MM')`,
          total: sql<string>`coalesce(sum(${invoices.total_amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .where(
          and(
            isNull(invoices.deleted_at),
            eq(invoices.tenant_id, tenantId),
            eq(invoices.currency, cur),
            notInArray(invoices.status, NON_REVENUE),
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1 desc`)
        .limit(6);
      return { data: rows, meta: { currency: cur } };
    });
  }

  /** TDS receivable: TDS withheld by customers on live invoices (§6.2). */
  async tdsReceivable(tenantId: string) {
    const rows = await this.db.withTenant(tenantId, async (tx) => {
      await this.assertGstEligible(tx, tenantId); // TDS is India-specific
      return tx
        .select({
          invoice_number: invoices.invoice_number,
          invoice_date: invoices.invoice_date,
          tds_section: invoices.tds_section,
          tds_rate: invoices.tds_rate,
          tds_amount: invoices.tds_amount,
          status: invoices.status,
          customer_name: customers.display_name,
          customer_id: invoices.customer_id,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customer_id, customers.id))
        .where(
          and(
            isNull(invoices.deleted_at),
            eq(invoices.tenant_id, tenantId),
            notInArray(invoices.status, NON_REVENUE),
            sql`${invoices.tds_amount} > 0`,
          ),
        )
        .orderBy(desc(invoices.invoice_date));
    });
    const total = rows.reduce((a, r) => a + toCents(r.tds_amount), 0);
    return { data: rows, meta: { total: money(total), count: rows.length } };
  }

  // ─── GSTR-1 (§6.11) ────────────────────────────────────────────────────────

  async generateGstr1(dto: GenerateGstr1Dto, userId: string, tenantId: string) {
    const month = dto.period_month;
    const year = dto.period_year;
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    const result = await this.db.withTenant(tenantId, async (tx) => {
      await this.assertGstEligible(tx, tenantId); // GSTR-1 is an India GST return
      const invs = await tx
        .select({
          invoice_number: invoices.invoice_number,
          invoice_date: invoices.invoice_date,
          currency: invoices.currency,
          taxable_amount: invoices.taxable_amount,
          cgst_amount: invoices.cgst_amount,
          sgst_amount: invoices.sgst_amount,
          igst_amount: invoices.igst_amount,
          cess_amount: invoices.cess_amount,
          total_amount: invoices.total_amount,
          tax_treatment: invoices.tax_treatment,
          place_of_supply: invoices.place_of_supply,
          fx_rate_to_inr: invoices.fx_rate_to_inr,
          export_route: invoices.export_route,
          customer_name: customers.display_name,
          customer_gstin: customers.gstin,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customer_id, customers.id))
        .where(
          and(
            isNull(invoices.deleted_at),
            eq(invoices.tenant_id, tenantId),
            notInArray(invoices.status, NON_REVENUE),
            gte(invoices.invoice_date, from),
            lte(invoices.invoice_date, to),
          ),
        );

      const cdnrCredit = await tx
        .select({
          number: creditNotes.credit_note_number,
          date: creditNotes.credit_note_date,
          taxable: creditNotes.taxable_amount,
          total: creditNotes.total_amount,
          customer_gstin: customers.gstin,
          customer_name: customers.display_name,
        })
        .from(creditNotes)
        .leftJoin(customers, eq(creditNotes.customer_id, customers.id))
        .where(
          and(
            eq(creditNotes.tenant_id, tenantId),
            eq(creditNotes.status, 'ISSUED'),
            gte(creditNotes.credit_note_date, from),
            lte(creditNotes.credit_note_date, to),
          ),
        );
      const cdnrDebit = await tx
        .select({
          number: debitNotes.debit_note_number,
          date: debitNotes.debit_note_date,
          taxable: debitNotes.taxable_amount,
          total: debitNotes.total_amount,
          customer_gstin: customers.gstin,
          customer_name: customers.display_name,
        })
        .from(debitNotes)
        .leftJoin(customers, eq(debitNotes.customer_id, customers.id))
        .where(
          and(
            eq(debitNotes.tenant_id, tenantId),
            eq(debitNotes.status, 'ISSUED'),
            gte(debitNotes.debit_note_date, from),
            lte(debitNotes.debit_note_date, to),
          ),
        );

      // Bucket per §6.11: B2B (registered), EXP, then B2CL (inter-state >
      // threshold) vs B2CS.
      type Inv = (typeof invs)[number];
      const b2b: Inv[] = [];
      const b2cl: Inv[] = [];
      const b2cs: Inv[] = [];
      const exp: Inv[] = [];
      for (const inv of invs) {
        if (inv.tax_treatment === 'EXPORT') exp.push(inv);
        else if (inv.customer_gstin) b2b.push(inv);
        else if (inv.tax_treatment === 'INTER_STATE' && toCents(inv.total_amount) > B2CL_THRESHOLD_CENTS)
          b2cl.push(inv);
        else b2cs.push(inv);
      }

      const sumTaxable = (arr: Inv[]) => arr.reduce((a, i) => a + toCents(i.taxable_amount), 0);
      const sumTax = (arr: Inv[]) =>
        arr.reduce(
          (a, i) =>
            a + toCents(i.cgst_amount) + toCents(i.sgst_amount) + toCents(i.igst_amount) + toCents(i.cess_amount),
          0,
        );

      const payload = {
        gstr1: {
          period: `${String(month).padStart(2, '0')}${year}`,
          generated_at: new Date().toISOString(),
          b2b: b2b.map((i) => ({ ...i })),
          b2cl: b2cl.map((i) => ({ ...i })),
          b2cs: b2cs.map((i) => ({ ...i })),
          // Direct exports report the recipient as 'URP' (unregistered
          // person) with place-of-supply code 96 ("Other Country") — the
          // statutory convention; a foreign client has no GSTIN.
          exp: exp.map((i) => ({
            ...i,
            customer_gstin: 'URP',
            place_of_supply: GST_POS_OTHER_COUNTRY,
            export_route: i.export_route ?? 'LUT',
          })),
          cdnr: [
            ...cdnrCredit.map((n) => ({ kind: 'C', ...n })),
            ...cdnrDebit.map((n) => ({ kind: 'D', ...n })),
          ],
        },
      };
      const json = JSON.stringify(payload, null, 2);
      const hash = crypto.createHash('sha256').update(json).digest('hex');

      const [log] = await tx
        .insert(gstr1Exports)
        .values({
          tenant_id: tenantId,
          fy_label: month >= 4 ? `${String(year).slice(2)}-${String(year + 1).slice(2)}` : `${String(year - 1).slice(2)}-${String(year).slice(2)}`,
          period_month: month,
          period_year: year,
          format: dto.format ?? 'json',
          storage_key: null, // R2 upload joins when the bucket is configured
          file_hash: hash,
          invoice_count: invs.length,
          total_taxable_value: money(sumTaxable(invs)),
          total_tax: money(sumTax(invs)),
          b2b_count: b2b.length,
          b2cl_count: b2cl.length,
          b2cs_count: b2cs.length,
          export_count: exp.length,
          cdnr_count: cdnrCredit.length + cdnrDebit.length,
          generated_by: userId,
        })
        .returning();

      return {
        export: log!,
        payload,
        summary: {
          b2b: { count: b2b.length, taxable: money(sumTaxable(b2b)), tax: money(sumTax(b2b)) },
          b2cl: { count: b2cl.length, taxable: money(sumTaxable(b2cl)), tax: money(sumTax(b2cl)) },
          b2cs: { count: b2cs.length, taxable: money(sumTaxable(b2cs)), tax: money(sumTax(b2cs)) },
          exp: { count: exp.length, taxable: money(sumTaxable(exp)), tax: money(sumTax(exp)) },
          cdnr: {
            count: cdnrCredit.length + cdnrDebit.length,
            taxable: money(
              -cdnrCredit.reduce((a, n) => a + toCents(n.taxable), 0) +
                cdnrDebit.reduce((a, n) => a + toCents(n.taxable), 0),
            ),
          },
        },
      };
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.gstr1.generate',
      resourceType: 'gstr1_export',
      resourceId: result.export.id,
      metadata: { period: `${month}/${year}`, hash: result.export.file_hash ?? undefined },
    });
    return { data: result };
  }

  async gstr1History(tenantId: string) {
    const rows = await this.db.withTenant(tenantId, async (tx) => {
      await this.assertGstEligible(tx, tenantId);
      return tx
        .select()
        .from(gstr1Exports)
        .where(eq(gstr1Exports.tenant_id, tenantId))
        .orderBy(desc(gstr1Exports.created_at))
        .limit(24);
    });
    return { data: rows };
  }

  // ─── Form 131 tracking (§6.11) ─────────────────────────────────────────────

  /** Per customer × FY quarter: expected TDS vs whether Form 131 arrived. */
  async form131Tracking(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      await this.assertGstEligible(tx, tenantId); // Form 131 is India FY-quarter TDS
      // Expected TDS from live invoices, grouped into Indian FY quarters
      // (Q1 = Apr–Jun … Q4 = Jan–Mar).
      const expected = await tx
        .select({
          customer_id: invoices.customer_id,
          customer_name: customers.display_name,
          quarter: sql<number>`(case when extract(month from ${invoices.invoice_date}::date) >= 4
            then floor((extract(month from ${invoices.invoice_date}::date) - 4) / 3) + 1
            else 4 end)::int`,
          fy_label: sql<string>`case when extract(month from ${invoices.invoice_date}::date) >= 4
            then to_char(${invoices.invoice_date}::date, 'YY') || '-' || to_char((${invoices.invoice_date}::date + interval '1 year'), 'YY')
            else to_char((${invoices.invoice_date}::date - interval '1 year'), 'YY') || '-' || to_char(${invoices.invoice_date}::date, 'YY') end`,
          total_tds: sql<string>`coalesce(sum(${invoices.tds_amount}), 0)::text`,
          invoice_count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customer_id, customers.id))
        .where(
          and(
            eq(invoices.tenant_id, tenantId),
            notInArray(invoices.status, NON_REVENUE),
            sql`${invoices.tds_amount} > 0`,
          ),
        )
        .groupBy(invoices.customer_id, customers.display_name, sql`3`, sql`4`);

      const received = await tx
        .select()
        .from(form131Received)
        .where(eq(form131Received.tenant_id, tenantId));
      const recvKey = (r: { customer_id: string; fy_label: string; quarter: number }) =>
        `${r.customer_id}|${r.fy_label}|${r.quarter}`;
      const receivedMap = new Map(received.map((r) => [recvKey(r), r]));

      return {
        data: expected.map((e) => {
          const match = receivedMap.get(recvKey(e));
          return {
            ...e,
            received: match?.form_131_received ?? false,
            received_date: match?.form_131_received_date ?? null,
            tracking_id: match?.id ?? null,
          };
        }),
      };
    });
  }

  async markForm131Received(
    body: { customer_id: string; fy_label: string; quarter: number; total_tds_amount?: string },
    userId: string,
    tenantId: string,
  ) {
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .insert(form131Received)
        .values({
          tenant_id: tenantId,
          customer_id: body.customer_id,
          fy_label: body.fy_label,
          quarter: body.quarter,
          total_tds_amount: body.total_tds_amount ?? '0',
          form_131_received: true,
          form_131_received_date: new Date().toISOString().slice(0, 10),
        })
        .onConflictDoUpdate({
          target: [
            form131Received.tenant_id,
            form131Received.customer_id,
            form131Received.fy_label,
            form131Received.quarter,
          ],
          set: {
            form_131_received: true,
            form_131_received_date: new Date().toISOString().slice(0, 10),
            updated_at: new Date(),
          },
        })
        .returning(),
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.form131.mark_received',
      resourceType: 'form_131_received',
      resourceId: row!.id,
    });
    return { data: row };
  }
}
