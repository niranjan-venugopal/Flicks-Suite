-- =============================================================================
-- Row-Level Security Policies for Flicks Suite
-- Run AFTER 0001_initial.sql (Drizzle-generated tables)
-- =============================================================================
-- This file enables RLS on all tenant-scoped tables.
-- Platform tables (tenants, users, auth_*) are accessed via service role only.
-- =============================================================================

-- Ensure pgcrypto is available for encryption
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- =============================================================================
-- Service role setup (BYPASSRLS — for FAM module only)
-- =============================================================================
-- NOTE: Run these commands as superuser / Supabase dashboard:
--
-- CREATE ROLE flicks_service_role WITH LOGIN PASSWORD '<strong-password>';
-- GRANT BYPASSRLS TO flicks_service_role;
-- GRANT USAGE ON SCHEMA public TO flicks_service_role;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flicks_service_role;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO flicks_service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flicks_service_role;

-- =============================================================================
-- MEMBERSHIPS (tenant-scoped)
-- =============================================================================
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_memberships ON memberships
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- DEPARTMENTS
-- =============================================================================
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_departments ON departments
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- DESIGNATIONS
-- =============================================================================
ALTER TABLE designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE designations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_designations ON designations
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- LOCATIONS
-- =============================================================================
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_locations ON locations
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- EMPLOYEES
-- =============================================================================
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_employees ON employees
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- EMERGENCY_CONTACTS
-- =============================================================================
ALTER TABLE emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_emergency_contacts ON emergency_contacts
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- EMPLOYEE_DOCUMENTS
-- =============================================================================
ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_employee_documents ON employee_documents
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- EMPLOYEE_INVITATIONS
-- =============================================================================
ALTER TABLE employee_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_employee_invitations ON employee_invitations
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- EMPLOYMENT_HISTORY
-- =============================================================================
ALTER TABLE employment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_history FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_employment_history ON employment_history
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- DATA_CONSENTS
-- =============================================================================
ALTER TABLE data_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_consents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_data_consents ON data_consents
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- SHIFT_TEMPLATES
-- =============================================================================
ALTER TABLE shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_shift_templates ON shift_templates
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- EMPLOYEE_SHIFTS
-- =============================================================================
ALTER TABLE employee_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_shifts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_employee_shifts ON employee_shifts
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- ATTENDANCE_RECORDS
-- =============================================================================
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_attendance_records ON attendance_records
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- ATTENDANCE_PUNCHES
-- =============================================================================
ALTER TABLE attendance_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_punches FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_attendance_punches ON attendance_punches
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- ATTENDANCE_REGULARIZATIONS
-- =============================================================================
ALTER TABLE attendance_regularizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_regularizations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_attendance_regularizations ON attendance_regularizations
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- LEAVE_TYPES
-- =============================================================================
ALTER TABLE leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_types FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_leave_types ON leave_types
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- LEAVE_BALANCES
-- =============================================================================
ALTER TABLE leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_balances FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_leave_balances ON leave_balances
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- LEAVE_REQUESTS
-- =============================================================================
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_leave_requests ON leave_requests
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- HOLIDAYS
-- =============================================================================
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_holidays ON holidays
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- CALENDAR_EVENTS
-- =============================================================================
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_calendar_events ON calendar_events
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- TIMESHEET_PERIODS
-- =============================================================================
ALTER TABLE timesheet_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_periods FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_timesheet_periods ON timesheet_periods
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- TIMESHEET_ENTRIES
-- =============================================================================
ALTER TABLE timesheet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_timesheet_entries ON timesheet_entries
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- TIMESHEET_REWORK_REQUESTS
-- =============================================================================
ALTER TABLE timesheet_rework_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_rework_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_timesheet_rework ON timesheet_rework_requests
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- AUDIT_LOG (tenant-scoped; INSERT via service role only)
-- =============================================================================
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Tenants can SELECT their own audit log
CREATE POLICY tenant_isolation_audit_log_select ON audit_log
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- INSERT goes through service role (BYPASSRLS); no tenant-facing INSERT policy

-- =============================================================================
-- NOTIFICATIONS (if table exists)
-- =============================================================================
-- ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_isolation_notifications ON notifications
--   FOR ALL
--   USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
--   WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- Verification: Check all tenant-scoped tables have RLS enabled
-- =============================================================================
-- Run this query to verify:
-- SELECT schemaname, tablename, rowsecurity, forcerowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY tablename;
-- All tenant-scoped tables should show: rowsecurity = true, forcerowsecurity = true
