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
