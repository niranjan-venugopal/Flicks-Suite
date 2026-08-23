-- Migration 0049 — Employee detail change requests (founder round 3).
-- When Owner/HR edits an active employee's personal/identity/bank details,
-- the change is held here as PENDING until the employee confirms it (or
-- rejects it back to HR). Idempotent + additive per house convention; the
-- new tenant table gets FORCE RLS + isolation policy + flicks_app grants.

CREATE TABLE IF NOT EXISTS employee_change_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  requested_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  step                  integer NOT NULL CHECK (step BETWEEN 1 AND 3),
  -- The validated onboarding-step payload to apply on confirm. Sensitive
  -- values (PAN, bank account number) are stored FieldCipher-encrypted.
  payload               jsonb NOT NULL,
  -- Masked old→new pairs for display (last-4 only for sensitive fields).
  summary               jsonb NOT NULL DEFAULT '[]',
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','confirmed','rejected','cancelled')),
  reason                text,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emp_change_requests_tenant
  ON employee_change_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_emp_change_requests_employee
  ON employee_change_requests (employee_id, status);

DO $ecr$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_change_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$ecr$;
