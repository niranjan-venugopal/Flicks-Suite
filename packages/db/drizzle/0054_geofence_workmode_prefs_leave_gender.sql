-- 0054 — Geofence work-mode, tenant week-start preference, leave-gender
-- backfill (Round 13).
--
-- 1. `attendance_records.work_mode` — office vs remote vs field for the DAY,
--    derived from the punch-in geofence check (or an approved WFH
--    regularization). Deliberately a NEW column rather than an
--    `attendance_status` value: status already carries lateness/duration
--    (`late`, `half_day`), so overloading it would make a "late WFH day"
--    unrepresentable and break the status-based compliance aggregations.
--    NULL = unknown (no coordinates, or no geofence configured).
-- 2. `tenants.week_starts_on` — 0=Sunday .. 6=Saturday (same convention as
--    `shift_templates.working_days`). Drives the timesheet week boundary;
--    default 1 (Monday) preserves today's behaviour for every tenant.
-- 3. Leave-gender backfill: tenants seeded by the demo script predate
--    `applicable_genders` tagging (onboarding-created tenants are already
--    tagged). Keyed on NAME, not code — the 'PL' code collides between
--    Privilege Leave and Paternity Leave.
--
-- Idempotent + additive, per house rules.

DO $r13$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'work_mode') THEN
    CREATE TYPE work_mode AS ENUM ('office', 'remote', 'field');
  END IF;
END
$r13$;

ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS work_mode work_mode;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS week_starts_on smallint NOT NULL DEFAULT 1;

UPDATE leave_types
   SET applicable_genders = '{female}'
 WHERE name ILIKE 'Maternity%'
   AND applicable_genders IS NULL;

UPDATE leave_types
   SET applicable_genders = '{male}'
 WHERE name ILIKE 'Paternity%'
   AND applicable_genders IS NULL;
