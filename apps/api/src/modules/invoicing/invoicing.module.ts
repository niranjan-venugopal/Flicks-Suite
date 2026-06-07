import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { HsnSacController } from './hsn-sac.controller';
import { HsnSacService } from './hsn-sac.service';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';

/**
 * Invoicing module (v3) — scaffold. Wires the core resource controllers
 * (customers, items, invoices, HSN/SAC) behind the InvoicingGrantGuard.
 * Notes/subscriptions/reports/settings/org-financial/members land as their own
 * modules in later sprints. DatabaseService is global; AuditModule/AuthModule
 * are imported for the service + guard dependencies.
 */
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [
    CustomersController,
    ItemsController,
    InvoicesController,
    HsnSacController,
  ],
  providers: [
    CustomersService,
    ItemsService,
    InvoicesService,
    HsnSacService,
    InvoicingGrantGuard,
  ],
  exports: [CustomersService, ItemsService, InvoicesService],
})
export class InvoicingModule {}
