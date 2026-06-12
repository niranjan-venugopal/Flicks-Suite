import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OrgFinancialController } from './org-financial.controller';
import { OrgFinancialService } from './org-financial.service';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';

/**
 * Organization → Financial details (PRD §7.2/§8) — a SHARED module, not part of
 * Invoicing: it owns the company-level financial fields (on `tenants`) and the
 * bank accounts. Invoicing reads it now; Payroll will read it later.
 * OrgFinancialService is exported so invoice creation can resolve the §8
 * bank-account selection inside its own transaction.
 */
@Module({
  imports: [AuditModule],
  controllers: [OrgFinancialController],
  providers: [OrgFinancialService, InvoicingGrantGuard],
  exports: [OrgFinancialService],
})
export class OrgFinancialModule {}
