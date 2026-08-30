import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, ilike, or, isNull, desc, sql, notInArray } from 'drizzle-orm';
import {
  customers,
  invoices,
  invoicePayments,
  creditNotes,
  debitNotes,
  adjustments,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type {
  ListQueryDto,
  CreateCustomerDto,
  UpdateCustomerDto,
  ImportCustomersDto,
} from './dto/invoicing.dto';

/**
 * Customers service (PRD §5). Tenant-scoped via withTenant (RLS enforced);
 * every mutation writes an audit-log row. Soft-delete via deleted_at; archive
 * via status.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, query: ListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [
      eq(customers.tenant_id, tenantId),
      isNull(customers.deleted_at),
    ];
    if (query.status) conditions.push(eq(customers.status, query.status));
    if (query.q) {
      const term = `%${query.q}%`;
      conditions.push(
        or(
          ilike(customers.display_name, term),
          ilike(customers.customer_code, term),
          ilike(customers.email, term),
        )!,
      );
    }
    const where = and(...conditions);

    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(customers)
        .where(where)
        .orderBy(desc(customers.created_at))
        .limit(limit)
        .offset(offset);
      const [{ total }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(customers)
        .where(where);
      return { data: rows, pagination: { page, limit, total: total ?? 0 } };
    });
  }

  async get(tenantId: string, id: string) {
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), isNull(customers.deleted_at)))
        .limit(1),
    );
    if (!row[0]) throw new NotFoundException('Customer not found');
    return { data: row[0] };
  }

  /**
   * '' is how the forms say "clear this" — store NULL rather than an empty
   * string so `IS NOT NULL` checks and idx_customers_gstin stay honest.
   */
  private normalizePatch<T extends CreateCustomerDto | UpdateCustomerDto>(
    dto: T,
  ): T {
    const BLANKABLE = [
      'gstin',
      'pan',
      'intl_tax_id',
      'state_code',
      'billing_address_line1',
      'billing_address_line2',
      'billing_city',
      'billing_state',
      'billing_postal_code',
      'billing_country',
    ] as const;
    const out: Record<string, unknown> = { ...dto };
    for (const k of BLANKABLE) {
      if (typeof out[k] === 'string' && (out[k] as string).trim() === '')
        out[k] = null;
    }
    return out as T;
  }

  /**
   * A client outside India has no GSTIN — that supply is an export of
   * services, zero-rated, and a GSTIN on it would corrupt the GSTR-1 bucket.
   * Checked against the MERGED state so a PATCH that only flips the country
   * can't leave a stale GSTIN behind.
   */
  private assertTaxIdsMatchCountry(merged: {
    country_code?: string | null;
    gstin?: string | null;
    pan?: string | null;
  }) {
    const country = (merged.country_code ?? 'IN').toUpperCase();
    if (country !== 'IN' && merged.gstin) {
      throw new BadRequestException(
        'A client outside India cannot have a GSTIN — clear it, or set the country to India.',
      );
    }
  }

  async create(dto: CreateCustomerDto, userId: string, tenantId: string) {
    const code = dto.customer_code?.trim() || (await this.nextCode(tenantId));
    const patch = this.normalizePatch(dto);
    this.assertTaxIdsMatchCountry(patch);
    try {
      const created = await this.db.withTenant(tenantId, (tx) =>
        tx
          .insert(customers)
          .values({
            ...patch,
            // Only an Indian client can be GST-registered.
            is_gst_registered:
              (patch.country_code ?? 'IN').toUpperCase() === 'IN'
                ? !!patch.gstin
                : false,
            tenant_id: tenantId,
            customer_code: code,
            created_by: userId,
            updated_by: userId,
          })
          .returning(),
      );
      const customer = created[0]!;
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        action: 'invoicing.customer.create',
        resourceType: 'customer',
        resourceId: customer.id,
        afterState: customer as unknown as Record<string, unknown>,
      });
      return { data: customer };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Customer code "${code}" already in use`);
      }
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
    userId: string,
    tenantId: string,
  ) {
    const existing = (await this.get(tenantId, id)).data;
    const patch = this.normalizePatch(dto);
    // Only an EXPLICIT gstin in this patch is an error. Moving an existing
    // Indian client abroad is a legitimate edit — the stale GSTIN is cleared
    // below rather than thrown back at the user (never leave a dead end).
    this.assertTaxIdsMatchCountry({
      country_code:
        patch.country_code !== undefined
          ? patch.country_code
          : existing.country_code,
      gstin: patch.gstin ?? null,
    });
    const mergedCountry = (
      (patch.country_code !== undefined
        ? patch.country_code
        : existing.country_code) ?? 'IN'
    ).toUpperCase();
    const updated = await this.db.withTenant(tenantId, (tx) =>
      tx
        .update(customers)
        .set({
          ...patch,
          ...(mergedCountry === 'IN'
            ? {}
            : { is_gst_registered: false, gstin: null }),
          updated_by: userId,
          updated_at: new Date(),
        })
        .where(eq(customers.id, id))
        .returning(),
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.customer.update',
      resourceType: 'customer',
      resourceId: id,
      beforeState: existing as unknown as Record<string, unknown>,
      afterState: updated[0] as unknown as Record<string, unknown>,
    });
    return { data: updated[0] };
  }

  async setStatus(
    id: string,
    status: 'active' | 'archived',
    userId: string,
    tenantId: string,
  ) {
    await this.get(tenantId, id); // 404 if missing
    const updated = await this.db.withTenant(tenantId, (tx) =>
      tx
        .update(customers)
        .set({ status, updated_by: userId, updated_at: new Date() })
        .where(eq(customers.id, id))
        .returning(),
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: `invoicing.customer.${status === 'archived' ? 'archive' : 'unarchive'}`,
      resourceType: 'customer',
      resourceId: id,
    });
    return { data: updated[0] };
  }

  async importRows(dto: ImportCustomersDto, userId: string, tenantId: string) {
    const results: { row: number; ok: boolean; id?: string; error?: string }[] =
      [];
    for (let i = 0; i < dto.rows.length; i++) {
      try {
        const created = await this.create(dto.rows[i]!, userId, tenantId);
        results.push({ row: i, ok: true, id: created.data.id });
      } catch (err) {
        results.push({
          row: i,
          ok: false,
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
    return {
      data: results,
      meta: {
        total: results.length,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      },
    };
  }

  async exportAll(tenantId: string) {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(customers)
        .where(
          and(eq(customers.tenant_id, tenantId), isNull(customers.deleted_at)),
        )
        .orderBy(desc(customers.created_at)),
    );
    return { data: rows, meta: { total: rows.length } };
  }

  /**
   * Customer statement / ledger (PRD §5, §6.7): every financial event against
   * the customer in date order with a running balance — invoices issued (+),
   * payments (−), credit notes (−), debit notes (+), adjustments (±).
   */
  async statement(tenantId: string, id: string) {
    const customer = (await this.get(tenantId, id)).data;
    const cents = (v: string | null | undefined) => Math.round(parseFloat(v ?? '0') * 100);
    const money = (c: number) => (c / 100).toFixed(2);

    const lines = await this.db.withTenant(tenantId, async (tx) => {
      const invs = await tx
        .select({
          date: invoices.invoice_date,
          ref: invoices.invoice_number,
          amount: invoices.total_amount,
          status: invoices.status,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.customer_id, id),
            notInArray(invoices.status, ['DRAFT', 'CANCELLED', 'VOIDED']),
          ),
        );
      const pays = await tx
        .select({
          date: invoicePayments.payment_date,
          ref: invoicePayments.payment_number,
          amount: invoicePayments.amount,
          method: invoicePayments.payment_method,
        })
        .from(invoicePayments)
        .where(eq(invoicePayments.customer_id, id));
      const crns = await tx
        .select({ date: creditNotes.credit_note_date, ref: creditNotes.credit_note_number, amount: creditNotes.total_amount })
        .from(creditNotes)
        .where(and(eq(creditNotes.customer_id, id), eq(creditNotes.status, 'ISSUED')));
      const dbns = await tx
        .select({ date: debitNotes.debit_note_date, ref: debitNotes.debit_note_number, amount: debitNotes.total_amount })
        .from(debitNotes)
        .where(and(eq(debitNotes.customer_id, id), eq(debitNotes.status, 'ISSUED')));
      const adjs = await tx
        .select({ date: adjustments.adjustment_date, ref: adjustments.type, amount: adjustments.amount, reason: adjustments.reason })
        .from(adjustments)
        .where(eq(adjustments.customer_id, id));

      const all = [
        ...invs.map((r) => ({ date: r.date, type: 'invoice', ref: r.ref, debit: cents(r.amount), credit: 0, detail: r.status })),
        ...pays.map((r) => ({ date: r.date, type: 'payment', ref: r.ref, debit: 0, credit: cents(r.amount), detail: r.method })),
        ...crns.map((r) => ({ date: r.date, type: 'credit_note', ref: r.ref, debit: 0, credit: cents(r.amount), detail: 'credit note' })),
        ...dbns.map((r) => ({ date: r.date, type: 'debit_note', ref: r.ref, debit: cents(r.amount), credit: 0, detail: 'debit note' })),
        ...adjs.map((r) => {
          const c = cents(r.amount);
          return {
            date: r.date,
            type: 'adjustment',
            ref: r.ref,
            debit: c > 0 ? c : 0,
            credit: c < 0 ? -c : 0,
            detail: r.reason ?? 'adjustment',
          };
        }),
      ].sort((a, b) => a.date.localeCompare(b.date));

      let balance = 0;
      return all.map((l) => {
        balance += l.debit - l.credit;
        return {
          ...l,
          debit: l.debit ? money(l.debit) : null,
          credit: l.credit ? money(l.credit) : null,
          balance: money(balance),
        };
      });
    });

    return {
      data: {
        customer,
        opening_balance: '0.00',
        lines,
        closing_balance: lines.length ? lines[lines.length - 1]!.balance : '0.00',
      },
    };
  }

  /** Next sequential customer code (CUST-0001…). */
  /**
   * Next CUST-#### code. Derived from the highest existing suffix, NOT from
   * count(*): once a client can be deleted, counting rows hands out a code
   * that already exists (delete the 3rd of 5 → next is CUST-0005 → 409 on the
   * very next "Add client"). Soft-deleted rows are included so a restored
   * client never collides either.
   *
   * NB: the pattern lives in a template literal, so the backslash must be
   * escaped — '\\d' here reaches Postgres as '\d'. Writing '\d' compiles to
   * a bare 'd', the regex never matches, and every client gets CUST-0001.
   */
  private async nextCode(tenantId: string): Promise<string> {
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select({
          maxSeq: sql<number>`COALESCE(MAX((regexp_match(${customers.customer_code}, '^CUST-(\\d+)$'))[1]::int), 0)`,
        })
        .from(customers)
        .where(eq(customers.tenant_id, tenantId)),
    );
    return `CUST-${String((row?.maxSeq ?? 0) + 1).padStart(4, '0')}`;
  }

  /**
   * Delete a client. Hard when nothing references it (so a mistyped test
   * client really goes away); soft otherwise, because invoices.customer_id is
   * NOT NULL + RESTRICT — a billed client must keep resolving on its past
   * documents. Returns which happened so the UI can say so.
   */
  async remove(id: string, userId: string, tenantId: string) {
    const outcome = await this.db.withTenant(tenantId, async (tx) => {
      const [existing] = await tx
        .select({ id: customers.id, name: customers.display_name })
        .from(customers)
        .where(and(eq(customers.id, id), isNull(customers.deleted_at)))
        .limit(1);
      if (!existing) throw new NotFoundException('Client not found');

      // Everything that RESTRICTs on customers.id — a hard delete would raise
      // 23503 for any of these.
      const [invCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoices)
        .where(eq(invoices.customer_id, id));
      const [payCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoicePayments)
        .where(eq(invoicePayments.customer_id, id));
      const [cnCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(creditNotes)
        .where(eq(creditNotes.customer_id, id));
      const [dnCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(debitNotes)
        .where(eq(debitNotes.customer_id, id));
      const [adjCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(adjustments)
        .where(eq(adjustments.customer_id, id));
      const references = {
        invoices: invCount?.n ?? 0,
        payments: payCount?.n ?? 0,
        creditNotes: cnCount?.n ?? 0,
        debitNotes: dnCount?.n ?? 0,
        adjustments: adjCount?.n ?? 0,
      };
      const total = Object.values(references).reduce((a, b) => a + b, 0);

      if (total === 0) {
        await tx.delete(customers).where(eq(customers.id, id));
        return { mode: 'hard' as const, name: existing.name, references };
      }
      await tx
        .update(customers)
        .set({ deleted_at: new Date(), updated_by: userId, updated_at: new Date() })
        .where(eq(customers.id, id));
      return { mode: 'soft' as const, name: existing.name, references };
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.customer.delete',
      resourceType: 'customer',
      resourceId: id,
      afterState: { mode: outcome.mode, references: outcome.references },
    });
    return {
      data: {
        deleted: true,
        mode: outcome.mode,
        references: outcome.references,
      },
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
