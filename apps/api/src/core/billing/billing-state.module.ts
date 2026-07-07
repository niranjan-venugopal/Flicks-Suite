import { Global, Module } from '@nestjs/common';
import { BillingStateService } from './billing-state.service';

// Global so the app-level BillingGuard and the billing module share one
// cached lock-verdict service without import cycles.
@Global()
@Module({
  providers: [BillingStateService],
  exports: [BillingStateService],
})
export class BillingStateModule {}
