#!/usr/bin/env bash
#
# Flicks Suite — demo tenant + users + history + schema guards (rich seed)
#
# Creates a populated "Demo Co" tenant so every screen looks real, AND
# inline-applies any migration deltas that the migration files would
# otherwise apply separately. One command brings a fresh Supabase to a
# working state.
#
# Personas (all sign in via OTP at http://localhost:3000/login):
#   • fam@flickssuite.com  (FAM platform admin → /fam/*)
#   • niranjan@demo.co     (Owner of Demo Co → customer dashboard)
#   • manager@demo.co      (manager Mira — Engineering)
#   • sarah@demo.co        (manager Sarah — Sales)
#   • alice@demo.co        (employee, reports to Mira)
#   • + 7 more employees across 3 departments + 2 locations
#
# Data:
#   • 3 tenants total (Demo Co + Acme Pvt + NorthStar Labs) with
#     subscriptions, latest health snapshots, and a few seed billing
#     events + platform audit rows so every FAM screen has content.
#   • 11 Indian leave types, default 9-to-6 Mon-Fri shift template
#   • Last 30 days of attendance × 8 employees with realistic mix
#   • 4 leave requests + 2 regularizations in mixed states
#   • Holidays copied from the seed tenant for the Calendar
#
# Schema deltas applied inline (idempotent — IF NOT EXISTS everywhere):
#   • ALTER TYPE membership_role ADD VALUE 'owner'
#   • ALTER TYPE membership_role ADD VALUE 'fam'
#   • CREATE TABLE notifications (matches drizzle/0003_notifications.sql)
#
# Idempotent — safe to re-run; uses fixed UUIDs, ON CONFLICT, and an
# explicit role-reset block at the end so testing artefacts (promoting
# Mira to admin via the UI, demoting niranjan, etc.) don't bleed across
# sessions.
#
# Usage:
#   bash scripts/setup-demo.sh
#
# OTPs print to the API server log: search for [DEV] OTP for ...

set -euo pipefail

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found." >&2
  exit 1
fi

# Auto-source apps/api/.env if it exists and DATABASE_DIRECT_URL hasn't been
# exported manually. Lets the user run `bash scripts/setup-demo.sh` without
# having to remember `set -a; source apps/api/.env; set +a` first.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/apps/api/.env"
if [[ -z "${DATABASE_DIRECT_URL:-}" && -z "${DATABASE_SERVICE_ROLE_URL:-}" && -f "$ENV_FILE" ]]; then
  echo "  ↳ sourcing $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Prefer DATABASE_DIRECT_URL (Supabase / remote). Fall back to local PG* env vars.
if [[ -n "${DATABASE_DIRECT_URL:-}" ]]; then
  CONN_TARGET=("$DATABASE_DIRECT_URL")
elif [[ -n "${DATABASE_SERVICE_ROLE_URL:-}" ]]; then
  CONN_TARGET=("$DATABASE_SERVICE_ROLE_URL")
