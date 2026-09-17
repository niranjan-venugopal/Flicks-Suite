-- apply-0062-0063.sql — Round L (2026-09-17): approval routing + 24 h escalation (0062) and PM attachments on record_files (0063).
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Identical to packages/db/drizzle/0062_approval_escalation.sql followed by 0063_record_files_pm_attachments.sql.

-- 0062 — Round L item 2: approval routing + 24 h escalation.
--
-- Leave requests, attendance regularizations and timesheet periods now carry
-- a routing state: which level is reviewing (0 = reporting manager, 1 = the
-- manager's manager, 2 = Owner + HR Admins), when and why it moved there, who
-- it was escalated to, and a display-only snapshot of the manager it was
-- routed to at apply time. The live `employees.reporting_manager_id` still
-- governs "may act"; the snapshot only feeds the "With <manager>" chip.
--
--   escalation_reason: sla               — no action for 24 calendar hours
--                      reviewer_on_leave — the current reviewer is on approved
--                                          full-day leave today
--                      no_manager        — no valid reporting manager at all
--                      no_skip_manager   — L0 stuck and no valid L1 (missing /
--                                          self / cycle)
--
-- No new tables: the three tables already have ENABLE + FORCE RLS, their
-- tenant_isolation_* policies and the flicks_app grants (0009 / 0014 / 0037),
-- so nothing here touches RLS. Idempotent and additive; mirrored in
-- packages/db/src/schema/{leave,attendance,timesheet}.ts.

-- 1. Columns.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS escalation_level smallint NOT NULL DEFAULT 0;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS escalation_reason text;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS escalated_to_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS routed_manager_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE attendance_regularizations ADD COLUMN IF NOT EXISTS escalation_level smallint NOT NULL DEFAULT 0;
ALTER TABLE attendance_regularizations ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE attendance_regularizations ADD COLUMN IF NOT EXISTS escalation_reason text;
ALTER TABLE attendance_regularizations ADD COLUMN IF NOT EXISTS escalated_to_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE attendance_regularizations ADD COLUMN IF NOT EXISTS routed_manager_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE timesheet_periods ADD COLUMN IF NOT EXISTS escalation_level smallint NOT NULL DEFAULT 0;
ALTER TABLE timesheet_periods ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE timesheet_periods ADD COLUMN IF NOT EXISTS escalation_reason text;
ALTER TABLE timesheet_periods ADD COLUMN IF NOT EXISTS escalated_to_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE timesheet_periods ADD COLUMN IF NOT EXISTS routed_manager_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

-- 2. Guarded CHECK constraints (0061 pattern).
DO $chk$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leave_requests', 'attendance_regularizations', 'timesheet_periods'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_escalation_level_chk') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (escalation_level BETWEEN 0 AND 2)',
        t, t || '_escalation_level_chk'
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_escalation_reason_chk') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (escalation_reason IS NULL OR escalation_reason IN (''sla'', ''reviewer_on_leave'', ''no_manager'', ''no_skip_manager''))',
        t, t || '_escalation_reason_chk'
      );
    END IF;
  END LOOP;
END
$chk$;

-- 3. Partial indexes for the 15-minute sweep: (tenant, level, anchor) over
--    OPEN items only. Anchors: leave COALESCE(applied_at, created_at),
--    regularization created_at, timesheet submitted_at.
CREATE INDEX IF NOT EXISTS idx_leave_requests_escalation
  ON leave_requests (tenant_id, escalation_level, (COALESCE(applied_at, created_at)))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_attendance_regularizations_escalation
  ON attendance_regularizations (tenant_id, escalation_level, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_timesheet_periods_escalation
  ON timesheet_periods (tenant_id, escalation_level, submitted_at)
  WHERE status = 'submitted';


-- 0063 — Round L item 6: PM attachments + inline media on record_files.
--
-- record_files (0033) already carries RLS (FORCE + tenant_isolation_record_files)
-- and the flicks_app grants, and 0041 whitelisted 'issue'/'project' without a
-- pipeline behind them. This migration widens the object_type CHECK so a file
-- can hang off a COMMENT or sit as an unbound DRAFT (uploaded while composing;
-- bound to the issue/comment on create, pruned after 24 h when never bound),
-- and adds the columns the PM pipeline stores: kind (attachment chip vs an
-- inline image referenced from the markdown body as flicks-file://<id>),
-- image dimensions, the 480-px WebP thumbnail key and a sha256 of the stored
-- bytes. Idempotent + additive — safe to re-run.

DO $rf$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'record_files') THEN
    ALTER TABLE record_files DROP CONSTRAINT IF EXISTS record_files_object_type_check;
    ALTER TABLE record_files ADD CONSTRAINT record_files_object_type_check
      CHECK (object_type IN ('deal','person','company','lead','issue','project','comment','draft'));
  END IF;
END
$rf$;

ALTER TABLE record_files ADD COLUMN IF NOT EXISTS kind      text NOT NULL DEFAULT 'attachment';
ALTER TABLE record_files ADD COLUMN IF NOT EXISTS width     integer;
ALTER TABLE record_files ADD COLUMN IF NOT EXISTS height    integer;
ALTER TABLE record_files ADD COLUMN IF NOT EXISTS thumb_key text;
ALTER TABLE record_files ADD COLUMN IF NOT EXISTS sha256    text;

DO $rk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'record_files_kind_check' AND conrelid = 'record_files'::regclass
  ) THEN
    ALTER TABLE record_files ADD CONSTRAINT record_files_kind_check
      CHECK (kind IN ('attachment','inline'));
  END IF;
END
$rk$;

-- Tenant quota (SUM(size_bytes) of live rows) — index-only scan.
CREATE INDEX IF NOT EXISTS idx_record_files_tenant_live
  ON record_files (tenant_id, size_bytes) WHERE deleted_at IS NULL;

-- Orphan-draft prune (daily job): drafts older than 24 h, oldest first.
CREATE INDEX IF NOT EXISTS idx_record_files_drafts
  ON record_files (created_at) WHERE object_type = 'draft' AND deleted_at IS NULL;
