/**
 * Public facade for the platform-billing module (house rule 3). Round R R2:
 * the FAM support console grants free months and reads the subscription
 * panel through BillingService; nothing else is exported.
 */
export { BillingService } from './billing.service';
export type { FreeMonthsGrant } from './billing.service';
export { BillingModule } from './billing.module';
