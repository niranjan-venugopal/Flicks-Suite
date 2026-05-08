#!/usr/bin/env bash
#
# Flicks Suite — demo tenant + users (for browser testing)
#
# Creates:
#   • Tenant "Demo Co" (slug: demo-co)
#   • Manager: manager@demo.co (role=manager)
#   • Employee: alice@demo.co (role=employee, manager=Mira)
#   • One leave type: Casual Leave (CL, 12 days)
#
# Idempotent — safe to re-run.
#
# Usage:
#   ./scripts/setup-demo.sh
#
# After running, log in via the web UI at http://localhost:3000/login
# using either email. The OTP code will be printed in the API server log
# (search for "[DEV] OTP for ...") since NODE_ENV is development.

set -euo pipefail

PGSUPERUSER="${PGSUPERUSER:-postgres}"
PGSUPERPASSWORD="${PGSUPERPASSWORD:-postgres}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
APP_DB_NAME="${APP_DB_NAME:-flicks_suite}"

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found." >&2
  exit 1
fi

export PGPASSWORD="$PGSUPERPASSWORD"

psql -h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" -d "$APP_DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
-- Tenant
INSERT INTO tenants (id, name, slug, status)
VALUES ('11111111-1111-1111-1111-111111111111', 'Demo Co', 'demo-co', 'trialing')
ON CONFLICT (id) DO NOTHING;

-- Users
INSERT INTO users (id, email, full_name, status)
VALUES
  ('22222222-2222-2222-2222-222222222221', 'manager@demo.co', 'Mira Manager', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'alice@demo.co',   'Alice Employee', 'active')
ON CONFLICT (id) DO NOTHING;

-- Employees
INSERT INTO employees (id, tenant_id, user_id, employee_code, first_name, last_name, work_email, employment_type, date_of_joining, status)
VALUES
  ('33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'EMP001', 'Mira',  'Manager',  'manager@demo.co', 'full_time', '2025-01-01', 'active'),
  ('33333333-3333-3333-3333-333333333332', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'EMP002', 'Alice', 'Employee', 'alice@demo.co',   'full_time', '2025-06-01', 'active')
ON CONFLICT (id) DO NOTHING;

-- Make Mira Alice's manager
UPDATE employees
SET reporting_manager_id = '33333333-3333-3333-3333-333333333331'
WHERE id = '33333333-3333-3333-3333-333333333332';

-- Memberships
INSERT INTO memberships (tenant_id, user_id, employee_id, role, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'manager',  'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333332', 'employee', 'active')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- Leave type: Casual Leave 12 days
INSERT INTO leave_types (tenant_id, name, code, default_quota_days, is_paid)
VALUES ('11111111-1111-1111-1111-111111111111', 'Casual Leave', 'CL', 12, true)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- Default shift template: General 09:00-18:00 IST Mon-Fri (PRD §6.3)
INSERT INTO shift_templates (
  id, tenant_id, name, description,
  start_time, end_time, is_overnight,
  break_minutes, break_paid,
  working_days, timezone,
  grace_period_minutes, half_day_threshold_minutes, full_day_threshold_minutes,
  is_default, is_active
)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-1111-1111-111111111111',
  'General', 'Default 9-to-6 shift, Mon-Fri, IST.',
  '09:00', '18:00', false,
  60, false,
  ARRAY[1,2,3,4,5]::smallint[], 'Asia/Kolkata',
  15, 240, 480,
  true, true
)
ON CONFLICT (id) DO NOTHING;

-- Copy Indian holidays from the default seed tenant (if pnpm db:seed has run)
-- so the demo tenant's calendar is populated for Gate 4 testing.
INSERT INTO holidays (tenant_id, holiday_date, name, type, description, is_recurring)
SELECT '11111111-1111-1111-1111-111111111111', holiday_date, name, type, description, is_recurring
FROM holidays
WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM holidays h2
    WHERE h2.tenant_id = '11111111-1111-1111-1111-111111111111'
      AND h2.holiday_date = holidays.holiday_date
      AND h2.name = holidays.name
  );
SQL

echo "✅ Demo data ready."
echo
echo "Try logging in at http://localhost:3000/login with:"
echo "  • alice@demo.co       (employee — applies for leave)"
echo "  • manager@demo.co     (manager  — approves leave)"
echo
echo "OTP codes appear in the API server log (look for '[DEV] OTP for ...')."
