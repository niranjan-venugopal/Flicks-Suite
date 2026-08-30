-- 0055 — Invoice soft delete + export (LUT) settings (Round 18, founder items 3 & 4)
--
-- Two additions:
--
-- 1. `invoices.deleted_at` — the module had cancel/void/write-off but no delete
--    at all. Delete is SOFT (a Deleted filter + Restore, like Refrens) because
--    a hard delete would CASCADE away invoice_payments and razorpay_orders.
--    NOTE: `invoices_tenant_number_unique` is deliberately left NON-partial —
--    a deleted or cancelled invoice number must never be reused (GST requires a
--    consecutive series; Zoho blocks reuse the same way). This is the opposite
--    of 0053's web-form choice, and it is intentional.
--
-- 2. Export-under-LUT settings, so a foreign client's invoice can carry the
--    Rule 46 endorsement instead of silently omitting GST.
--
-- Idempotent + additive, per house rules.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Hot path: every invoice list/report read now filters on deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_live
  ON invoices (tenant_id, status)
  WHERE deleted_at IS NULL;

-- Export snapshot on the document itself: an LUT number is annual, so the
-- endorsement a customer received must stay true to the date of supply even
-- after the tenant edits its settings.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS export_route text; -- LUT | WITH_IGST
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS lut_number text;

-- Export route per tenant. TRUE = supplies exported under LUT/bond without
-- payment of IGST (EXPWOP, the common case); FALSE = exported on payment of
-- IGST (EXPWP), refund claimed later.
ALTER TABLE invoicing_settings
  ADD COLUMN IF NOT EXISTS export_under_lut boolean NOT NULL DEFAULT true;
ALTER TABLE invoicing_settings ADD COLUMN IF NOT EXISTS lut_number text;
ALTER TABLE invoicing_settings ADD COLUMN IF NOT EXISTS lut_valid_upto date;
