import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, desc, sql } from 'drizzle-orm';
import {
  creditNotes,
  debitNotes,
  adjustments,
  invoices,
  customers,
  customerCreditBalance,
  customerCreditBalanceEntries,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from './numbering.service';
import type { CreateNoteDto, CreateAdjustmentDto } from './dto/invoicing.dto';

/**
 * Credit & debit notes + adjustments (PRD §6.7).
 *
 * Notes are GST CDNR documents with their own numbering series (CRN/DBN…,
 * reserved atomically like invoices). The prototype's NoteModal issues
 * directly, so creation lands as ISSUED. Issuing a credit note books the
 * amount into the customer's credit balance (§6.7); both kinds feed GSTR-1 9B.
 * Adjustments are non-document balance corrections, deletable within 24h.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
  ) {}

  // ─── list ────────────────────────────────────────────────────────────────

  async list(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const credit = await tx
        .select({
          id: creditNotes.id,
          number: creditNotes.credit_note_number,
          date: creditNotes.credit_note_date,
          reason: creditNotes.reason,
          status: creditNotes.status,
          currency: creditNotes.currency,
          total_amount: creditNotes.total_amount,
          customer_name: customers.display_name,
          invoice_number: invoices.invoice_number,
        })
        .from(creditNotes)
        .leftJoin(customers, eq(creditNotes.customer_id, customers.id))
        .leftJoin(invoices, eq(creditNotes.invoice_id, invoices.id))
        .where(eq(creditNotes.tenant_id, tenantId))
        .orderBy(desc(creditNotes.created_at));
      const debit = await tx
        .select({
          id: debitNotes.id,
          number: debitNotes.debit_note_number,
          date: debitNotes.debit_note_date,
          reason: debitNotes.reason,
          status: debitNotes.status,
          currency: debitNotes.currency,
          total_amount: debitNotes.total_amount,
          customer_name: customers.display_name,
          invoice_number: invoices.invoice_number,
        })
        .from(debitNotes)
        .leftJoin(customers, eq(debitNotes.customer_id, customers.id))
        .leftJoin(invoices, eq(debitNotes.invoice_id, invoices.id))
        .where(eq(debitNotes.tenant_id, tenantId))
        .orderBy(desc(debitNotes.created_at));
      return { data: { credit, debit } };
    });
  }

  // ─── create (issued immediately, per the prototype flow) ────────────────────

  async create(
    kind: 'credit' | 'debit',
    dto: CreateNoteDto,
    userId: string,
    tenantId: string,
  ) {
    const amountCents = Math.round(parseFloat(dto.amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new BadRequestException('Amount must be positive');
    }
    const today = new Date().toISOString().slice(0, 10);

    const created = await this.db.withTenant(tenantId, async (tx) => {
      // Resolve customer from the invoice when linked.
      let customerId = dto.customer_id ?? null;
      let invoice: typeof invoices.$inferSelect | undefined;
      if (dto.invoice_id) {
        [invoice] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, dto.invoice_id))
          .limit(1);
        if (!invoice) throw new NotFoundException('Invoice not found');
        customerId = invoice.customer_id;
      }
      if (!customerId) {
        throw new BadRequestException('Provide an invoice_id or a customer_id');
      }

      const reserved = await this.numbering.reserveNext(
        tx,
        tenantId,
        kind === 'credit' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
        today,
      );
      const amount = (amountCents / 100).toFixed(2);
      const currency = invoice?.currency ?? 'INR';

      if (kind === 'credit') {
        const [note] = await tx
          .insert(creditNotes)
          .values({
            tenant_id: tenantId,
            invoice_id: dto.invoice_id,
            customer_id: customerId,
            credit_note_number: reserved.formatted,
            fy_label: reserved.fyLabel,
            credit_note_date: today,
            reason: dto.reason,
            reason_description: dto.reason_description,
            status: 'ISSUED',
            currency,
            subtotal: amount,
            taxable_amount: amount,
            total_amount: amount,
            applied_to_balance: amount,
            issued_at: new Date(),
            created_by: userId,
          })
          .returning();

        // §6.7: issuing a credit note adjusts the customer's credit balance.
        await this.bumpCreditBalance(tx, tenantId, customerId, currency, amountCents, {
          entry_type: 'credit_note',
          reference_id: note!.id,
          description: `Credit note ${reserved.formatted}`,
          userId,
        });
        return note!;
      }

      const [note] = await tx
        .insert(debitNotes)
        .values({
          tenant_id: tenantId,
          invoice_id: dto.invoice_id,
          customer_id: customerId,
          debit_note_number: reserved.formatted,
          fy_label: reserved.fyLabel,
          debit_note_date: today,
          reason: dto.reason,
          reason_description: dto.reason_description,
          status: 'ISSUED',
          currency,
          subtotal: amount,
          taxable_amount: amount,
          total_amount: amount,
          issued_at: new Date(),
          created_by: userId,
        })
        .returning();
      return note!;
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: `invoicing.${kind}_note.issue`,
      resourceType: kind === 'credit' ? 'credit_note' : 'debit_note',
      resourceId: created.id,
      metadata: { amount: dto.amount, reason: dto.reason, invoiceId: dto.invoice_id },
    });
    return { data: created };
  }

  // ─── adjustments (§6.7 — non-document corrections) ─────────────────────────

  async listAdjustments(tenantId: string) {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select({
          id: adjustments.id,
          adjustment_date: adjustments.adjustment_date,
          amount: adjustments.amount,
          currency: adjustments.currency,
          type: adjustments.type,
          reason: adjustments.reason,
          created_at: adjustments.created_at,
          customer_name: customers.display_name,
          customer_id: adjustments.customer_id,
        })
        .from(adjustments)
        .leftJoin(customers, eq(adjustments.customer_id, customers.id))
        .where(eq(adjustments.tenant_id, tenantId))
        .orderBy(desc(adjustments.created_at)),
    );
    return { data: rows };
  }

  async createAdjustment(dto: CreateAdjustmentDto, userId: string, tenantId: string) {
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .insert(adjustments)
        .values({
          tenant_id: tenantId,
          customer_id: dto.customer_id,
          adjustment_date: dto.adjustment_date ?? new Date().toISOString().slice(0, 10),
          amount: dto.amount,
          currency: dto.currency ?? 'INR',
          type: dto.type,
          reason: dto.reason,
          created_by: userId,
        })
        .returning(),
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.adjustment.create',
      resourceType: 'adjustment',
      resourceId: row!.id,
      metadata: { amount: dto.amount, type: dto.type },
    });
    return { data: row };
  }

  /** Deletable only within 24h of creation (PRD §5); audit-logged. */
  async deleteAdjustment(id: string, userId: string, tenantId: string) {
    await this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(adjustments)
        .where(eq(adjustments.id, id))
        .limit(1);
      if (!row) throw new NotFoundException('Adjustment not found');
      if (Date.now() - new Date(row.created_at).getTime() > 24 * 60 * 60 * 1000) {
        throw new BadRequestException('Adjustments can only be deleted within 24 hours');
      }
      await tx.delete(adjustments).where(eq(adjustments.id, id));
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.adjustment.delete',
      resourceType: 'adjustment',
      resourceId: id,
    });
    return { data: { id } };
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async bumpCreditBalance(
    tx: Db,
    tenantId: string,
    customerId: string,
    currency: string,
    amountCents: number,
    opts: { entry_type: string; reference_id: string; description: string; userId: string },
  ) {
    const [balance] = await tx
      .select()
      .from(customerCreditBalance)
      .where(
        and(
          eq(customerCreditBalance.customer_id, customerId),
          eq(customerCreditBalance.currency, currency),
        ),
      )
      .limit(1);
    if (balance) {
      await tx
        .update(customerCreditBalance)
        .set({
          balance_amount: sql`${customerCreditBalance.balance_amount} + ${(amountCents / 100).toFixed(2)}::numeric`,
          updated_at: new Date(),
        })
        .where(eq(customerCreditBalance.id, balance.id));
    } else {
      await tx.insert(customerCreditBalance).values({
        tenant_id: tenantId,
        customer_id: customerId,
        balance_amount: (amountCents / 100).toFixed(2),
        currency,
      });
    }
    await tx.insert(customerCreditBalanceEntries).values({
      tenant_id: tenantId,
      customer_id: customerId,
      entry_date: new Date().toISOString().slice(0, 10),
      entry_type: opts.entry_type,
      amount: (amountCents / 100).toFixed(2),
      currency,
      reference_type: opts.entry_type,
      reference_id: opts.reference_id,
      description: opts.description,
      created_by: opts.userId,
    });
  }
}