else
  PGSUPERUSER="${PGSUPERUSER:-postgres}"
  PGSUPERPASSWORD="${PGSUPERPASSWORD:-postgres}"
  PGHOST="${PGHOST:-127.0.0.1}"
  PGPORT="${PGPORT:-5432}"
  APP_DB_NAME="${APP_DB_NAME:-flicks_suite}"
  export PGPASSWORD="$PGSUPERPASSWORD"
  CONN_TARGET=(-h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" -d "$APP_DB_NAME")
fi

# ─── Schema guards (apply migration deltas inline) ──────────────────────────
# Each runs as its own psql call so the ALTER/CREATE commits before the
# seed below tries to use the new value or table. Without separate commits
# the same transaction can't add an enum value and then reference it
# (PG only sees added enum labels in subsequent transactions).
echo "  ↳ schema guards"
psql "${CONN_TARGET[@]}" -v ON_ERROR_STOP=1 --no-psqlrc -c \
  "ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'owner';" >/dev/null
psql "${CONN_TARGET[@]}" -v ON_ERROR_STOP=1 --no-psqlrc -c \
  "ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'fam';" >/dev/null

# Migrate any legacy 'super_admin' memberships to 'fam' so long-lived
# databases that were ever promoted via the old promote-fam-admin.sql
# converge on the canonical role name. Mirrors the data step in
# packages/db/drizzle/0004_role_fam.sql. No-op on fresh installs.
psql "${CONN_TARGET[@]}" -v ON_ERROR_STOP=1 --no-psqlrc -c \
  "UPDATE memberships SET role = 'fam' WHERE role = 'super_admin';" >/dev/null

# Notifications table — matches packages/db/drizzle/0003_notifications.sql.
# Inlined so the schema is whole after a fresh setup-supabase + setup-demo.
psql "${CONN_TARGET[@]}" -v ON_ERROR_STOP=1 --no-psqlrc <<'SCHEMA_SQL' >/dev/null
CREATE TABLE IF NOT EXISTS "notifications" (
  "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "user_id"   uuid NOT NULL REFERENCES "users"   ("id") ON DELETE CASCADE,
  "type"      text NOT NULL,
  "message"   text NOT NULL,
  "link_url"  text,
  "read_at"   timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "notifications_user_read_idx"
  ON "notifications" ("user_id", "read_at");
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx"
  ON "notifications" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "notifications_tenant_id_idx"
  ON "notifications" ("tenant_id");

-- impersonation_sessions + refresh_tokens.impersonator_user_id —
-- matches packages/db/drizzle/0005_impersonation_sessions.sql. The
-- FAM impersonation flow needs the table to exist before it'll work.
CREATE TABLE IF NOT EXISTS "impersonation_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "impersonator_user_id" uuid NOT NULL REFERENCES "users"("id")   ON DELETE CASCADE,
  "target_user_id"       uuid NOT NULL REFERENCES "users"("id")   ON DELETE CASCADE,
  "target_tenant_id"     uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "reason"               text NOT NULL,
  "support_ticket"       text,
  "started_at"           timestamptz NOT NULL DEFAULT now(),
  "ends_at"              timestamptz NOT NULL,
  "ended_at"             timestamptz,
  "ip_address"           text,
  "user_agent"           text
);
CREATE INDEX IF NOT EXISTS "impersonation_sessions_target_idx"
  ON "impersonation_sessions" ("target_user_id", "ended_at");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_impersonator_idx"
  ON "impersonation_sessions" ("impersonator_user_id", "ended_at");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_active_idx"
  ON "impersonation_sessions" ("ended_at", "ends_at");

ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "impersonator_user_id"
    uuid REFERENCES "users"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "refresh_tokens_impersonator_idx"
  ON "refresh_tokens" ("impersonator_user_id");
SCHEMA_SQL

echo "  ↳ seeding demo data"

psql "${CONN_TARGET[@]}" -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL' >/dev/null
-- ─── Tenants ─────────────────────────────────────────────────────────────────
-- Specflicks-internal "platform tenant" so the FAM admin has a JWT
-- tenant_id to attach to without being a member of any customer
-- workspace. Hidden from the FAM tenants list and the platform-wide
-- aggregates by id (see fam.service.ts SPECFLICKS_TENANT_ID).
--
-- Primary demo tenant + two extras so the FAM Overview screen reads
-- realistic numbers (active count, signups this week, plan mix).
INSERT INTO tenants (id, name, slug, status, created_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Specflicks Platform', 'specflicks',
    'active',   now() - interval '365 days'),
  ('11111111-1111-1111-1111-111111111111', 'Demo Co',  'demo-co',
    'trialing', now() - interval '14 days'),
  ('11111111-1111-1111-1111-111111111112', 'Acme Pvt', 'acme',
    'active',   now() - interval '40 days'),
  ('11111111-1111-1111-1111-111111111113', 'NorthStar Labs', 'northstar',
    'active',   now() - interval '3 days')
ON CONFLICT (id) DO NOTHING;

-- ─── Subscriptions ───────────────────────────────────────────────────────────
-- Lets the FAM Overview MRR card show real numbers. mrr_amount is the
-- monthly value used directly in the SUM; per_user_price * user_count is
-- kept consistent for the tenant-detail surfaces in C4.
INSERT INTO subscriptions (
  tenant_id, plan_code, status, per_user_price, user_count, mrr_amount,
  billing_cycle, current_period_start, current_period_end, created_at
) VALUES
  ('11111111-1111-1111-1111-111111111111', 'starter',  'trialing',
    149, 12, 149*12, 'monthly',
    now() - interval '14 days', now() + interval '16 days',
    now() - interval '14 days'),
  ('11111111-1111-1111-1111-111111111112', 'growth',   'active',
    249, 38, 249*38, 'monthly',
    now() - interval '40 days', now() + interval '20 days',
    now() - interval '40 days'),
  ('11111111-1111-1111-1111-111111111113', 'starter',  'active',
    149, 6,  149*6,  'monthly',
    now() - interval '3 days', now() + interval '27 days',
    now() - interval '3 days')
ON CONFLICT (tenant_id) DO UPDATE SET
  plan_code      = EXCLUDED.plan_code,
  status         = EXCLUDED.status,
  per_user_price = EXCLUDED.per_user_price,
  user_count     = EXCLUDED.user_count,
  mrr_amount     = EXCLUDED.mrr_amount,
  updated_at     = now();

-- ─── Tenant health snapshots ─────────────────────────────────────────────────
-- Latest snapshot per tenant is what the FAM Overview health bucket reads.
-- One row per tenant is enough for C2; C5 will backfill a 30-day history.
INSERT INTO tenant_health_snapshots (
  tenant_id, snapshot_date, health_score, active_users_7d, active_users_30d,
  attendance_compliance, feature_adoption_score, support_tickets_open, signal
) VALUES
  ('11111111-1111-1111-1111-111111111111', current_date, 84,  9, 11, 0.92, 72, 0, 'healthy'),
  ('11111111-1111-1111-1111-111111111112', current_date, 91, 34, 38, 0.95, 88, 0, 'expanding'),
  ('11111111-1111-1111-1111-111111111113', current_date, 62,  3,  5, 0.80, 41, 1, 'new')
ON CONFLICT DO NOTHING;

-- ─── Subscription events ─────────────────────────────────────────────────────
-- A few signal-of-life rows so the FAM tenant detail Billing tab shows
-- a non-empty history. Real rows land via Razorpay webhooks in prod.
INSERT INTO subscription_events (tenant_id, subscription_id, event_type, metadata, created_at)
SELECT s.tenant_id, s.id, e.event_type, e.metadata::jsonb, now() - e.age
FROM subscriptions s
CROSS JOIN (
  VALUES
    ('subscription.created', '{"channel":"signup"}',                interval '14 days'),
    ('plan.changed',         '{"from":"starter","to":"growth"}',    interval '7 days'),
    ('payment.success',      '{"amount":12500,"currency":"INR"}',   interval '3 days')
) AS e(event_type, metadata, age)
WHERE s.tenant_id IN (
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111112'
)
ON CONFLICT DO NOTHING;

-- ─── Platform audit log (demo) ───────────────────────────────────────────────
-- Two seed rows per active tenant so the FAM tenant detail Audit tab is
-- populated on first load. Real entries fire from suspend / extend trial /
-- impersonate / flag-toggle actions.
INSERT INTO audit_log_platform (actor_user_id, action, target_tenant_id, metadata, created_at)
SELECT
  (SELECT id FROM users WHERE email = 'niranjan@demo.co'),
  e.action, e.target, e.metadata::jsonb, now() - e.age
FROM (
  VALUES
    ('tenant.trial.extended', '11111111-1111-1111-1111-111111111111'::uuid, '{"days":7,"reason":"Onboarding goodwill"}',                 interval '5 days'),
    ('tenant.verified',       '11111111-1111-1111-1111-111111111112'::uuid, '{"gstin":"29ABCDE1234F2Z5"}',                                 interval '20 days'),
    ('tenant.plan.upgraded',  '11111111-1111-1111-1111-111111111112'::uuid, '{"from":"starter","to":"growth"}',                            interval '7 days'),
    ('tenant.note.added',     '11111111-1111-1111-1111-111111111113'::uuid, '{"note":"First-time founder, watching activation"}',         interval '2 days')
) AS e(action, target, metadata, age)
ON CONFLICT DO NOTHING;

-- ─── Verification status ─────────────────────────────────────────────────────
-- Acme Pvt was verified during onboarding (matches the audit row above);
-- Demo Co + NorthStar Labs sit in the FAM verification queue.
UPDATE tenants
SET    legal_name = 'Acme Private Limited',
       gstin      = '29ABCDE1234F2Z5',
       pan        = 'ABCDE1234F',
       industry   = 'SaaS',
       size_band  = '11-50',
       verified_at = now() - interval '20 days'
WHERE  id = '11111111-1111-1111-1111-111111111112';

UPDATE tenants
SET    legal_name = 'Demo INC',
       gstin      = '33XYZAB1234C1Z5',
       pan        = 'XYZAB1234C',
       industry   = 'Technology',
       size_band  = '11-50',
       city       = 'Chennai',
       state_code = 'TN'
WHERE  id = '11111111-1111-1111-1111-111111111111';

UPDATE tenants
SET    legal_name = 'NorthStar Labs LLP',
       gstin      = '07PQRST9876D2Z1',
       pan        = 'PQRST9876D',
       industry   = 'Manufacturing',
       size_band  = '1-10'
WHERE  id = '11111111-1111-1111-1111-111111111113';

-- ─── Feature flags ───────────────────────────────────────────────────────────
-- A few representative flags so /fam/features renders content on first load.
INSERT INTO feature_flags (flag_key, description, is_enabled_globally, enabled_tenant_ids, rollout_percentage)
VALUES
  ('beta.timesheets_v2',
   'New weekly timesheet grid with project association.',
   false,
   ARRAY['11111111-1111-1111-1111-111111111112']::uuid[],
   25),
  ('beta.org_chart',
   'Tree-style org chart with drag-to-reassign reporting lines.',
   true,
   ARRAY[]::uuid[],
   100),
  ('beta.fam_impersonation',
   'Specflicks staff can impersonate any tenant user (dual audit log).',
   false,
   ARRAY[]::uuid[],
   0)
ON CONFLICT (flag_key) DO NOTHING;

-- ─── Tenant cohorts ──────────────────────────────────────────────────────────
INSERT INTO tenant_cohorts (name, description, tenant_ids)
VALUES
  ('early-adopters',
   'First 50 paying customers — get new features 2 weeks early.',
   ARRAY['11111111-1111-1111-1111-111111111112']::uuid[]),
  ('startup-india',
   'Companies registered under the Startup India scheme — pricing perks.',
   ARRAY['11111111-1111-1111-1111-111111111113']::uuid[])
ON CONFLICT (name) DO NOTHING;

-- ─── Locations ───────────────────────────────────────────────────────────────
INSERT INTO locations (id, tenant_id, name, address_line1, city, state_code, country_code, timezone, is_active)
VALUES
  ('66666666-6666-6666-6666-666666666661', '11111111-1111-1111-1111-111111111111',
   'Bengaluru HQ', 'Indiranagar 100ft Road', 'Bengaluru', 'KA', 'IN', 'Asia/Kolkata', true),
  ('66666666-6666-6666-6666-666666666662', '11111111-1111-1111-1111-111111111111',
   'Mumbai Office', 'BKC Road', 'Mumbai', 'MH', 'IN', 'Asia/Kolkata', true)
ON CONFLICT (id) DO NOTHING;

-- ─── Departments ─────────────────────────────────────────────────────────────
INSERT INTO departments (id, tenant_id, name, description, is_active)
VALUES
  ('44444444-4444-4444-4444-444444444441', '11111111-1111-1111-1111-111111111111',
   'Engineering', 'Product engineering and platform', true),
  ('44444444-4444-4444-4444-444444444442', '11111111-1111-1111-1111-111111111111',
   'Sales', 'Customer acquisition and growth', true),
  ('44444444-4444-4444-4444-444444444443', '11111111-1111-1111-1111-111111111111',
   'Operations', 'HR, finance, and ops', true)
ON CONFLICT (id) DO NOTHING;

-- ─── Users ───────────────────────────────────────────────────────────────────
-- 1 FAM admin (Specflicks internal, not tied to Demo Co) +
-- 1 Founder/Owner + 2 Managers + 8 Employees = 12 users total.
INSERT INTO users (id, email, full_name, status)
VALUES
  ('2222222f-2222-2222-2222-22222222222f', 'fam@flickssuite.com', 'Flicks Platform Ops', 'active'), -- FAM (Specflicks internal)
  ('22222222-2222-2222-2222-222222222220', 'niranjan@demo.co', 'Niranjan V',     'active'), -- Founder / Owner of Demo Co
  ('22222222-2222-2222-2222-222222222221', 'manager@demo.co',  'Mira Manager',   'active'), -- Manager (Engineering)
  ('22222222-2222-2222-2222-222222222223', 'sarah@demo.co',    'Sarah Lead',     'active'), -- Manager (Sales)
  ('22222222-2222-2222-2222-222222222222', 'alice@demo.co',    'Alice Sharma',   'active'), -- Engineer, reports to Mira
  ('22222222-2222-2222-2222-222222222224', 'rohan@demo.co',    'Rohan Kapoor',   'active'), -- Engineer, reports to Mira
  ('22222222-2222-2222-2222-222222222225', 'diya@demo.co',     'Diya Patel',     'active'), -- Engineer, reports to Mira
  ('22222222-2222-2222-2222-222222222226', 'kabir@demo.co',    'Kabir Iyer',     'active'), -- Engineer, reports to Mira
  ('22222222-2222-2222-2222-222222222227', 'vikram@demo.co',   'Vikram Singh',   'active'), -- AE, reports to Sarah
  ('22222222-2222-2222-2222-222222222228', 'ananya@demo.co',   'Ananya Gupta',   'active'), -- AE, reports to Sarah
  ('22222222-2222-2222-2222-222222222229', 'priya@demo.co',    'Priya Reddy',    'active'), -- BDR, reports to Sarah
  ('2222222a-2222-2222-2222-22222222222a', 'tanvi@demo.co',    'Tanvi Bose',     'active')  -- HR, reports to Niranjan
ON CONFLICT (id) DO NOTHING;

-- ─── Employees ───────────────────────────────────────────────────────────────
-- Schema requires: tenant_id, user_id, employee_code, first_name, last_name,
-- work_email, employment_type, date_of_joining, status. Optional: department_id,
-- location_id, reporting_manager_id (set in a follow-up UPDATE because of self-FK).
INSERT INTO employees (id, tenant_id, user_id, employee_code, first_name, last_name, work_email,
                       employment_type, date_of_joining, status, department_id, location_id)
VALUES
  ('33333333-3333-3333-3333-333333333330', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222220',
   'EMP000', 'Niranjan', 'V',        'niranjan@demo.co', 'full_time', '2025-01-01', 'active',
   '44444444-4444-4444-4444-444444444443', '66666666-6666-6666-6666-666666666661'),
  ('33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221',
   'EMP001', 'Mira',     'Manager',  'manager@demo.co',  'full_time', '2025-01-01', 'active',
   '44444444-4444-4444-4444-444444444441', '66666666-6666-6666-6666-666666666661'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222223',
   'EMP003', 'Sarah',    'Lead',     'sarah@demo.co',    'full_time', '2025-02-15', 'active',
   '44444444-4444-4444-4444-444444444442', '66666666-6666-6666-6666-666666666662'),
  ('33333333-3333-3333-3333-333333333332', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'EMP002', 'Alice',    'Sharma',   'alice@demo.co',    'full_time', '2025-06-01', 'active',
   '44444444-4444-4444-4444-444444444441', '66666666-6666-6666-6666-666666666661'),
  ('33333333-3333-3333-3333-333333333334', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222224',
   'EMP004', 'Rohan',    'Kapoor',   'rohan@demo.co',    'full_time', '2025-07-15', 'active',
   '44444444-4444-4444-4444-444444444441', '66666666-6666-6666-6666-666666666661'),
  ('33333333-3333-3333-3333-333333333335', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222225',
   'EMP005', 'Diya',     'Patel',    'diya@demo.co',     'full_time', '2025-08-01', 'active',
   '44444444-4444-4444-4444-444444444441', '66666666-6666-6666-6666-666666666661'),
  ('33333333-3333-3333-3333-333333333336', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222226',
   'EMP006', 'Kabir',    'Iyer',     'kabir@demo.co',    'full_time', '2025-09-15', 'active',
   '44444444-4444-4444-4444-444444444441', '66666666-6666-6666-6666-666666666661'),
  ('33333333-3333-3333-3333-333333333337', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222227',
   'EMP007', 'Vikram',   'Singh',    'vikram@demo.co',   'full_time', '2025-04-01', 'active',
   '44444444-4444-4444-4444-444444444442', '66666666-6666-6666-6666-666666666662'),
  ('33333333-3333-3333-3333-333333333338', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222228',
   'EMP008', 'Ananya',   'Gupta',    'ananya@demo.co',   'full_time', '2025-10-01', 'active',
   '44444444-4444-4444-4444-444444444442', '66666666-6666-6666-6666-666666666662'),
  ('33333333-3333-3333-3333-333333333339', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222229',
   'EMP009', 'Priya',    'Reddy',    'priya@demo.co',    'full_time', '2026-01-05', 'active',
   '44444444-4444-4444-4444-444444444442', '66666666-6666-6666-6666-666666666661'),
  ('3333333a-3333-3333-3333-33333333333a', '11111111-1111-1111-1111-111111111111', '2222222a-2222-2222-2222-22222222222a',
   'EMP010', 'Tanvi',    'Bose',     'tanvi@demo.co',    'full_time', '2025-03-01', 'active',
   '44444444-4444-4444-4444-444444444443', '66666666-6666-6666-6666-666666666661')
ON CONFLICT (id) DO NOTHING;

-- ─── Reporting lines ─────────────────────────────────────────────────────────
-- Mira manages the Engineering individual contributors.
UPDATE employees
SET reporting_manager_id = '33333333-3333-3333-3333-333333333331'
WHERE id IN (
  '33333333-3333-3333-3333-333333333332', -- Alice
  '33333333-3333-3333-3333-333333333334', -- Rohan
  '33333333-3333-3333-3333-333333333335', -- Diya
  '33333333-3333-3333-3333-333333333336'  -- Kabir
);
-- Sarah manages the Sales reps.
UPDATE employees
SET reporting_manager_id = '33333333-3333-3333-3333-333333333333'
WHERE id IN (
  '33333333-3333-3333-3333-333333333337', -- Vikram
  '33333333-3333-3333-3333-333333333338', -- Ananya
  '33333333-3333-3333-3333-333333333339'  -- Priya
);
-- Niranjan oversees Tanvi (Operations), and the two managers.
UPDATE employees
SET reporting_manager_id = '33333333-3333-3333-3333-333333333330'
WHERE id IN (
  '3333333a-3333-3333-3333-33333333333a', -- Tanvi
  '33333333-3333-3333-3333-333333333331', -- Mira
  '33333333-3333-3333-3333-333333333333'  -- Sarah
);

-- Department heads
UPDATE departments SET head_employee_id = '33333333-3333-3333-3333-333333333331'
  WHERE id = '44444444-4444-4444-4444-444444444441';
UPDATE departments SET head_employee_id = '33333333-3333-3333-3333-333333333333'
  WHERE id = '44444444-4444-4444-4444-444444444442';
UPDATE departments SET head_employee_id = '3333333a-3333-3333-3333-33333333333a'
  WHERE id = '44444444-4444-4444-4444-444444444443';

-- ─── Memberships ─────────────────────────────────────────────────────────────
-- Niranjan is the founder / Owner of Demo Co — has all permissions of
-- an admin plus billing and tenant-level controls.
--
-- fam@flickssuite.com is Specflicks-internal. Membership is attached
-- to the dedicated Specflicks Platform tenant (not Demo Co), so they
-- never appear in any customer workspace's member list. The (app)
-- layout's redirect bounces role='fam' to /fam/overview, and the FAM
-- service filters the Specflicks tenant out of /fam/tenants and the
-- platform-wide aggregates.
INSERT INTO memberships (tenant_id, user_id, employee_id, role, status)
VALUES
  ('00000000-0000-0000-0000-000000000001', '2222222f-2222-2222-2222-22222222222f', NULL,                                   'fam',      'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222220', '33333333-3333-3333-3333-333333333330', 'owner',    'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'manager',  'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222223', '33333333-3333-3333-3333-333333333333', 'manager',  'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333332', 'employee', 'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222224', '33333333-3333-3333-3333-333333333334', 'employee', 'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222225', '33333333-3333-3333-3333-333333333335', 'employee', 'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222226', '33333333-3333-3333-3333-333333333336', 'employee', 'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222227', '33333333-3333-3333-3333-333333333337', 'employee', 'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222228', '33333333-3333-3333-3333-333333333338', 'employee', 'active'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222229', '33333333-3333-3333-3333-333333333339', 'employee', 'active'),
  ('11111111-1111-1111-1111-111111111111', '2222222a-2222-2222-2222-22222222222a', '3333333a-3333-3333-3333-33333333333a', 'employee', 'active')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- Force-reset roles on every re-run so testing artifacts (e.g. promoting
-- Mira to 'admin' via the UI, demoting niranjan from owner) don't bleed
-- across demo sessions. Without this, ON CONFLICT DO NOTHING above would
-- leave whatever role the row currently has in place.
UPDATE memberships SET role = 'fam'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
    AND user_id IN ('2222222f-2222-2222-2222-22222222222f');  -- Specflicks FAM

-- Sweep up any FAM admin row that may still be parked on Demo Co from
-- a prior version of this script. Idempotent: deletes 0 rows on fresh.
DELETE FROM memberships
WHERE  user_id = '2222222f-2222-2222-2222-22222222222f'
  AND  tenant_id <> '00000000-0000-0000-0000-000000000001';

UPDATE memberships SET role = 'owner'
  WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
    AND user_id IN ('22222222-2222-2222-2222-222222222220');  -- Niranjan

UPDATE memberships SET role = 'manager'
  WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
    AND user_id IN (
      '22222222-2222-2222-2222-222222222221',  -- Mira  (Engineering)
      '22222222-2222-2222-2222-222222222223'   -- Sarah (Sales)
    );

UPDATE memberships SET role = 'employee'
  WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
    AND user_id IN (
      '22222222-2222-2222-2222-222222222222',  -- Alice
      '22222222-2222-2222-2222-222222222224',  -- Rohan
      '22222222-2222-2222-2222-222222222225',  -- Diya
      '22222222-2222-2222-2222-222222222226',  -- Kabir
      '22222222-2222-2222-2222-222222222227',  -- Vikram
      '22222222-2222-2222-2222-222222222228',  -- Ananya
      '22222222-2222-2222-2222-222222222229',  -- Priya
      '2222222a-2222-2222-2222-22222222222a'   -- Tanvi
    );

-- Mark every seeded employee as onboarding-complete so the (app) layout's
-- guard doesn't redirect them to /onboarding/employee on login. Only fresh
-- magic-link invitees go through the wizard.
UPDATE employees
SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object(
  'onboarding_step', 5,
  'onboarding_completed_at', to_char(date_of_joining, 'YYYY-MM-DD"T"00:00:00.000"Z"'),
  'onboarding_submitted_for_review', true
)
WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
  AND (custom_fields IS NULL OR NOT (custom_fields ? 'onboarding_submitted_for_review'));

-- ─── Leave types ─────────────────────────────────────────────────────────────
-- Keep CL (existing); add 4 more standard Indian leave types so balances look realistic.
INSERT INTO leave_types (tenant_id, name, code, default_quota_days, is_paid, color, display_order)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Casual Leave',    'CL',  12, true, '#3E7BFA', 1),
  ('11111111-1111-1111-1111-111111111111', 'Sick Leave',      'SL',  10, true, '#F8786B', 2),
  ('11111111-1111-1111-1111-111111111111', 'Earned Leave',    'EL',  18, true, '#9B7BFA', 3),
  ('11111111-1111-1111-1111-111111111111', 'Maternity Leave', 'ML', 182, true, '#F8786B', 4),
  ('11111111-1111-1111-1111-111111111111', 'Paternity Leave', 'PL',   5, true, '#27D280', 5),
  ('11111111-1111-1111-1111-111111111111', 'Compensatory',    'CO',   0, true, '#27D280', 6),
  ('11111111-1111-1111-1111-111111111111', 'Work From Home',  'WFH',  0, true, '#3E7BFA', 7),
  ('11111111-1111-1111-1111-111111111111', 'Loss of Pay',     'LOP',  0, false,'#F8786B', 8)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- ─── Default shift template ─────────────────────────────────────────────────
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

-- ─── Holidays from default seed tenant ──────────────────────────────────────
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

-- ─── Attendance — last 30 days × 8 individual contributors ──────────────────
-- Generate one row per (employee, date) for working days only (Mon-Fri, no holiday).
-- Status mix: 88% present, 7% late, 3% on_leave, 2% work_from_home.
-- Hours are reasonable (8-9.5 hours worked, 30-60min break).
WITH ic_employees AS (
  SELECT id AS employee_id
  FROM employees
  WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
    AND id IN (
      '33333333-3333-3333-3333-333333333332', -- Alice
      '33333333-3333-3333-3333-333333333334', -- Rohan
      '33333333-3333-3333-3333-333333333335', -- Diya
      '33333333-3333-3333-3333-333333333336', -- Kabir
      '33333333-3333-3333-3333-333333333337', -- Vikram
      '33333333-3333-3333-3333-333333333338', -- Ananya
      '33333333-3333-3333-3333-333333333339', -- Priya
      '3333333a-3333-3333-3333-33333333333a'  -- Tanvi
    )
),
day_grid AS (
  SELECT (current_date - g)::date AS attendance_date
  FROM generate_series(1, 30) AS g  -- yesterday going back 30 days
  WHERE EXTRACT(DOW FROM (current_date - g)::date) NOT IN (0, 6) -- skip Sun + Sat
),
joined AS (
  SELECT
    e.employee_id,
    d.attendance_date,
    -- deterministic-but-varied "random" via hash so re-runs don't churn
    (abs(hashtext(e.employee_id::text || d.attendance_date::text)) % 100) AS r
  FROM ic_employees e
  CROSS JOIN day_grid d
  WHERE NOT EXISTS (
    SELECT 1 FROM holidays h
    WHERE h.tenant_id = '11111111-1111-1111-1111-111111111111'
      AND h.holiday_date = d.attendance_date
  )
)
INSERT INTO attendance_records (
  tenant_id, employee_id, attendance_date, shift_template_id,
  first_punch_in_at, last_punch_out_at,
  total_break_minutes, total_worked_minutes,
  is_late, late_by_minutes,
  attendance_status, source
)
SELECT
  '11111111-1111-1111-1111-111111111111',
  j.employee_id,
  j.attendance_date,
  '55555555-5555-4555-8555-555555555555',
  -- punch-in: 09:00 IST nominal; late rows shift by 16-25 min
  (j.attendance_date + time '03:30' + (CASE
    WHEN j.r < 88 THEN make_interval(mins => (j.r % 15))             -- 0-14min after 9 (on time)
    WHEN j.r < 95 THEN make_interval(mins => 16 + (j.r % 10))        -- 16-25min late
    ELSE make_interval(mins => 0)                                    -- not used (on_leave/wfh have no clock)
  END))::timestamptz,
  -- punch-out: ~18:00-19:30 IST
  (j.attendance_date + time '12:30' + make_interval(mins => 30 + (j.r % 60)))::timestamptz,
  30 + (j.r % 30),  -- 30-59min break
  -- worked minutes: ~8h-9h30
  480 + (j.r % 90),
  CASE WHEN j.r >= 88 AND j.r < 95 THEN true ELSE false END,
  CASE WHEN j.r >= 88 AND j.r < 95 THEN 16 + (j.r % 10) ELSE 0 END,
  CASE
    WHEN j.r < 88 THEN 'present'::attendance_status
    WHEN j.r < 95 THEN 'late'::attendance_status
    WHEN j.r < 98 THEN 'on_leave'::attendance_status
    ELSE 'work_from_home'::attendance_status
  END,
  'system'::attendance_source
FROM joined j
ON CONFLICT DO NOTHING;

-- ─── Leave requests — 4 in mixed states ─────────────────────────────────────
-- Pending: Alice → 2 CL, applied this week
INSERT INTO leave_requests (id, tenant_id, employee_id, leave_type_id, start_date, end_date,
                            is_half_day, total_days, reason, status, approver_id, applied_at)
SELECT
  '77777777-7777-7777-7777-777777777771',
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333332',  -- Alice
  lt.id,
  current_date + 3, current_date + 4,
  false, 2,
  'Family wedding in Chennai. Will be reachable on Slack for urgent items.',
  'pending',
  '33333333-3333-3333-3333-333333333331',  -- Mira approves
  now() - interval '6 hours'
FROM leave_types lt
WHERE lt.tenant_id = '11111111-1111-1111-1111-111111111111' AND lt.code = 'CL'
ON CONFLICT (id) DO NOTHING;

-- Approved: Rohan → 1 SL, last week
INSERT INTO leave_requests (id, tenant_id, employee_id, leave_type_id, start_date, end_date,
                            is_half_day, total_days, reason, status, approver_id,
                            approver_comment, applied_at, approved_at)
SELECT
  '77777777-7777-7777-7777-777777777772',
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333334',  -- Rohan
  lt.id,
  current_date - 5, current_date - 5,
  false, 1,
  'Fever and body ache. Resting at home.',
  'approved',
  '33333333-3333-3333-3333-333333333331',  -- Mira
  'Get well soon!',
  now() - interval '6 days', now() - interval '6 days' + interval '4 hours'
FROM leave_types lt
WHERE lt.tenant_id = '11111111-1111-1111-1111-111111111111' AND lt.code = 'SL'
ON CONFLICT (id) DO NOTHING;

-- Approved (longer): Vikram → 4 EL, two weeks ago
INSERT INTO leave_requests (id, tenant_id, employee_id, leave_type_id, start_date, end_date,
                            is_half_day, total_days, reason, status, approver_id,
                            approver_comment, applied_at, approved_at)
SELECT
  '77777777-7777-7777-7777-777777777773',
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333337',  -- Vikram
  lt.id,
  current_date - 14, current_date - 11,
  false, 4,
  'Vacation in Goa with family.',
  'approved',
  '33333333-3333-3333-3333-333333333333',  -- Sarah
  'Enjoy! Coverage by Ananya.',
  now() - interval '20 days', now() - interval '19 days'
FROM leave_types lt
WHERE lt.tenant_id = '11111111-1111-1111-1111-111111111111' AND lt.code = 'EL'
ON CONFLICT (id) DO NOTHING;

-- Rejected: Diya → CL with too short notice
INSERT INTO leave_requests (id, tenant_id, employee_id, leave_type_id, start_date, end_date,
                            is_half_day, total_days, reason, status, approver_id,
                            approver_comment, applied_at, rejected_at)
SELECT
  '77777777-7777-7777-7777-777777777774',
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333335',  -- Diya
  lt.id,
  current_date - 1, current_date - 1,
  false, 1,
  'Personal',
  'rejected',
  '33333333-3333-3333-3333-333333333331',  -- Mira
  'Need at least 1 day notice. Please regularise as WFH if needed.',
  now() - interval '2 days', now() - interval '2 days' + interval '2 hours'
FROM leave_types lt
WHERE lt.tenant_id = '11111111-1111-1111-1111-111111111111' AND lt.code = 'CL'
ON CONFLICT (id) DO NOTHING;

-- ─── Refresh leave-request dates on re-run ──────────────────────────────────
-- The 4 seeded leave_requests use fixed UUIDs with ON CONFLICT DO NOTHING, so
-- re-running setup-demo doesn't change them. That can leave dates stranded in
-- a previous calendar year, which makes the Used YTD column on Settings →
-- Leave policy read 0 instead of the actual value. Refresh dates here so the
-- demo always shows believable, current-year activity.
UPDATE leave_requests
SET start_date = current_date + 3, end_date = current_date + 4,
    applied_at = now() - interval '6 hours'
WHERE id = '77777777-7777-7777-7777-777777777771';

UPDATE leave_requests
SET start_date = current_date - 5, end_date = current_date - 5,
    applied_at = now() - interval '6 days',
    approved_at = now() - interval '6 days' + interval '4 hours'
WHERE id = '77777777-7777-7777-7777-777777777772';

UPDATE leave_requests
SET start_date = current_date - 14, end_date = current_date - 11,
    applied_at = now() - interval '20 days',
    approved_at = now() - interval '19 days'
WHERE id = '77777777-7777-7777-7777-777777777773';

UPDATE leave_requests
SET start_date = current_date - 1, end_date = current_date - 1,
    applied_at = now() - interval '2 days',
    rejected_at = now() - interval '2 days' + interval '2 hours'
WHERE id = '77777777-7777-7777-7777-777777777774';

-- ─── Regularizations — 2 pending ─────────────────────────────────────────────
INSERT INTO attendance_regularizations (id, tenant_id, employee_id, attendance_date, request_type,
                                        proposed_in_time, proposed_out_time, reason, status, approver_id)
VALUES
  -- Kabir forgot to clock in two days ago
  ('88888888-8888-8888-8888-888888888881',
   '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333336',  -- Kabir
   current_date - 2,
   'missing_punch',
   (current_date - 2 + time '03:30' + interval '10 minutes')::timestamptz,
   (current_date - 2 + time '12:30' + interval '20 minutes')::timestamptz,
   'Forgot to clock in due to a 9:30 client call. Was at the office the whole day.',
   'pending',
   '33333333-3333-3333-3333-333333333331'),  -- Mira
  -- Ananya was working from home but was marked late
  ('88888888-8888-8888-8888-888888888882',
   '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333338',  -- Ananya
   current_date - 4,
   'wfh_request',
   (current_date - 4 + time '03:30')::timestamptz,
   (current_date - 4 + time '12:30')::timestamptz,
   'Was working from home for the morning to handle internet outage at office.',
   'pending',
   '33333333-3333-3333-3333-333333333333')   -- Sarah
ON CONFLICT (id) DO NOTHING;

SQL

echo "✅ Demo data ready (rich seed)."
echo
echo "Tenant:    Demo Co"
echo "Locations: Bengaluru HQ, Mumbai Office"
echo "Depts:     Engineering, Sales, Operations"
echo
echo "Login candidates (OTP printed in API server log):"
echo "  • niranjan@demo.co  (admin / future Owner)"
echo "  • manager@demo.co   (manager Mira — Engineering)"
echo "  • sarah@demo.co     (manager Sarah — Sales)"
echo "  • alice@demo.co     (employee — applies for leave)"
echo "  • rohan@demo.co  diya@demo.co  kabir@demo.co  vikram@demo.co  ananya@demo.co  priya@demo.co  tanvi@demo.co"
echo
echo "Pre-seeded:"
echo "  • 30 days × 8 employees of attendance history (mostly present, some late)"
echo "  • 4 leave requests (1 pending, 2 approved, 1 rejected)"
echo "  • 2 attendance regularizations (pending)"
echo "  • 8 leave types (CL, SL, EL, ML, PL, CO, WFH, LOP) + 25 holidays"
