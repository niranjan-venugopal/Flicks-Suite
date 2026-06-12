import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
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
import { RazorpayWebhookController } from './razorpay-webhook.controller';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';

/**
 * Invoicing module (v3). Sprint 2 implements customers, items, HSN/SAC and the
 * numbering engine; invoices remain stubbed until Sprint 3. All controllers sit
 * behind the InvoicingGrantGuard. NumberingService is exported so invoice
 * creation (Sprint 3) can reserve numbers atomically.
 */
@Module({
  imports: [AuditModule, AuthModule, NotificationsModule],
  controllers: [
    CustomersController,
    ItemsController,
    InvoicesController,
    HsnSacController,
    NumberingController,
    PublicInvoiceController,
    RazorpayWebhookController,
  ],
  providers: [
    CustomersService,
    ItemsService,
    InvoicesService,
    HsnSacService,
    NumberingService,
    PublicInvoiceService,
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
