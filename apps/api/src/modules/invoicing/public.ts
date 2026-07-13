import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import { customers, deals, invoices } from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { CustomersService } from './customers.service';
import { InvoicesService } from './invoices.service';
import { ItemsService } from './items.service';

/**
 * Invoicing public facade (PRD v5 §2.3). The ONLY surface other modules (CRM)
 * may consume from Invoicing — never its internal services directly. Keeps the
 * suite hooks (deal→invoice) inside one Postgres transaction on the shared DB.
 */
export interface DraftInvoiceLine {
  item_id?: string;
  item_name: string;
  quantity: string;
  rate: string;
  gst_rate?: string;
  hsn_sac_code?: string;
}

@Injectable()
export class InvoicingPublicService {
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly db: DatabaseService,
    private readonly customers: CustomersService,
    private readonly invoices: InvoicesService,
    private readonly items: ItemsService,
  ) {}

  /** Find the invoicing customer linked to a directory company/person, if any. */
  async findCustomerByDirectoryRef(
    tenantId: string,
    ref: { companyId?: string | null; personId?: string | null },
  ) {
    if (!ref.companyId && !ref.personId) return null;
    return this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(customers)
        .where(
          and(
            isNull(customers.deleted_at),
            or(
              ref.companyId ? eq(customers.directory_company_id, ref.companyId) : undefined,
              ref.personId ? eq(customers.directory_person_id, ref.personId) : undefined,
            ),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  /** Create a billing customer from directory data, linking it back. */
  async createCustomerFromDirectory(
    tenantId: string,
    userId: string,
    data: {
      display_name: string;
      customer_type?: 'business' | 'individual';
      email?: string | null;
      phone?: string | null;
      country_code?: string | null;
      directory_company_id?: string | null;
      directory_person_id?: string | null;
    },
  ) {
    const created = await this.customers.create(
      {
        display_name: data.display_name,
        customer_type: data.customer_type ?? 'business',
        email: data.email ?? undefined,
        phone: data.phone ?? undefined,
        country_code: data.country_code ?? undefined,
      } as never,
      userId,
      tenantId,
    );
    // Link back to the directory record (service-role, tenant-scoped by id).
    await this.dbAdmin
      .update(customers)
      .set({
        directory_company_id: data.directory_company_id ?? null,
        directory_person_id: data.directory_person_id ?? null,
      })
      .where(and(eq(customers.id, created.data.id), eq(customers.tenant_id, tenantId)));
    return created.data;
  }

  /** Catalogue items for deal-product pickers. */
  listItems(tenantId: string, q?: string) {
    return this.items.list(tenantId, { q, limit: 50 } as never);
  }

  /**
   * Resolve an invoice's id + customer by id, tenant-scoped (RLS). Used by the
   * deal→invoice idempotency guard so a repeat call returns the existing draft
   * rather than minting a duplicate. Returns null if the id resolves to nothing
   * (stale back-link) so the caller can re-create. Invoices are not hard-deleted
   * — they carry a status lifecycle — so any surviving row counts.
   */
  async getInvoiceRef(
    tenantId: string,
    invoiceId: string,
  ): Promise<{ id: string; customer_id: string } | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ id: invoices.id, customer_id: invoices.customer_id })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Claim the deal back-link for a freshly minted document. The partial unique
   * index uq_invoices_deal_doc (tenant, deal, document_type) makes the claim
   * atomic: if a concurrent request won the race, our UPDATE hits a unique
   * violation — we then delete our orphaned draft and return the winner, so a
   * double-submit converges on ONE document instead of leaving clutter.
   */
  private async claimDealBackLink(
    tenantId: string,
    dealId: string,
    createdId: string,
    documentType: 'INVOICE' | 'QUOTE',
  ): Promise<{ winnerId: string }> {
    try {
      await this.dbAdmin
        .update(invoices)
        .set({ deal_id: dealId })
        .where(and(eq(invoices.id, createdId), eq(invoices.tenant_id, tenantId)));
      return { winnerId: createdId };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== '23505') throw err;
      // Lost the race: fetch the winner, discard our orphan draft.
      const [winner] = await this.dbAdmin
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenant_id, tenantId),
            eq(invoices.deal_id, dealId),
            eq(invoices.document_type, documentType),
          ),
        )
        .limit(1);
      await this.dbAdmin
        .delete(invoices)
        .where(and(eq(invoices.id, createdId), eq(invoices.tenant_id, tenantId)));
      if (!winner) throw err; // shouldn't happen; surface the original conflict
      return { winnerId: winner.id };
    }
  }

  /**
   * Create a DRAFT invoice from a deal (§4.4). Lines are supplied by CRM
   * (from deal_products or a single value line); this sets the deal↔invoice
   * back-links after creation. Returns the invoice.
   */
  async createDraftInvoiceFromDeal(
    tenantId: string,
    userId: string,
    args: {
      dealId: string;
      customerId: string;
      currency: string;
      lines: DraftInvoiceLine[];
      discount?: { type: 'fixed'; value: string };
    },
  ) {
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10);
    const created = await this.invoices.create(
      {
        customer_id: args.customerId,
        invoice_date: today,
        due_date: dueDate,
        currency: args.currency,
        reference: `Deal ${args.dealId}`,
        line_items: args.lines,
        ...(args.discount ? { discount_type: args.discount.type, discount_value: args.discount.value } : {}),
      } as never,
      userId,
      tenantId,
    );
    const { winnerId } = await this.claimDealBackLink(tenantId, args.dealId, created.data.id, 'INVOICE');
    if (winnerId !== created.data.id) {
      const [winner] = await this.dbAdmin.select().from(invoices).where(eq(invoices.id, winnerId)).limit(1);
      return winner!;
    }
    await this.dbAdmin
      .update(deals)
      .set({ invoice_id: created.data.id, updated_at: new Date() })
      .where(and(eq(deals.id, args.dealId), eq(deals.tenant_id, tenantId)));
    return created.data;
  }

  /**
   * Create a DRAFT QUOTE from a deal (§4.4 / §19.3). Same shape as
   * createDraftInvoiceFromDeal but issues a quote (document_type=QUOTE, its own
   * numbering sequence) and sets the deal↔quote back-links. When the customer
   * later accepts it on the hosted page, the deal can auto-advance a stage.
   */
  async createDraftQuoteFromDeal(
    tenantId: string,
    userId: string,
    args: {
      dealId: string;
      customerId: string;
      currency: string;
      lines: DraftInvoiceLine[];
      discount?: { type: 'fixed'; value: string };
    },
  ) {
    const today = new Date().toISOString().slice(0, 10);
    const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const created = await this.invoices.create(
      {
        customer_id: args.customerId,
        document_type: 'QUOTE',
        invoice_date: today,
        due_date: validUntil,
        valid_until: validUntil,
        currency: args.currency,
        reference: `Deal ${args.dealId}`,
        line_items: args.lines,
        ...(args.discount ? { discount_type: args.discount.type, discount_value: args.discount.value } : {}),
      } as never,
      userId,
      tenantId,
    );
    const { winnerId } = await this.claimDealBackLink(tenantId, args.dealId, created.data.id, 'QUOTE');
    if (winnerId !== created.data.id) {
      const [winner] = await this.dbAdmin.select().from(invoices).where(eq(invoices.id, winnerId)).limit(1);
      return winner!;
    }
    await this.dbAdmin
      .update(deals)
      .set({ quote_id: created.data.id, updated_at: new Date() })
      .where(and(eq(deals.id, args.dealId), eq(deals.tenant_id, tenantId)));
    return created.data;
  }
}
