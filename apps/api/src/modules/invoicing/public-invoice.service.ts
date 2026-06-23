import {
  Injectable,
  Inject,
  NotFoundException,
  GoneException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, asc, isNull } from 'drizzle-orm';
import {
  invoices,
  invoiceLineItems,
  customers,
  tenants,
  invoicingSettings,
  tenantBankAccounts,
  razorpayOrders,
} from '@flicks/db/schema';
import type { DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { RazorpayService } from './razorpay.service';
import { InvSettingsService } from './inv-settings.service';

/**
 * Hosted public invoice page backend (PRD §9.3).
 *
 * No auth and no tenant context — the signed token scopes to exactly one
 * invoice, so lookups run on the service-role connection (per §4.4 the tenant
 * connection is useless here by design). Responses are sanitized: only what a
 * customer should see (never internal notes, cost fields, or other invoices).
 */
@Injectable()
export class PublicInvoiceService {
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly razorpay: RazorpayService,
    private readonly invSettings: InvSettingsService,
  ) {}

  private async fetchByToken(token: string) {
    const [inv] = await this.dbAdmin
      .select()
      .from(invoices)
      .where(eq(invoices.public_view_token, token))
      .limit(1);
    if (!inv) throw new NotFoundException('Invoice not found');
    if (
      inv.public_view_token_expires_at &&
      new Date(inv.public_view_token_expires_at).getTime() < Date.now()
    ) {
      throw new GoneException('This invoice link has expired');
    }
    return inv;
  }

  async getByToken(token: string) {
    const inv = await this.fetchByToken(token);
    return this.assemble(inv);
  }

  private async assemble(inv: typeof invoices.$inferSelect) {
    const [lines, [customer], [tenant], [settings]] = await Promise.all([
      this.dbAdmin
        .select({
          line_number: invoiceLineItems.line_number,
          item_name: invoiceLineItems.item_name,
          description: invoiceLineItems.description,
          hsn_sac_code: invoiceLineItems.hsn_sac_code,
          quantity: invoiceLineItems.quantity,
          unit: invoiceLineItems.unit,
          rate: invoiceLineItems.rate,
          gst_rate: invoiceLineItems.gst_rate,
          taxable_amount: invoiceLineItems.taxable_amount,
          line_total: invoiceLineItems.line_total,
        })
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoice_id, inv.id))
        .orderBy(asc(invoiceLineItems.line_number)),
      this.dbAdmin
        .select({
          display_name: customers.display_name,
          legal_name: customers.legal_name,
          gstin: customers.gstin,
          billing_address_line1: customers.billing_address_line1,
          billing_address_line2: customers.billing_address_line2,
          billing_city: customers.billing_city,
          billing_state: customers.billing_state,
          billing_postal_code: customers.billing_postal_code,
          billing_country: customers.billing_country,
        })
        .from(customers)
        .where(eq(customers.id, inv.customer_id))
        .limit(1),
      this.dbAdmin
        .select({
          name: tenants.name,
          legal_name: tenants.legal_name,
          gstin: tenants.gstin,
          address_line1: tenants.address_line1,
          address_line2: tenants.address_line2,
          city: tenants.city,
          state_code: tenants.state_code,
          postal_code: tenants.postal_code,
          logo_url: tenants.logo_url,
          brand_color: tenants.brand_color,
        })
        .from(tenants)
        .where(eq(tenants.id, inv.tenant_id))
        .limit(1),
      this.dbAdmin
        .select({
          upi_id: invoicingSettings.upi_id,
          upi_display_name: invoicingSettings.upi_display_name,
          razorpay_access_token: invoicingSettings.razorpay_access_token,
          allow_partial_payments: invoicingSettings.allow_partial_payments,
          show_powered_by_footer: invoicingSettings.show_powered_by_footer,
        })
        .from(invoicingSettings)
        .where(eq(invoicingSettings.tenant_id, inv.tenant_id))
        .limit(1),
    ]);

    // Sanitized invoice surface — what the customer sees, nothing more.
    const pub = {
      invoice_number: inv.invoice_number,
      status: inv.status,
      invoice_date: inv.invoice_date,
      due_date: inv.due_date,
      currency: inv.currency,
      subtotal: inv.subtotal,
      discount_amount: inv.discount_amount,
      taxable_amount: inv.taxable_amount,
      cgst_amount: inv.cgst_amount,
      sgst_amount: inv.sgst_amount,
      igst_amount: inv.igst_amount,
      cess_amount: inv.cess_amount,
      total_amount: inv.total_amount,
      tds_section: inv.tds_section,
      tds_rate: inv.tds_rate,
      tds_amount: inv.tds_amount,
      net_receivable: inv.net_receivable,
      amount_paid: inv.amount_paid,
      amount_outstanding: inv.amount_outstanding,
      tax_treatment: inv.tax_treatment,
      place_of_supply: inv.place_of_supply,
      reference: inv.reference,
      notes: inv.notes,
      terms_and_conditions: inv.terms_and_conditions,
    };

    // §8 render rule: INR (domestic) ⇒ IFSC + account number, no SWIFT;
    // foreign currency ⇒ SWIFT/BIC + account number + bank address.
    let bankTransfer: Record<string, string | null> | null = null;
    if (inv.bank_account_id) {
      const [bank] = await this.dbAdmin
        .select()
        .from(tenantBankAccounts)
        .where(
          and(
            eq(tenantBankAccounts.id, inv.bank_account_id),
            eq(tenantBankAccounts.is_active, true),
            isNull(tenantBankAccounts.deleted_at),
          ),
        )
        .limit(1);
      if (bank) {
        const isInr = inv.currency === 'INR';
        bankTransfer = {
          beneficiary_name: bank.beneficiary_name,
          account_number: bank.account_number,
          account_type: bank.account_type,
          bank_name: bank.bank_name,
          branch: bank.branch,
          ifsc: isInr ? bank.ifsc : null,
          swift_bic: isInr ? null : bank.swift_bic,
          bank_address: isInr ? null : bank.bank_address,
        };
      }
    }

    const paymentOptions = {
      // UPI QR renders for INR only (§9.3) and only when configured.
      upi:
        inv.currency === 'INR' && settings?.upi_id
          ? { upi_id: settings.upi_id, display_name: settings.upi_display_name }
          : null,
      // Razorpay button is enabled once the tenant has connected an account via
      // OAuth. The real order_id + checkout key come from the on-demand
      // POST /public/inv/:token/pay/razorpay endpoint (no secrets leak here).
      razorpay: settings?.razorpay_access_token ? { enabled: true } : null,
      bank_transfer: bankTransfer,
      allow_partial: settings?.allow_partial_payments ?? true,
    };

    return {
      data: {
        invoice: pub,
        line_items: lines,
        customer: customer ?? null,
        seller: tenant ?? null,
        payment_options: paymentOptions,
        show_powered_by: settings?.show_powered_by_footer ?? true,
      },
    };
  }

  /** View tracking (§9.3): SENT → VIEWED, count + first/last timestamps. */
  async trackView(token: string) {
    const inv = await this.fetchByToken(token);
    const now = new Date();
    await this.dbAdmin
      .update(invoices)
      .set({
        status: inv.status === 'SENT' ? 'VIEWED' : inv.status,
        view_count: (inv.view_count ?? 0) + 1,
        first_viewed_at: inv.first_viewed_at ?? now,
        last_viewed_at: now,
      })
      .where(eq(invoices.id, inv.id));
    return { data: { ok: true } };
  }

  /**
   * Create a Razorpay order for the hosted "Pay with Razorpay" button (PRD §9.3).
   * Runs on the service-role connection (no tenant JWT); resolves the seller's
   * OAuth access token, creates the order on their sub-merchant account, and
   * records the order→invoice mapping the webhook will match on capture.
   */
  async createRazorpayOrder(token: string, requestedAmount?: string) {
    const inv = await this.fetchByToken(token);
    if (
      !['SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID', 'DISPUTED'].includes(
        inv.status,
      )
    ) {
      throw new BadRequestException(`This invoice is not payable (${inv.status})`);
    }

    const creds = await this.invSettings.resolveRazorpayForOrder(inv.tenant_id);
    if (!creds) {
      throw new BadRequestException(
        'The seller has not connected Razorpay for online payments.',
      );
    }

    const outstanding = Math.round(
      parseFloat(inv.amount_outstanding ?? inv.total_amount) * 100,
    );
    let amountPaise = outstanding;
    if (requestedAmount !== undefined) {
      const req = Math.round(parseFloat(requestedAmount) * 100);
      if (req > 0 && req <= outstanding) amountPaise = req;
    }
    if (amountPaise <= 0) {
      throw new BadRequestException('This invoice has nothing outstanding.');
    }

    const order = await this.razorpay.createOrder({
      accessToken: creds.accessToken,
      amountPaise,
      currency: inv.currency,
      receipt: inv.invoice_number,
      notes: { invoice_id: inv.id, tenant_id: inv.tenant_id },
    });

    await this.dbAdmin.insert(razorpayOrders).values({
      tenant_id: inv.tenant_id,
      invoice_id: inv.id,
      order_id: order.id,
      amount_paise: amountPaise,
      currency: inv.currency,
      status: 'created',
    });

    return {
      data: {
        order_id: order.id,
        key: creds.publicToken,
        amount: amountPaise,
        currency: inv.currency,
      },
    };
  }
}
