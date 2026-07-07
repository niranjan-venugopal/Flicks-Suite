import { SetMetadata } from '@nestjs/common';

export const BILLING_EXEMPT_KEY = 'billingExempt';

/**
 * Marks a controller or handler as reachable even when the workspace is
 * billing-locked (PRD v4 §8B.5). The lock must never trap a tenant away from:
 * auth (sign in/out), the billing surface itself (to pay), consent writes
 * (legal), feedback, and data export (DPDP takeout).
 */
export const BillingExempt = () => SetMetadata(BILLING_EXEMPT_KEY, true);
