-- 0066 — Round P R2: invoice numbering series mode (invoice_sequences.series_mode).
--
-- invoice_sequences.series_mode — per document type, how the number series
-- behaves across financial years:
--   'fiscal_year' (default, today's behaviour) — PREFIX{sep}FY{sep}NNNN, the
--     counter restarts at starting_number on the first day of each FY;
--   'continuous' — PREFIX{sep?}NNNNN, never resets (e.g. LB2400001).
-- The current-FY row keeps holding the config (prefix, separator, zero_padding,
-- starting_number, series_mode) and FY rollover copies it forward, so the mode
-- survives April 1 with no special case. The continuous counter lives in ONE
-- sentinel row per (tenant, document_type, branch): fy_label = 'ALL',
-- fy_start_date = the day the mode was first enabled, fy_end_date =
-- '9999-12-31', series_mode = 'continuous' — the existing unique index
-- (tenant_id, document_type, fy_label, branch_code) already guarantees a
-- single such row. invoices.fy_label still records the invoice's own FY, so
-- GSTR-1 period grouping is unchanged in either mode.
--
-- Guarded CHECK (0062/0064/0065 pattern). The table already has FORCE RLS,
-- the tenant_isolation policy and the flicks_app grants from 0012/0014 —
-- table-level grants cover the new column, so no policy or grant changes.
-- Idempotent and additive; mirrored in packages/db/src/schema/invoicing.ts.
--
-- Release ordering: numbering.service selects the whole invoice_sequences row
-- and writes series_mode on every save, so an API built with the mirror fails
-- on the Numbering tab (and on invoice creation) until this has run — apply in
-- Supabase BEFORE pushing the API.

-- 1. Column (existing rows backfill to today's behaviour).
ALTER TABLE invoice_sequences
  ADD COLUMN IF NOT EXISTS series_mode text NOT NULL DEFAULT 'fiscal_year';

-- 2. Guarded CHECK constraint.
DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoice_sequences_series_mode_check'
  ) THEN
    ALTER TABLE invoice_sequences
      ADD CONSTRAINT invoice_sequences_series_mode_check
      CHECK (series_mode IN ('fiscal_year', 'continuous'));
  END IF;
END
$chk$;
