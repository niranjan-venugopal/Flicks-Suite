import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, ilike, or, desc, sql, asc } from 'drizzle-orm';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  invoices,
  invoiceLineItems,
  invoicePayments,
  customerCreditBalance,
  customerCreditBalanceEntries,
  customers,
  tenants,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from './numbering.service';
import { computeInvoice, deriveTaxTreatment, type TaxTreatment } from './tax.util';
import { NotificationsService } from '../notifications/notifications.service';
import { OrgFinancialService } from '../org-financial/org-financial.service';
import type {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  InvoiceListQueryDto,
  RecordPaymentDto,
} from './dto/invoicing.dto';

/**
 * Invoices service (PRD §6.1–6.5).
 *
 * • Totals are ALWAYS computed server-side from the line items via the GST/TDS
 *   engine — client-sent amounts are never trusted.
 * • The invoice number is reserved atomically at creation (numbering FOR UPDATE
 *   inside the same tenant transaction).
 * • fx_rate_to_inr is snapshotted at creation: 1 for INR; other currencies get
 *   NULL until the FX source lands (Sprint 7) and is never re-floated (§6.10).
 * • Edits only in DRAFT (§6.5); lifecycle transitions are explicit endpoints.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly orgFinancial: OrgFinancialService,
  ) {}

  // ─── list / get ────────────────────────────────────────────────────────────

  async list(tenantId: string, query: InvoiceListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [eq(invoices.tenant_id, tenantId)];
    if (query.document_type)
      conditions.push(eq(invoices.document_type, query.document_type));
    if (query.status) conditions.push(eq(invoices.status, query.status));
    if (query.customer_id)
      conditions.push(eq(invoices.customer_id, query.customer_id));
    if (query.q) {
      const term = `%${query.q}%`;
      conditions.push(
        or(
          ilike(invoices.invoice_number, term),
          ilike(customers.display_name, term),
        )!,
      );
    }
    const where = and(...conditions);

    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: invoices.id,
          invoice_number: invoices.invoice_number,
          document_type: invoices.document_type,
          status: invoices.status,
          invoice_date: invoices.invoice_date,
          due_date: invoices.due_date,
          currency: invoices.currency,
          total_amount: invoices.total_amount,
          tds_amount: invoices.tds_amount,
          net_receivable: invoices.net_receivable,
          amount_paid: invoices.amount_paid,
          amount_outstanding: invoices.amount_outstanding,
          customer_id: invoices.customer_id,
          customer_name: customers.display_name,
          created_at: invoices.created_at,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customer_id, customers.id))
        .where(where)
        .orderBy(desc(invoices.created_at))
        .limit(limit)
        .offset(offset);
      const [{ total }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customer_id, customers.id))
        .where(where);
      return { data: rows, pagination: { page, limit, total: total ?? 0 } };
    });
  }

  async get(tenantId: string, id: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const inv = await this.fetch(tx, id);
      const lines = await tx
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoice_id, id))
        .orderBy(asc(invoiceLineItems.line_number));
      const [customer] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, inv.customer_id))
        .limit(1);
      return { data: { ...inv, line_items: lines, customer } };
    });
  }

  /**
   * Return the invoice's public-view token (the key for the hosted page that
   * the PDF renderer screenshots), minting + persisting one if absent. Lets the
   * authenticated "Download PDF" action reuse the exact hosted invoice page.
   */
  async ensurePublicToken(
    tenantId: string,
    id: string,
  ): Promise<{ token: string; invoiceNumber: string }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const [inv] = await tx
        .select({
          token: invoices.public_view_token,
          number: invoices.invoice_number,
        })
        .from(invoices)
        .where(and(eq(invoices.id, id), eq(invoices.tenant_id, tenantId)))
        .limit(1);
      if (!inv) throw new NotFoundException('Invoice not found');
      let token = inv.token;
      if (!token) {
        token = crypto.randomBytes(24).toString('base64url');
        await tx
          .update(invoices)
          .set({ public_view_token: token })
          .where(eq(invoices.id, id));
      }
      return { token, invoiceNumber: inv.number };
    });
  }

  // ─── create / update (DRAFT only) ─────────────────────────────────────────

  async create(dto: CreateInvoiceDto, userId: string, tenantId: string) {
    if (!dto.line_items?.length) {
      throw new BadRequestException('At least one line item is required');
    }
    this.assertDates(dto.invoice_date, dto.due_date);

    const created = await this.db.withTenant(tenantId, async (tx) => {
      const customer = await this.fetchCustomer(tx, dto.customer_id);
      const [tenant] = await tx
        .select({
          state_code: tenants.state_code,
          currency: tenants.currency,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const currency = dto.currency ?? customer.default_currency ?? tenant?.currency ?? 'INR';
      const treatment = (dto.tax_treatment as TaxTreatment | undefined) ??
        deriveTaxTreatment({
          supplierStateCode: tenant?.state_code,
          customerStateCode: customer.state_code,
          customerCountryCode: customer.country_code,
        });
      const computed = computeInvoice({
        lines: dto.line_items,
        taxTreatment: treatment,
        discountType: (dto.discount_type as 'percent' | 'fixed') ?? null,
        discountValue: dto.discount_value ?? null,
        tdsRate: dto.tds_rate ?? null,
        currency, // gates GST/TDS to INR (§6.1/§6.2)
      });

      // Quotes share the invoices table + lifecycle; they differ by
      // document_type and use the QUOTE numbering sequence.
      const docType = dto.document_type === 'QUOTE' ? 'QUOTE' : 'INVOICE';

      // Atomic number reservation inside this tenant transaction (§6.4).
      const reserved = await this.numbering.reserveNext(
        tx,
        tenantId,
        docType,
        dto.invoice_date,
      );

      // §8: bank account — explicit override → currency default → overall
      // default → first active → none.
      const bankAccountId = await this.orgFinancial.resolveForInvoice(
        tx,
        tenantId,
        currency,
        dto.bank_account_id,
      );

      const [inv] = await tx
        .insert(invoices)
        .values({
          tenant_id: tenantId,
          customer_id: customer.id,
          invoice_number: reserved.formatted,
          document_type: docType,
          status: 'DRAFT',
          invoice_date: dto.invoice_date,
          due_date: dto.due_date,
          reference: dto.reference,
          fy_label: reserved.fyLabel,
          currency,
          // §6.10: snapshot at creation; non-INR wired to the FX source in Sprint 7.
          fx_rate_to_inr: currency === 'INR' ? '1' : null,
          place_of_supply: dto.place_of_supply ?? customer.state_code,
          tax_treatment: treatment,
          discount_type: dto.discount_type,
          discount_value: dto.discount_value ?? '0',
          tds_section: dto.tds_section,
          tds_payment_code: dto.tds_payment_code,
          tds_rate: dto.tds_rate,
          notes: dto.notes,
          terms_and_conditions: dto.terms_and_conditions,
          bank_account_id: bankAccountId,
          ...computed.totals,
          amount_paid: '0',
          amount_outstanding: computed.totals.total_amount,
          created_by: userId,
          updated_by: userId,
        })
        .returning();

      await tx.insert(invoiceLineItems).values(
        dto.line_items.map((l, i) => ({
          tenant_id: tenantId,
          invoice_id: inv!.id,
          line_number: i + 1,
          item_id: l.item_id,
          item_name: l.item_name,
          description: l.description,
          hsn_sac_code: l.hsn_sac_code,
          quantity: l.quantity,
          unit: l.unit,
          rate: l.rate,
          gst_rate: l.gst_rate ?? '0',
          cess_rate: l.cess_rate ?? '0',
          ...computed.lines[i]!,
        })),
      );
      return inv!;
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.invoice.create',
      resourceType: 'invoice',
      resourceId: created.id,
      afterState: created as unknown as Record<string, unknown>,
    });
    return { data: created };
  }

  async update(
    id: string,
    dto: UpdateInvoiceDto,
    userId: string,
    tenantId: string,
  ) {
    const updated = await this.db.withTenant(tenantId, async (tx) => {
      const existing = await this.fetch(tx, id);
      if (existing.status !== 'DRAFT') {
        throw new BadRequestException(
          `Only DRAFT invoices can be edited (current status: ${existing.status})`,
        );
      }

      const customerId = dto.customer_id ?? existing.customer_id;
      const customer = await this.fetchCustomer(tx, customerId);
      const [tenant] = await tx
        .select({ state_code: tenants.state_code })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const invoiceDate = dto.invoice_date ?? existing.invoice_date;
      const dueDate = dto.due_date ?? existing.due_date;
      this.assertDates(invoiceDate, dueDate);

      // Recompute everything from the (possibly replaced) lines.
      const lines =
        dto.line_items ??
        (await tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoice_id, id))
          .orderBy(asc(invoiceLineItems.line_number)));
      if (!lines.length) {
        throw new BadRequestException('At least one line item is required');
      }

      const treatment = (dto.tax_treatment as TaxTreatment | undefined) ??
        deriveTaxTreatment({
          supplierStateCode: tenant?.state_code,
          customerStateCode: customer.state_code,
          customerCountryCode: customer.country_code,
        });
      const discountType =
        dto.discount_type !== undefined
          ? (dto.discount_type as 'percent' | 'fixed')
          : (existing.discount_type as 'percent' | 'fixed' | null);
      const discountValue =
        dto.discount_value !== undefined ? dto.discount_value : existing.discount_value;
      const tdsRate = dto.tds_rate !== undefined ? dto.tds_rate : existing.tds_rate;

      const computed = computeInvoice({
        lines: lines.map((l) => ({
          quantity: String(l.quantity),
          rate: String(l.rate),
          gst_rate: l.gst_rate != null ? String(l.gst_rate) : '0',
          cess_rate: l.cess_rate != null ? String(l.cess_rate) : '0',
        })),
        taxTreatment: treatment,
        discountType,
        discountValue,
        tdsRate,
        currency: dto.currency ?? existing.currency, // gates GST/TDS to INR
      });

      const newCurrency = dto.currency ?? existing.currency;
      // §8: re-resolve the bank account when the currency changed or an
      // explicit override was provided; otherwise keep the stored choice.
      const bankAccountId =
        dto.bank_account_id !== undefined || newCurrency !== existing.currency
          ? await this.orgFinancial.resolveForInvoice(
              tx,
              tenantId,
              newCurrency,
              dto.bank_account_id ?? null,
            )
          : existing.bank_account_id;

      const [inv] = await tx
        .update(invoices)
        .set({
          customer_id: customer.id,
          invoice_date: invoiceDate,
          due_date: dueDate,
          reference: dto.reference ?? existing.reference,
          currency: newCurrency,
          bank_account_id: bankAccountId,
          place_of_supply:
            dto.place_of_supply ?? existing.place_of_supply ?? customer.state_code,
          tax_treatment: treatment,
          discount_type: discountType,
          discount_value: discountValue ?? '0',
          tds_section: dto.tds_section ?? existing.tds_section,
          tds_payment_code: dto.tds_payment_code ?? existing.tds_payment_code,
          tds_rate: tdsRate,
          notes: dto.notes ?? existing.notes,
          terms_and_conditions:
            dto.terms_and_conditions ?? existing.terms_and_conditions,
          ...computed.totals,
          amount_outstanding: computed.totals.total_amount,
          updated_by: userId,
          updated_at: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();

      if (dto.line_items) {
        await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoice_id, id));
        await tx.insert(invoiceLineItems).values(
          dto.line_items.map((l, i) => ({
            tenant_id: tenantId,
            invoice_id: id,
            line_number: i + 1,
            item_id: l.item_id,
            item_name: l.item_name,
            description: l.description,
            hsn_sac_code: l.hsn_sac_code,
            quantity: l.quantity,
            unit: l.unit,
            rate: l.rate,
            gst_rate: l.gst_rate ?? '0',
            cess_rate: l.cess_rate ?? '0',
            ...computed.lines[i]!,
          })),
        );
      } else {
        // Lines unchanged but treatment/discount/TDS may have moved — refresh
        // the stored per-line tax columns.
        for (let i = 0; i < lines.length; i++) {
          await tx
            .update(invoiceLineItems)
            .set(computed.lines[i]!)
            .where(
              and(
                eq(invoiceLineItems.invoice_id, id),
                eq(invoiceLineItems.line_number, i + 1),
              ),
            );
        }
      }
      return inv!;
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.invoice.update',
      resourceType: 'invoice',
      resourceId: id,
      afterState: updated as unknown as Record<string, unknown>,
    });
    return { data: updated };
  }

  // ─── duplicate ─────────────────────────────────────────────────────────────

  async duplicate(id: string, userId: string, tenantId: string) {
    const source = await this.get(tenantId, id);
    const src = source.data;
    const today = new Date().toISOString().slice(0, 10);
    // New DRAFT, new number, today's dates, same content.
    return this.create(
      {
        customer_id: src.customer_id,
        invoice_date: today,
        due_date: src.due_date < today ? today : src.due_date,
        currency: src.currency,
        reference: src.reference ?? undefined,
        place_of_supply: src.place_of_supply ?? undefined,
        tax_treatment: src.tax_treatment ?? undefined,
        discount_type: src.discount_type ?? undefined,
        discount_value: src.discount_value ?? undefined,
        tds_section: src.tds_section ?? undefined,
        tds_payment_code: src.tds_payment_code ?? undefined,
        tds_rate: src.tds_rate ?? undefined,
        notes: src.notes ?? undefined,
        terms_and_conditions: src.terms_and_conditions ?? undefined,
        bank_account_id: src.bank_account_id ?? undefined,
        line_items: src.line_items.map((l) => ({
          item_id: l.item_id ?? undefined,
          item_name: l.item_name,
          description: l.description ?? undefined,
          hsn_sac_code: l.hsn_sac_code ?? undefined,
          quantity: String(l.quantity),
          unit: l.unit ?? undefined,
          rate: String(l.rate),
          gst_rate: l.gst_rate != null ? String(l.gst_rate) : undefined,
          cess_rate: l.cess_rate != null ? String(l.cess_rate) : undefined,
        })),
      },
      userId,
      tenantId,
    );
  }

  // ─── lifecycle transitions (§6.5) ─────────────────────────────────────────

  /** Cancel — auto-CN for GST invoices lands with credit notes in Sprint 6. */
  async cancel(id: string, reason: string | undefined, userId: string, tenantId: string) {
    const inv = await this.transition(
      tenantId,
      id,
      ['SENT', 'VIEWED', 'OVERDUE', 'DRAFT'],
      {
        status: 'CANCELLED',
        cancelled_at: new Date(),
        cancellation_reason: reason,
      },
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.invoice.cancel',
      resourceType: 'invoice',
      resourceId: id,
      metadata: { reason },
    });
    return { data: inv };
  }

  /** Void — within 24h of send and never viewed (§6.5). */
  async void(id: string, userId: string, tenantId: string) {
    const inv = await this.db.withTenant(tenantId, async (tx) => {
      const existing = await this.fetch(tx, id);
      if (!['SENT', 'DRAFT'].includes(existing.status)) {
        throw new BadRequestException(
          `Cannot void an invoice in status ${existing.status}`,
        );
      }
      if (existing.view_count && existing.view_count > 0) {
        throw new BadRequestException('Cannot void — the customer has viewed this invoice');
      }
      const anchor = existing.email_sent_at ?? existing.created_at;
      if (Date.now() - new Date(anchor).getTime() > 24 * 60 * 60 * 1000) {
        throw new BadRequestException('Cannot void — the 24-hour window has passed (cancel instead)');
      }
      const [row] = await tx
        .update(invoices)
        .set({ status: 'VOIDED', voided_at: new Date(), updated_by: userId, updated_at: new Date() })
        .where(eq(invoices.id, id))
        .returning();
      return row!;
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.invoice.void',
      resourceType: 'invoice',
      resourceId: id,
    });
    return { data: inv };
  }

  async writeOff(id: string, reason: string, userId: string, tenantId: string) {
    const inv = await this.transition(
      tenantId,
      id,
      ['SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID', 'DISPUTED'],
      {
        status: 'WRITE_OFF',
        write_off_at: new Date(),
        write_off_reason: reason,
      },
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.invoice.write_off',
      resourceType: 'invoice',
      resourceId: id,
      metadata: { reason },
    });
    return { data: inv };
  }

  /**
   * Convert a QUOTE into an INVOICE in place (§6.5). Promotes the document to
   * the INVOICE series with a freshly reserved invoice number and a DRAFT
   * status, keeping the line items. Only quotes that haven't been cancelled/
   * voided can convert.
   */
  async convertToInvoice(id: string, userId: string, tenantId: string) {
    const inv = await this.db.withTenant(tenantId, async (tx) => {
      const existing = await this.fetch(tx, id);
      if (existing.document_type !== 'QUOTE') {
        throw new BadRequestException('Only quotes can be converted to invoices');
      }
      if (['CANCELLED', 'VOIDED'].includes(existing.status)) {
        throw new BadRequestException(`Cannot convert a ${existing.status} quote`);
      }
      const reserved = await this.numbering.reserveNext(
        tx,
        tenantId,
        'INVOICE',
        existing.invoice_date,
      );
      const [row] = await tx
        .update(invoices)
        .set({
          document_type: 'INVOICE',
          invoice_number: reserved.formatted,
          fy_label: reserved.fyLabel,
          status: 'DRAFT',
          quote_number: existing.invoice_number, // keep the original quote ref
          updated_by: userId,
          updated_at: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();
      return row!;
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.quote.convert',
      resourceType: 'invoice',
      resourceId: id,
      afterState: { invoice_number: inv.invoice_number },
    });
    return { data: inv };
  }

  // ─── send (§6.6 / §9.3) ───────────────────────────────────────────────────

  /**
   * Send the invoice: DRAFT → SENT (re-send keeps SENT/VIEWED). Generates the
   * signed public token on first send and emails the customer a "View & Pay"
   * link to the hosted page — no PDF attachment by default (§9.3).
   */
  async send(id: string, userId: string, tenantId: string) {
    const result = await this.db.withTenant(tenantId, async (tx) => {
      const existing = await this.fetch(tx, id);
      if (!['DRAFT', 'SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID'].includes(existing.status)) {
        throw new BadRequestException(
          `Cannot send an invoice in status ${existing.status}`,
        );
      }
      const [customer] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, existing.customer_id))
        .limit(1);
      if (!customer?.email) {
        throw new BadRequestException(
          'The customer has no email address — add one before sending',
        );
      }
      const [tenant] = await tx
        .select({ name: tenants.name, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const token =
        existing.public_view_token ?? crypto.randomBytes(24).toString('base64url');
      const [updated] = await tx
        .update(invoices)
        .set({
          status: existing.status === 'DRAFT' ? 'SENT' : existing.status,
          public_view_token: token,
          customer_email_at_send: customer.email,
          email_sent_at: new Date(),
          updated_by: userId,
          updated_at: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();
      return { invoice: updated!, customer, tenant };
    });

    const base = this.config.get<string>(
      'PUBLIC_INVOICE_BASE_URL',
      this.config.get<string>('APP_URL', 'http://localhost:3000'),
    );
    const viewUrl = `${base}/inv/${result.invoice.public_view_token}`;

    await this.notifications.sendEmail('invoice-sent', result.customer.email!, {
      invoiceNumber: result.invoice.invoice_number,
      tenantName: result.tenant?.name,
      customerName: result.customer.display_name,
      amount: `${result.invoice.currency} ${result.invoice.total_amount}`,
      dueDate: result.invoice.due_date,
      viewUrl,
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.invoice.send',
      resourceType: 'invoice',
      resourceId: id,
      metadata: { to: result.customer.email, viewUrl },
    });
    return { data: result.invoice, meta: { public_url: viewUrl } };
  }

  // ─── payments (§6.6) ─────────────────────────────────────────────────────

  /**
   * Record a payment (manual or webhook-sourced). Updates amount_paid /
   * amount_outstanding, transitions PARTIALLY_PAID → PAID, and books any
   * overpayment into the customer credit balance (§6.6).
   */
  async recordPayment(
    id: string,
    dto: RecordPaymentDto,
    userId: string | null,
    tenantId: string,
    source: 'manual' | 'automatic_webhook' | 'subscription_charge' = 'manual',
  ) {
    const toCents = (v: string | null | undefined) =>
      Math.round(parseFloat(v ?? '0') * 100);
    const fromCents = (c: number) => (c / 100).toFixed(2);

    const result = await this.db.withTenant(tenantId, async (tx) => {
      const existing = await this.fetch(tx, id);
      if (!['SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID', 'DISPUTED'].includes(existing.status)) {
        throw new BadRequestException(
          `Cannot record a payment on a ${existing.status} invoice`,
        );
      }
      const amountCents = toCents(dto.amount);
      if (amountCents <= 0) {
        throw new BadRequestException('Payment amount must be positive');
      }

      // Sequential payment number per tenant (PMT-0001…).
      const [{ total: paymentCount }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(invoicePayments)
        .where(eq(invoicePayments.tenant_id, tenantId));
      const paymentNumber = `PMT-${String((paymentCount ?? 0) + 1).padStart(4, '0')}`;

      const [payment] = await tx
        .insert(invoicePayments)
        .values({
          tenant_id: tenantId,
          invoice_id: id,
          customer_id: existing.customer_id,
          payment_number: paymentNumber,
          payment_date: dto.payment_date ?? new Date().toISOString().slice(0, 10),
          amount: fromCents(amountCents),
          currency: existing.currency,
          payment_method: dto.payment_method,
          reference_number: dto.reference_number,
          razorpay_payment_id: dto.razorpay_payment_id,
          razorpay_order_id: dto.razorpay_order_id,
          notes: dto.notes,
          source,
          created_by: userId,
        })
        .returning();

      const totalCents = toCents(existing.total_amount);
      const paidBefore = toCents(existing.amount_paid);
      const paidAfter = paidBefore + amountCents;
      const applied = Math.min(paidAfter, totalCents);
      const overpaid = Math.max(0, paidAfter - totalCents);
      const outstanding = Math.max(0, totalCents - paidAfter);
      const fullyPaid = applied >= totalCents;

      const [updated] = await tx
        .update(invoices)
        .set({
          amount_paid: fromCents(applied),
          amount_outstanding: fromCents(outstanding),
          status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
          paid_at: fullyPaid ? new Date() : existing.paid_at,
          updated_at: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();

      // Overpayment → customer credit balance + append-only ledger entry.
      if (overpaid > 0) {
        const [balance] = await tx
          .select()
          .from(customerCreditBalance)
          .where(
            and(
              eq(customerCreditBalance.customer_id, existing.customer_id),
              eq(customerCreditBalance.currency, existing.currency),
            ),
          )
          .limit(1);
        if (balance) {
          await tx
            .update(customerCreditBalance)
            .set({
              balance_amount: fromCents(toCents(balance.balance_amount) + overpaid),
              updated_at: new Date(),
            })
            .where(eq(customerCreditBalance.id, balance.id));
        } else {
          await tx.insert(customerCreditBalance).values({
            tenant_id: tenantId,
            customer_id: existing.customer_id,
            balance_amount: fromCents(overpaid),
            currency: existing.currency,
          });
        }
        await tx.insert(customerCreditBalanceEntries).values({
          tenant_id: tenantId,
          customer_id: existing.customer_id,
          entry_date: new Date().toISOString().slice(0, 10),
          entry_type: 'overpayment',
          amount: fromCents(overpaid),
          currency: existing.currency,
          reference_type: 'invoice_payment',
          reference_id: payment!.id,
          description: `Overpayment on ${existing.invoice_number}`,
          created_by: userId,
        });
      }
      return { payment: payment!, invoice: updated!, overpaid: fromCents(overpaid) };
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId ?? undefined,
      action: 'invoicing.payment.record',
      resourceType: 'invoice_payment',
      resourceId: result.payment.id,
      metadata: {
        invoiceId: id,
        amount: dto.amount,
        method: dto.payment_method,
        source,
        overpaid: result.overpaid,
      },
    });
    return {
      data: result.payment,
      meta: { invoice_status: result.invoice.status, overpaid: result.overpaid },
    };
  }

  /** Tenant-wide payments ledger (prototype ScrPayments). */
  async listPayments(tenantId: string, query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 100);
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: invoicePayments.id,
          payment_number: invoicePayments.payment_number,
          payment_date: invoicePayments.payment_date,
          amount: invoicePayments.amount,
          currency: invoicePayments.currency,
          payment_method: invoicePayments.payment_method,
          reference_number: invoicePayments.reference_number,
          source: invoicePayments.source,
          invoice_id: invoicePayments.invoice_id,
          invoice_number: invoices.invoice_number,
          customer_name: customers.display_name,
        })
        .from(invoicePayments)
        .leftJoin(invoices, eq(invoicePayments.invoice_id, invoices.id))
        .leftJoin(customers, eq(invoicePayments.customer_id, customers.id))
        .where(eq(invoicePayments.tenant_id, tenantId))
        .orderBy(desc(invoicePayments.created_at))
        .limit(limit)
        .offset((page - 1) * limit);
      const [{ total }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(invoicePayments)
        .where(eq(invoicePayments.tenant_id, tenantId));
      return { data: rows, pagination: { page, limit, total: total ?? 0 } };
    });
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private async fetch(tx: Db, id: string) {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1);
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  private async fetchCustomer(tx: Db, customerId: string) {
    const [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  private assertDates(invoiceDate: string, dueDate: string) {
    if (dueDate < invoiceDate) {
      throw new BadRequestException('Due date cannot be before the invoice date');
    }
  }

  private async transition(
    tenantId: string,
    id: string,
    fromStatuses: string[],
    set: Record<string, unknown>,
  ) {
    return this.db.withTenant(tenantId, async (tx) => {
      const existing = await this.fetch(tx, id);
      if (!fromStatuses.includes(existing.status)) {
        throw new BadRequestException(
          `Cannot transition from ${existing.status} (allowed: ${fromStatuses.join(', ')})`,
        );
      }
      const [row] = await tx
        .update(invoices)
        .set({ ...set, updated_at: new Date() })
        .where(eq(invoices.id, id))
        .returning();
      return row!;
    });
  }
}
