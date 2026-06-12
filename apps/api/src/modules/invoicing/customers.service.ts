import {
  Injectable,
  NotFoundException,
  ConflictException,
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

  async create(dto: CreateCustomerDto, userId: string, tenantId: string) {
    const code = dto.customer_code?.trim() || (await this.nextCode(tenantId));
    try {
      const created = await this.db.withTenant(tenantId, (tx) =>
        tx
          .insert(customers)
          .values({
            ...dto,
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
    const updated = await this.db.withTenant(tenantId, (tx) =>
      tx
        .update(customers)
        .set({ ...dto, updated_by: userId, updated_at: new Date() })
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
  private async nextCode(tenantId: string): Promise<string> {
    const [{ total }] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(customers)
        .where(eq(customers.tenant_id, tenantId)),
    );
    return `CUST-${String((total ?? 0) + 1).padStart(4, '0')}`;
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
