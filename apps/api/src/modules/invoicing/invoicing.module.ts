import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrgFinancialModule } from '../org-financial/org-financial.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { HsnSacController } from './hsn-sac.controller';
import { HsnSacService } from './hsn-sac.service';
import { NumberingController } from './numbering.controller';
import { NumberingService } from './numbering.service';
import { PublicInvoiceController } from './public-invoice.controller';
import { PublicInvoiceService } from './public-invoice.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { RazorpayWebhookController } from './razorpay-webhook.controller';
import { NotesService } from './notes.service';
import { InvReportsService } from './inv-reports.service';
import {
  NotesController,
  PaymentsController,
  InvReportsController,
} from './notes.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionMandatesService } from './subscription-mandates.service';
import { PublicMandateController } from './public-mandate.controller';
import { SubscriptionsController } from './subscriptions.controller';
import { InvSettingsService } from './inv-settings.service';
import { InvSettingsController } from './inv-settings.controller';
import { RazorpayOAuthController } from './razorpay-oauth.controller';
import { RazorpayService } from './razorpay.service';
import { InvoicingCryptoService } from './invoicing-crypto.service';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';

/**
 * Invoicing module (v3). Sprint 2 implements customers, items, HSN/SAC and the
 * numbering engine; invoices remain stubbed until Sprint 3. All controllers sit
 * behind the InvoicingGrantGuard. NumberingService is exported so invoice
 * creation (Sprint 3) can reserve numbers atomically.
 */
@Module({
  imports: [AuditModule, AuthModule, NotificationsModule, OrgFinancialModule],
  controllers: [
    CustomersController,
    ItemsController,
    InvoicesController,
    HsnSacController,
    NumberingController,
    PublicInvoiceController,
    RazorpayWebhookController,
    NotesController,
    PaymentsController,
    InvReportsController,
    SubscriptionsController,
    PublicMandateController,
    InvSettingsController,
    RazorpayOAuthController,
  ],
  providers: [
    CustomersService,
    ItemsService,
    InvoicesService,
    HsnSacService,
    NumberingService,
    PublicInvoiceService,
    InvoicePdfService,
    NotesService,
    InvReportsService,
    SubscriptionsService,
    SubscriptionMandatesService,
    InvSettingsService,
    RazorpayService,
    InvoicingCryptoService,
    InvoicingGrantGuard,
  ],
  exports: [
    CustomersService,
    ItemsService,
    InvoicesService,
    NumberingService,
  ],
})
export class InvoicingModule {}
