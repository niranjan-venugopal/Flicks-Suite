-- Migration 0033 — CRM views, custom fields, files (PRD v5 §9.1-9.2, §19.2)
--                  + deal→quote support (§4.4 / §19.3)
--
-- Sprint 27. Idempotent + additive (IF NOT EXISTS) per house convention. Built
-- in chunks; this file grows as the sprint lands each feature. Every new table
-- gets FORCE RLS + a tenant-isolation policy + flicks_app grants + joins the
-- isolation suite in the same sprint.

-- ─── Deal → quote (§4.4 / §19.3) ──────────────────────────────────────────────
-- A deal may generate a quote (an invoices row, document_type='QUOTE') and,
-- separately, an invoice. When the customer accepts the quote on the hosted
-- page, the deal can auto-advance to a pipeline-configured stage.

-- Per-pipeline "on quote accepted, move the deal to this stage" (§19.3). NULL =
-- leave the deal where it is.
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS quote_accepted_stage_id uuid;

-- Deal → quote back-link (mirrors deals.invoice_id).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS quote_id uuid;

-- Quote acceptance audit timestamp (the ACCEPTED status lives in invoices.status).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quote_accepted_at timestamptz;
