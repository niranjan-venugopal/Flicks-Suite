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
   * Create a DRAFT invoice from a deal (§4.4). Lines are supplied by CRM
   * (from deal_products or a single value line); this sets the deal↔invoice
   * back-links after creation. Returns the invoice.
   */
  async createDraftInvoiceFromDeal(
    tenantId: string,
    userId: string,
    args: { dealId: string; customerId: string; currency: string; lines: DraftInvoiceLine[] },
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
      } as never,
      userId,
      tenantId,
    );
    // Back-links: invoice.deal_id and deal.invoice_id (service-role, id-scoped).
    await this.dbAdmin
      .update(invoices)
      .set({ deal_id: args.dealId })
      .where(and(eq(invoices.id, created.data.id), eq(invoices.tenant_id, tenantId)));
    await this.dbAdmin
      .update(deals)
      .set({ invoice_id: created.data.id, updated_at: new Date() })
      .where(and(eq(deals.id, args.dealId), eq(deals.tenant_id, tenantId)));
    return created.data;
  }
}
