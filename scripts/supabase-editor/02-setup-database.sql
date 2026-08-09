-- =============================================================================
-- STEP 2 of the dashboard-only deploy — full database setup.
-- Paste into: Supabase Dashboard -> SQL Editor -> New query.
--
-- BEFORE CLICKING RUN:
--   Use the editor's find & replace (Ctrl/Cmd+F) to replace ALL occurrences of
--       REPLACE_WITH_APP_ROLE_PASSWORD
--   with the APP_ROLE_PASSWORD value from your password manager (generated in
--   step 1 — hex characters only, so quoting is never an issue).
--
-- This file is the SQL-editor equivalent of `pnpm sync:supabase`:
--   the flicks_app RLS-enforced role + all 48 migrations + grants + lockdowns
--   + the seed tenant. Intended for a FRESH (empty) Supabase project.
--   If it errors partway, copy the error message and ask for help before
--   re-running. (Running it a SECOND time on an already-set-up project stops
--   immediately at "type tenant_status already exists" — that error is
--   harmless and just means the setup already ran.)
-- =============================================================================

-- Guard: refuses to run until the password placeholder has been replaced.
DO $guard$
BEGIN
  IF 'REPLACE_WITH_APP_ROLE_PASSWORD' = 'REPLACE_WITH' || '_APP_ROLE_PASSWORD' THEN
    RAISE EXCEPTION 'STOP: replace REPLACE_WITH_APP_ROLE_PASSWORD with your real APP_ROLE_PASSWORD first (find & replace, all occurrences), then Run again.';
  END IF;
END
$guard$;

-- ── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── App role FIRST (several migrations grant to it) ──────────────────────────
-- NOBYPASSRLS is what makes tenant isolation real. Mirrors setup-database.sh
-- step 5, but runs BEFORE the migrations so a fresh project can apply the
-- grant statements inside them.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flicks_app') THEN
    CREATE ROLE "flicks_app" WITH LOGIN PASSWORD 'REPLACE_WITH_APP_ROLE_PASSWORD'
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
  ELSE
    ALTER ROLE "flicks_app" WITH LOGIN PASSWORD 'REPLACE_WITH_APP_ROLE_PASSWORD' NOBYPASSRLS;
  END IF;
END
$role$;

-- Let the dashboard user run the RLS gate (step 3) via SET ROLE.
DO $mem$
BEGIN
  GRANT "flicks_app" TO postgres;
EXCEPTION WHEN OTHERS THEN NULL; -- already granted / not needed locally
END
$mem$;


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0001_initial.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- Flicks Suite — Initial Database Migration
-- PostgreSQL 17 (Supabase)
-- =============================================================================
-- All tenant-scoped tables have RLS enabled.
-- Platform tables (tenants, users, auth_*) use service role — no RLS.
-- =============================================================================

-- ─── Extensions ───────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for ILIKE index support

-- =============================================================================
-- ENUMS
-- =============================================================================

-- Platform
CREATE TYPE tenant_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'suspended');
CREATE TYPE membership_role AS ENUM ('super_admin', 'admin', 'manager', 'finance', 'employee');
CREATE TYPE membership_status AS ENUM ('invited', 'active', 'deactivated');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');

-- Auth
CREATE TYPE auth_event_type AS ENUM (
  'otp_requested', 'otp_verified', 'otp_failed',
  'magic_link_requested', 'magic_link_consumed',
  'login_success', 'login_failed', 'logout',
  'token_refreshed', 'token_revoked',
  'device_trusted', 'device_revoked',
  'password_changed', 'account_locked', 'account_unlocked'
);

-- Employees
CREATE TYPE employment_type AS ENUM ('full_time', 'part_time', 'contract', 'intern', 'consultant', 'probation');
CREATE TYPE employee_status AS ENUM ('active', 'inactive', 'on_leave', 'notice_period', 'separated', 'absconded');
CREATE TYPE gender AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');
CREATE TYPE marital_status AS ENUM ('single', 'married', 'divorced', 'widowed', 'separated');
CREATE TYPE blood_group AS ENUM ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-');
CREATE TYPE bank_account_type AS ENUM ('savings', 'current', 'salary');
CREATE TYPE document_type AS ENUM (
  'pan_card', 'aadhaar_card', 'passport', 'driving_license', 'voter_id',
  'offer_letter', 'appointment_letter', 'experience_letter',
  'education_certificate', 'salary_slip', 'bank_statement', 'other'
);
CREATE TYPE document_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE employment_change_type AS ENUM (
  'hire', 'promotion', 'demotion', 'transfer', 'salary_revision',
  'role_change', 'department_change', 'location_change', 'manager_change',
  'separation', 'rehire', 'status_change'
);
CREATE TYPE consent_type AS ENUM (
  'data_processing', 'marketing', 'background_check', 'biometric_data', 'third_party_sharing'
);

-- Attendance
CREATE TYPE attendance_status AS ENUM (
  'present', 'absent', 'half_day', 'late', 'on_leave',
  'holiday', 'weekend', 'work_from_home', 'on_duty', 'comp_off'
);
CREATE TYPE attendance_source AS ENUM ('web', 'mobile', 'biometric', 'manual', 'system');
CREATE TYPE punch_type AS ENUM ('in', 'out', 'break_start', 'break_end');
CREATE TYPE regularization_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
CREATE TYPE regularization_request_type AS ENUM (
  'missing_punch', 'wrong_time', 'wfh_request', 'on_duty', 'manual_override'
);

-- Leave
CREATE TYPE leave_accrual_method AS ENUM ('none', 'monthly', 'quarterly', 'annually', 'per_working_day');
CREATE TYPE leave_prorate_basis AS ENUM ('none', 'days_remaining_in_year', 'months_remaining_in_year', 'calendar_days');
CREATE TYPE leave_encashment_basis AS ENUM ('none', 'basic_salary', 'gross_salary', 'ctc');
CREATE TYPE leave_request_status AS ENUM ('draft', 'pending', 'approved', 'rejected', 'cancelled', 'revoked');
CREATE TYPE half_day_session AS ENUM ('first_half', 'second_half');
CREATE TYPE holiday_type AS ENUM ('national', 'regional', 'optional', 'restricted', 'company');
CREATE TYPE calendar_event_type AS ENUM ('leave', 'holiday', 'attendance', 'birthday', 'anniversary', 'company_event');
CREATE TYPE calendar_visibility AS ENUM ('private', 'team', 'company');

-- Timesheet
CREATE TYPE timesheet_status AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'locked');
CREATE TYPE timesheet_entry_category AS ENUM (
  'development', 'design', 'testing', 'management', 'meetings',
  'research', 'documentation', 'support', 'training', 'admin', 'other'
);

-- FAM
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'paused', 'unpaid');
CREATE TYPE billing_cycle AS ENUM ('monthly', 'quarterly', 'annual');
CREATE TYPE health_signal AS ENUM ('healthy', 'at_risk', 'churning', 'expanding', 'new');

-- =============================================================================
-- PLATFORM TABLES (no RLS — accessed via service role)
-- =============================================================================

-- ─── tenants ──────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT NOT NULL,
  slug                      TEXT NOT NULL,
  legal_name                TEXT,
  gstin                     TEXT,
  pan                       TEXT,
  cin                       TEXT,
  industry                  TEXT,
  size_band                 TEXT,
  country_code              TEXT NOT NULL DEFAULT 'IN',
  state_code                TEXT,
  city                      TEXT,
  address_line1             TEXT,
  address_line2             TEXT,
  postal_code               TEXT,
  timezone                  TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency                  TEXT NOT NULL DEFAULT 'INR',
  fiscal_year_start_month   INTEGER NOT NULL DEFAULT 4,
  date_format               TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
  working_days              TEXT[] NOT NULL DEFAULT ARRAY['MON','TUE','WED','THU','FRI'],
  default_work_start        TEXT NOT NULL DEFAULT '09:00',
  default_work_end          TEXT NOT NULL DEFAULT '18:00',
  logo_url                  TEXT,
  brand_color               TEXT,
  status                    tenant_status NOT NULL DEFAULT 'trialing',
  trial_ends_at             TIMESTAMPTZ,
  verified_at               TIMESTAMPTZ,
  verified_by_user_id       UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX tenants_slug_unique ON tenants (slug);
CREATE INDEX tenants_status_idx ON tenants (status);
CREATE INDEX tenants_deleted_at_idx ON tenants (deleted_at) WHERE deleted_at IS NOT NULL;

-- ─── users ────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               CITEXT NOT NULL,
  email_verified_at   TIMESTAMPTZ,
  full_name           TEXT NOT NULL,
  avatar_url          TEXT,
  phone               TEXT,
  phone_verified_at   TIMESTAMPTZ,
  locale              TEXT NOT NULL DEFAULT 'en-IN',
  timezone            TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  is_platform_admin   BOOLEAN NOT NULL DEFAULT FALSE,
  status              user_status NOT NULL DEFAULT 'active',
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE INDEX users_status_idx ON users (status);

-- ─── memberships ──────────────────────────────────────────────────────────────

CREATE TABLE memberships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  employee_id   UUID,
  role          membership_role NOT NULL DEFAULT 'employee',
  status        membership_status NOT NULL DEFAULT 'invited',
  invited_by    UUID REFERENCES users (id) ON DELETE SET NULL,
  invited_at    TIMESTAMPTZ DEFAULT NOW(),
  accepted_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX memberships_tenant_user_unique ON memberships (tenant_id, user_id);
CREATE INDEX memberships_tenant_id_idx ON memberships (tenant_id);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);
CREATE INDEX memberships_role_idx ON memberships (role);
CREATE INDEX memberships_status_idx ON memberships (status);

-- =============================================================================
-- AUTH TABLES (no RLS — platform-level, service role only)
-- =============================================================================

-- ─── auth_otps ────────────────────────────────────────────────────────────────

CREATE TABLE auth_otps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL,
  user_id           UUID REFERENCES users (id) ON DELETE SET NULL,
  otp_hash          CHAR(64),
  magic_link_token  CHAR(64),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  ip_address        TEXT,
  user_agent        TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_otps_email_idx ON auth_otps (email);
CREATE INDEX auth_otps_magic_link_token_idx ON auth_otps (magic_link_token) WHERE magic_link_token IS NOT NULL;
CREATE INDEX auth_otps_expires_at_idx ON auth_otps (expires_at);
CREATE INDEX auth_otps_user_id_idx ON auth_otps (user_id) WHERE user_id IS NOT NULL;

-- ─── refresh_tokens ───────────────────────────────────────────────────────────

CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id     UUID,
  token_hash    CHAR(64) NOT NULL UNIQUE,
  device_id     TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  rotated_to    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_token_hash_idx ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_tenant_id_idx ON refresh_tokens (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- ─── trusted_devices ──────────────────────────────────────────────────────────

CREATE TABLE trusted_devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  device_name   TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX trusted_devices_user_device_unique ON trusted_devices (user_id, device_id);
CREATE INDEX trusted_devices_user_id_idx ON trusted_devices (user_id);
CREATE INDEX trusted_devices_device_id_idx ON trusted_devices (device_id);

-- ─── auth_events ──────────────────────────────────────────────────────────────

CREATE TABLE auth_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT,
  user_id     UUID REFERENCES users (id) ON DELETE SET NULL,
  event_type  auth_event_type NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  device_id   TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_events_user_id_idx ON auth_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX auth_events_email_idx ON auth_events (email) WHERE email IS NOT NULL;
CREATE INDEX auth_events_event_type_idx ON auth_events (event_type);
CREATE INDEX auth_events_created_at_idx ON auth_events (created_at);

-- =============================================================================
-- EMPLOYEE TABLES (RLS enforced)
-- =============================================================================

-- ─── departments ──────────────────────────────────────────────────────────────

CREATE TABLE departments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  code              TEXT,
  parent_id         UUID REFERENCES departments (id) ON DELETE SET NULL,
  head_employee_id  UUID,
  description       TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX departments_tenant_name_unique ON departments (tenant_id, name);
CREATE INDEX departments_tenant_id_idx ON departments (tenant_id);
CREATE INDEX departments_parent_id_idx ON departments (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX departments_is_active_idx ON departments (is_active);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_departments ON departments
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── designations ─────────────────────────────────────────────────────────────

CREATE TABLE designations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  level           INTEGER,
  department_id   UUID REFERENCES departments (id) ON DELETE SET NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX designations_tenant_id_idx ON designations (tenant_id);
CREATE INDEX designations_department_id_idx ON designations (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX designations_is_active_idx ON designations (is_active);

ALTER TABLE designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE designations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_designations ON designations
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── locations ────────────────────────────────────────────────────────────────

CREATE TABLE locations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT,
  state_code          TEXT,
  postal_code         TEXT,
  country_code        TEXT NOT NULL DEFAULT 'IN',
  timezone            TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  geofence_lat        TEXT,
  geofence_lng        TEXT,
  geofence_radius_m   INTEGER,
  ip_allowlist        TEXT[],
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX locations_tenant_id_idx ON locations (tenant_id);
CREATE INDEX locations_is_active_idx ON locations (is_active);

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_locations ON locations
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── employees ────────────────────────────────────────────────────────────────

CREATE TABLE employees (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id                         UUID REFERENCES users (id) ON DELETE SET NULL,
  employee_code                   TEXT NOT NULL,

  -- Name
  first_name                      TEXT NOT NULL,
  middle_name                     TEXT,
  last_name                       TEXT NOT NULL,
  preferred_name                  TEXT,
  full_name                       TEXT GENERATED ALWAYS AS (
                                    TRIM(
                                      COALESCE(first_name, '') || ' ' ||
                                      COALESCE(middle_name || ' ', '') ||
                                      COALESCE(last_name, '')
                                    )
                                  ) STORED,

  -- Contact
  work_email                      TEXT NOT NULL,
  personal_email                  TEXT,
  work_phone                      TEXT,
  personal_phone                  TEXT,

  -- Org
  department_id                   UUID REFERENCES departments (id) ON DELETE SET NULL,
  designation_id                  UUID REFERENCES designations (id) ON DELETE SET NULL,
  location_id                     UUID REFERENCES locations (id) ON DELETE SET NULL,
  reporting_manager_id            UUID REFERENCES employees (id) ON DELETE SET NULL,

  -- Employment
  employment_type                 employment_type NOT NULL DEFAULT 'full_time',
  date_of_joining                 DATE NOT NULL,
  date_of_confirmation            DATE,
  probation_end_date              DATE,
  date_of_exit                    DATE,
  exit_reason                     TEXT,
  notice_period_days              INTEGER DEFAULT 30,

  -- Personal
  date_of_birth                   DATE,
  gender                          gender,
  marital_status                  marital_status,
  nationality                     TEXT DEFAULT 'Indian',
  blood_group                     blood_group,

  -- Addresses (jsonb)
  current_address                 JSONB,
  permanent_address               JSONB,

  -- Sensitive / Encrypted at application layer
  pan_encrypted                   TEXT,
  aadhaar_last4                   TEXT,
  passport_number_encrypted       TEXT,

  -- Bank
  bank_account_holder             TEXT,
  bank_account_number_encrypted   TEXT,
  bank_ifsc                       TEXT,
  bank_name                       TEXT,
  bank_branch                     TEXT,
  bank_account_type               bank_account_type,

  -- Statutory
  pf_uan                          TEXT,
  esic_number                     TEXT,
  pt_state                        TEXT,
  pf_applicable                   BOOLEAN NOT NULL DEFAULT TRUE,
  esi_applicable                  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Meta
  status                          employee_status NOT NULL DEFAULT 'active',
  avatar_url                      TEXT,
  custom_fields                   JSONB,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                      UUID REFERENCES users (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX employees_tenant_code_unique ON employees (tenant_id, employee_code);
CREATE UNIQUE INDEX employees_tenant_work_email_unique ON employees (tenant_id, work_email);
CREATE INDEX employees_tenant_id_idx ON employees (tenant_id);
CREATE INDEX employees_user_id_idx ON employees (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX employees_status_idx ON employees (status);
CREATE INDEX employees_department_id_idx ON employees (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX employees_designation_id_idx ON employees (designation_id) WHERE designation_id IS NOT NULL;
CREATE INDEX employees_location_id_idx ON employees (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX employees_reporting_manager_id_idx ON employees (reporting_manager_id) WHERE reporting_manager_id IS NOT NULL;
CREATE INDEX employees_date_of_joining_idx ON employees (date_of_joining);
CREATE INDEX employees_employment_type_idx ON employees (employment_type);

-- Back-patch the FK from departments.head_employee_id
ALTER TABLE departments
  ADD CONSTRAINT departments_head_employee_id_fkey
  FOREIGN KEY (head_employee_id) REFERENCES employees (id) ON DELETE SET NULL;

-- Back-patch the FK from memberships.employee_id
ALTER TABLE memberships
  ADD CONSTRAINT memberships_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL;

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employees ON employees
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── emergency_contacts ───────────────────────────────────────────────────────

CREATE TABLE emergency_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  relationship  TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email         TEXT,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX emergency_contacts_tenant_id_idx ON emergency_contacts (tenant_id);
CREATE INDEX emergency_contacts_employee_id_idx ON emergency_contacts (employee_id);

ALTER TABLE emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_emergency_contacts ON emergency_contacts
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── employee_documents ───────────────────────────────────────────────────────

CREATE TABLE employee_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  document_type     document_type NOT NULL,
  file_name         TEXT NOT NULL,
  file_size_bytes   INTEGER,
  mime_type         TEXT,
  r2_key            TEXT NOT NULL,
  uploaded_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  status            document_status NOT NULL DEFAULT 'pending',
  reviewed_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX employee_documents_tenant_id_idx ON employee_documents (tenant_id);
CREATE INDEX employee_documents_employee_id_idx ON employee_documents (employee_id);
CREATE INDEX employee_documents_status_idx ON employee_documents (status);
CREATE INDEX employee_documents_document_type_idx ON employee_documents (document_type);

ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employee_documents ON employee_documents
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── employee_invitations ─────────────────────────────────────────────────────

CREATE TABLE employee_invitations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  resent_count  INTEGER NOT NULL DEFAULT 0,
  invited_by    UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX employee_invitations_tenant_id_idx ON employee_invitations (tenant_id);
CREATE INDEX employee_invitations_employee_id_idx ON employee_invitations (employee_id);
CREATE INDEX employee_invitations_email_idx ON employee_invitations (email);
CREATE INDEX employee_invitations_expires_at_idx ON employee_invitations (expires_at);

ALTER TABLE employee_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employee_invitations ON employee_invitations
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── employment_history ───────────────────────────────────────────────────────

CREATE TABLE employment_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  change_type       employment_change_type NOT NULL,
  previous_value    JSONB,
  new_value         JSONB,
  effective_from    DATE NOT NULL,
  reason            TEXT,
  changed_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX employment_history_tenant_id_idx ON employment_history (tenant_id);
CREATE INDEX employment_history_employee_id_idx ON employment_history (employee_id);
CREATE INDEX employment_history_change_type_idx ON employment_history (change_type);
CREATE INDEX employment_history_effective_from_idx ON employment_history (effective_from);

ALTER TABLE employment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employment_history ON employment_history
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── data_consents ────────────────────────────────────────────────────────────

CREATE TABLE data_consents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  consent_type      consent_type NOT NULL,
  purpose           TEXT,
  granted           BOOLEAN NOT NULL,
  consent_version   TEXT NOT NULL,
  ip_address        TEXT,
  user_agent        TEXT,
  granted_at        TIMESTAMPTZ,
  withdrawn_at      TIMESTAMPTZ
);

CREATE INDEX data_consents_tenant_id_idx ON data_consents (tenant_id);
CREATE INDEX data_consents_user_id_idx ON data_consents (user_id);
CREATE INDEX data_consents_consent_type_idx ON data_consents (consent_type);

ALTER TABLE data_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_data_consents ON data_consents
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- ATTENDANCE TABLES (RLS enforced)
-- =============================================================================

-- ─── shift_templates ──────────────────────────────────────────────────────────

CREATE TABLE shift_templates (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  description                 TEXT,
  start_time                  TEXT NOT NULL,
  end_time                    TEXT NOT NULL,
  is_overnight                BOOLEAN NOT NULL DEFAULT FALSE,
  break_minutes               INTEGER NOT NULL DEFAULT 60,
  break_paid                  BOOLEAN NOT NULL DEFAULT FALSE,
  working_days                SMALLINT[] NOT NULL,
  timezone                    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  grace_period_minutes        INTEGER NOT NULL DEFAULT 15,
  half_day_threshold_minutes  INTEGER NOT NULL DEFAULT 240,
  full_day_threshold_minutes  INTEGER NOT NULL DEFAULT 480,
  is_default                  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shift_templates_tenant_id_idx ON shift_templates (tenant_id);
CREATE INDEX shift_templates_is_active_idx ON shift_templates (is_active);

ALTER TABLE shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_shift_templates ON shift_templates
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── employee_shifts ──────────────────────────────────────────────────────────

CREATE TABLE employee_shifts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id         UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  shift_template_id   UUID NOT NULL REFERENCES shift_templates (id) ON DELETE RESTRICT,
  effective_from      DATE NOT NULL,
  effective_to        DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX employee_shifts_tenant_id_idx ON employee_shifts (tenant_id);
CREATE INDEX employee_shifts_employee_id_idx ON employee_shifts (employee_id);
CREATE INDEX employee_shifts_effective_from_idx ON employee_shifts (effective_from);

ALTER TABLE employee_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employee_shifts ON employee_shifts
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── attendance_regularizations ───────────────────────────────────────────────

-- Must be created before attendance_records due to FK
CREATE TABLE attendance_regularizations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id           UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  attendance_date       DATE NOT NULL,
  request_type          regularization_request_type NOT NULL,
  proposed_in_time      TIMESTAMPTZ,
  proposed_out_time     TIMESTAMPTZ,
  reason                TEXT NOT NULL,
  status                regularization_status NOT NULL DEFAULT 'pending',
  approver_id           UUID REFERENCES employees (id) ON DELETE SET NULL,
  approver_comment      TEXT,
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX attendance_regularizations_tenant_id_idx ON attendance_regularizations (tenant_id);
CREATE INDEX attendance_regularizations_employee_id_idx ON attendance_regularizations (employee_id);
CREATE INDEX attendance_regularizations_attendance_date_idx ON attendance_regularizations (attendance_date);
CREATE INDEX attendance_regularizations_status_idx ON attendance_regularizations (status);

ALTER TABLE attendance_regularizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_regularizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_attendance_regularizations ON attendance_regularizations
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── attendance_records ───────────────────────────────────────────────────────

CREATE TABLE attendance_records (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id                 UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  attendance_date             DATE NOT NULL,
  shift_template_id           UUID REFERENCES shift_templates (id) ON DELETE SET NULL,
  first_punch_in_at           TIMESTAMPTZ,
  last_punch_out_at           TIMESTAMPTZ,
  total_break_minutes         INTEGER NOT NULL DEFAULT 0,
  total_worked_minutes        INTEGER NOT NULL DEFAULT 0,
  is_late                     BOOLEAN NOT NULL DEFAULT FALSE,
  late_by_minutes             INTEGER NOT NULL DEFAULT 0,
  is_early_departure          BOOLEAN NOT NULL DEFAULT FALSE,
  early_by_minutes            INTEGER NOT NULL DEFAULT 0,
  is_overtime                 BOOLEAN NOT NULL DEFAULT FALSE,
  overtime_minutes            INTEGER NOT NULL DEFAULT 0,
  attendance_status           attendance_status NOT NULL DEFAULT 'absent',
  source                      attendance_source NOT NULL DEFAULT 'system',
  notes                       TEXT,
  is_regularized              BOOLEAN NOT NULL DEFAULT FALSE,
  regularization_request_id   UUID REFERENCES attendance_regularizations (id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX attendance_records_tenant_employee_date_unique
  ON attendance_records (tenant_id, employee_id, attendance_date);
CREATE INDEX attendance_records_tenant_id_idx ON attendance_records (tenant_id);
CREATE INDEX attendance_records_employee_id_idx ON attendance_records (employee_id);
CREATE INDEX attendance_records_attendance_date_idx ON attendance_records (attendance_date);
CREATE INDEX attendance_records_status_idx ON attendance_records (attendance_status);

ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_attendance_records ON attendance_records
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── attendance_punches ───────────────────────────────────────────────────────

CREATE TABLE attendance_punches (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  attendance_record_id    UUID NOT NULL REFERENCES attendance_records (id) ON DELETE CASCADE,
  employee_id             UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  punch_type              punch_type NOT NULL,
  punched_at              TIMESTAMPTZ NOT NULL,
  source                  attendance_source NOT NULL DEFAULT 'web',
  ip_address              TEXT,
  user_agent              TEXT,
  geo_lat                 REAL,
  geo_lng                 REAL,
  geo_accuracy_m          REAL,
  location_id             UUID REFERENCES locations (id) ON DELETE SET NULL,
  is_within_geofence      BOOLEAN,
  is_within_ip_allowlist  BOOLEAN,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX attendance_punches_tenant_id_idx ON attendance_punches (tenant_id);
CREATE INDEX attendance_punches_attendance_record_id_idx ON attendance_punches (attendance_record_id);
CREATE INDEX attendance_punches_employee_id_idx ON attendance_punches (employee_id);
CREATE INDEX attendance_punches_punched_at_idx ON attendance_punches (punched_at);

ALTER TABLE attendance_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_punches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_attendance_punches ON attendance_punches
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- LEAVE TABLES (RLS enforced)
-- =============================================================================

-- ─── leave_types ──────────────────────────────────────────────────────────────

CREATE TABLE leave_types (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  code                        TEXT NOT NULL,
  description                 TEXT,
  default_quota_days          REAL NOT NULL DEFAULT 0,
  prorate_for_new_joiners     BOOLEAN NOT NULL DEFAULT TRUE,
  prorate_basis               leave_prorate_basis NOT NULL DEFAULT 'months_remaining_in_year',
  accrual_method              leave_accrual_method NOT NULL DEFAULT 'none',
  accrual_day_of_month        INTEGER DEFAULT 1,
  carry_forward_allowed       BOOLEAN NOT NULL DEFAULT FALSE,
  max_carry_forward_days      REAL DEFAULT 0,
  encashable                  BOOLEAN NOT NULL DEFAULT FALSE,
  encashment_basis            leave_encashment_basis NOT NULL DEFAULT 'none',
  min_notice_days             INTEGER NOT NULL DEFAULT 0,
  max_consecutive_days        INTEGER,
  allow_half_day              BOOLEAN NOT NULL DEFAULT TRUE,
  allow_quarter_day           BOOLEAN NOT NULL DEFAULT FALSE,
  requires_attachment         BOOLEAN NOT NULL DEFAULT FALSE,
  attachment_after_days       INTEGER DEFAULT 3,
  auto_approve_below_days     REAL DEFAULT 0,
  count_weekend_in_between    BOOLEAN NOT NULL DEFAULT FALSE,
  applicable_employment_types TEXT[],
  applicable_genders          TEXT[],
  min_tenure_days             INTEGER NOT NULL DEFAULT 0,
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  is_paid                     BOOLEAN NOT NULL DEFAULT TRUE,
  is_lop                      BOOLEAN NOT NULL DEFAULT FALSE,
  display_order               INTEGER NOT NULL DEFAULT 0,
  color                       TEXT DEFAULT '#6366f1',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX leave_types_tenant_code_unique ON leave_types (tenant_id, code);
CREATE INDEX leave_types_tenant_id_idx ON leave_types (tenant_id);
CREATE INDEX leave_types_is_active_idx ON leave_types (is_active);
CREATE INDEX leave_types_display_order_idx ON leave_types (display_order);

ALTER TABLE leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_leave_types ON leave_types
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── leave_balances ───────────────────────────────────────────────────────────

CREATE TABLE leave_balances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id         UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  leave_type_id       UUID NOT NULL REFERENCES leave_types (id) ON DELETE CASCADE,
  leave_year          INTEGER NOT NULL,
  opening_balance     REAL NOT NULL DEFAULT 0,
  accrued             REAL NOT NULL DEFAULT 0,
  used                REAL NOT NULL DEFAULT 0,
  pending             REAL NOT NULL DEFAULT 0,
  carry_forward_in    REAL NOT NULL DEFAULT 0,
  carry_forward_out   REAL NOT NULL DEFAULT 0,
  encashed            REAL NOT NULL DEFAULT 0,
  available           REAL GENERATED ALWAYS AS (
                        opening_balance + accrued + carry_forward_in
                        - used - pending - encashed - carry_forward_out
                      ) STORED,
  last_accrued_at     TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX leave_balances_tenant_employee_type_year_unique
  ON leave_balances (tenant_id, employee_id, leave_type_id, leave_year);
CREATE INDEX leave_balances_tenant_id_idx ON leave_balances (tenant_id);
CREATE INDEX leave_balances_employee_id_idx ON leave_balances (employee_id);
CREATE INDEX leave_balances_leave_type_id_idx ON leave_balances (leave_type_id);
CREATE INDEX leave_balances_leave_year_idx ON leave_balances (leave_year);

ALTER TABLE leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_leave_balances ON leave_balances
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── leave_requests ───────────────────────────────────────────────────────────

CREATE TABLE leave_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id         UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  leave_type_id       UUID NOT NULL REFERENCES leave_types (id) ON DELETE RESTRICT,
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  is_half_day         BOOLEAN NOT NULL DEFAULT FALSE,
  half_day_session    half_day_session,
  total_days          REAL NOT NULL,
  reason              TEXT,
  attachment_url      TEXT,
  cover_employee_id   UUID REFERENCES employees (id) ON DELETE SET NULL,
  status              leave_request_status NOT NULL DEFAULT 'pending',
  approver_id         UUID REFERENCES employees (id) ON DELETE SET NULL,
  approver_comment    TEXT,
  approved_at         TIMESTAMPTZ,
  rejected_at         TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  applied_at          TIMESTAMPTZ DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX leave_requests_tenant_id_idx ON leave_requests (tenant_id);
CREATE INDEX leave_requests_employee_id_idx ON leave_requests (employee_id);
CREATE INDEX leave_requests_leave_type_id_idx ON leave_requests (leave_type_id);
CREATE INDEX leave_requests_status_idx ON leave_requests (status);
CREATE INDEX leave_requests_start_date_idx ON leave_requests (start_date);
CREATE INDEX leave_requests_end_date_idx ON leave_requests (end_date);
CREATE INDEX leave_requests_approver_id_idx ON leave_requests (approver_id) WHERE approver_id IS NOT NULL;

ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_leave_requests ON leave_requests
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── holidays ─────────────────────────────────────────────────────────────────

CREATE TABLE holidays (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  location_id     UUID REFERENCES locations (id) ON DELETE SET NULL,
  holiday_date    DATE NOT NULL,
  name            TEXT NOT NULL,
  type            holiday_type NOT NULL DEFAULT 'national',
  description     TEXT,
  is_recurring    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX holidays_tenant_id_idx ON holidays (tenant_id);
CREATE INDEX holidays_holiday_date_idx ON holidays (holiday_date);
CREATE INDEX holidays_type_idx ON holidays (type);

ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_holidays ON holidays
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── calendar_events ──────────────────────────────────────────────────────────

CREATE TABLE calendar_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  event_type    calendar_event_type NOT NULL,
  source_id     UUID,
  employee_id   UUID REFERENCES employees (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  start_at      TIMESTAMPTZ NOT NULL,
  end_at        TIMESTAMPTZ NOT NULL,
  is_all_day    BOOLEAN NOT NULL DEFAULT FALSE,
  visibility    calendar_visibility NOT NULL DEFAULT 'company',
  color         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX calendar_events_tenant_id_idx ON calendar_events (tenant_id);
CREATE INDEX calendar_events_employee_id_idx ON calendar_events (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX calendar_events_event_type_idx ON calendar_events (event_type);
CREATE INDEX calendar_events_start_at_idx ON calendar_events (start_at);
CREATE INDEX calendar_events_end_at_idx ON calendar_events (end_at);

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_calendar_events ON calendar_events
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- TIMESHEET TABLES (RLS enforced)
-- =============================================================================

-- ─── timesheet_periods ────────────────────────────────────────────────────────

CREATE TABLE timesheet_periods (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id               UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  period_start              DATE NOT NULL,
  period_end                DATE NOT NULL,
  total_hours               REAL NOT NULL DEFAULT 0,
  total_billable_hours      REAL NOT NULL DEFAULT 0,
  total_non_billable_hours  REAL NOT NULL DEFAULT 0,
  status                    timesheet_status NOT NULL DEFAULT 'draft',
  submitted_at              TIMESTAMPTZ,
  approver_id               UUID REFERENCES employees (id) ON DELETE SET NULL,
  approved_at               TIMESTAMPTZ,
  rejected_at               TIMESTAMPTZ,
  rejection_comment         TEXT,
  locked_at                 TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX timesheet_periods_tenant_employee_period_start_unique
  ON timesheet_periods (tenant_id, employee_id, period_start);
CREATE INDEX timesheet_periods_tenant_id_idx ON timesheet_periods (tenant_id);
CREATE INDEX timesheet_periods_employee_id_idx ON timesheet_periods (employee_id);
CREATE INDEX timesheet_periods_status_idx ON timesheet_periods (status);
CREATE INDEX timesheet_periods_period_start_idx ON timesheet_periods (period_start);
CREATE INDEX timesheet_periods_approver_id_idx ON timesheet_periods (approver_id) WHERE approver_id IS NOT NULL;

ALTER TABLE timesheet_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_timesheet_periods ON timesheet_periods
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── timesheet_entries ────────────────────────────────────────────────────────

CREATE TABLE timesheet_entries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  timesheet_period_id   UUID NOT NULL REFERENCES timesheet_periods (id) ON DELETE CASCADE,
  employee_id           UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  entry_date            DATE NOT NULL,
  hours                 REAL NOT NULL,
  project_id            UUID,
  task_id               UUID,
  category              timesheet_entry_category NOT NULL DEFAULT 'other',
  is_billable           BOOLEAN NOT NULL DEFAULT FALSE,
  hourly_rate_snapshot  REAL,
  description           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX timesheet_entries_tenant_id_idx ON timesheet_entries (tenant_id);
CREATE INDEX timesheet_entries_timesheet_period_id_idx ON timesheet_entries (timesheet_period_id);
CREATE INDEX timesheet_entries_employee_id_idx ON timesheet_entries (employee_id);
CREATE INDEX timesheet_entries_entry_date_idx ON timesheet_entries (entry_date);
CREATE INDEX timesheet_entries_project_id_idx ON timesheet_entries (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX timesheet_entries_is_billable_idx ON timesheet_entries (is_billable);

ALTER TABLE timesheet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_timesheet_entries ON timesheet_entries
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── timesheet_rework_requests ────────────────────────────────────────────────

CREATE TABLE timesheet_rework_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  timesheet_period_id   UUID NOT NULL REFERENCES timesheet_periods (id) ON DELETE CASCADE,
  requested_by          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  affected_entry_ids    UUID[] NOT NULL DEFAULT '{}',
  comment               TEXT NOT NULL,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX timesheet_rework_requests_tenant_id_idx ON timesheet_rework_requests (tenant_id);
CREATE INDEX timesheet_rework_requests_timesheet_period_id_idx ON timesheet_rework_requests (timesheet_period_id);
CREATE INDEX timesheet_rework_requests_requested_by_idx ON timesheet_rework_requests (requested_by);

ALTER TABLE timesheet_rework_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_rework_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_timesheet_rework_requests ON timesheet_rework_requests
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- =============================================================================
-- FAM TABLES (Fleet Administration & Monitoring)
-- Platform-level audit_log_platform has no RLS.
-- Tenant-scoped audit_log and subscription tables have RLS.
-- =============================================================================

-- ─── audit_log_platform (no RLS — platform admin only) ───────────────────────

CREATE TABLE audit_log_platform (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id     UUID REFERENCES users (id) ON DELETE SET NULL,
  action            TEXT NOT NULL,
  target_tenant_id  UUID REFERENCES tenants (id) ON DELETE SET NULL,
  target_user_id    UUID REFERENCES users (id) ON DELETE SET NULL,
  metadata          JSONB,
  ip_address        TEXT,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_platform_actor_user_id_idx ON audit_log_platform (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_log_platform_action_idx ON audit_log_platform (action);
CREATE INDEX audit_log_platform_target_tenant_id_idx ON audit_log_platform (target_tenant_id) WHERE target_tenant_id IS NOT NULL;
CREATE INDEX audit_log_platform_created_at_idx ON audit_log_platform (created_at);

-- ─── audit_log (tenant-scoped, RLS enforced) ──────────────────────────────────

CREATE TABLE audit_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_user_id       UUID REFERENCES users (id) ON DELETE SET NULL,
  actor_employee_id   UUID,
  action              TEXT NOT NULL,
  resource_type       TEXT NOT NULL,
  resource_id         UUID,
  before_state        JSONB,
  after_state         JSONB,
  ip_address          TEXT,
  user_agent          TEXT,
  metadata            JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_tenant_id_idx ON audit_log (tenant_id);
CREATE INDEX audit_log_actor_user_id_idx ON audit_log (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_log_action_idx ON audit_log (action);
CREATE INDEX audit_log_resource_type_idx ON audit_log (resource_type);
CREATE INDEX audit_log_resource_id_idx ON audit_log (resource_id) WHERE resource_id IS NOT NULL;
CREATE INDEX audit_log_created_at_idx ON audit_log (created_at);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_audit_log ON audit_log
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── subscriptions (no RLS — FAM/service role only) ──────────────────────────

CREATE TABLE subscriptions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  plan_code                 TEXT NOT NULL,
  status                    subscription_status NOT NULL DEFAULT 'trialing',
  per_user_price            REAL NOT NULL DEFAULT 0,
  user_count                INTEGER NOT NULL DEFAULT 0,
  mrr_amount                REAL NOT NULL DEFAULT 0,
  billing_cycle             billing_cycle NOT NULL DEFAULT 'monthly',
  trial_ends_at             TIMESTAMPTZ,
  current_period_start      TIMESTAMPTZ,
  current_period_end        TIMESTAMPTZ,
  razorpay_subscription_id  TEXT,
  razorpay_customer_id      TEXT,
  cancel_at_period_end      BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX subscriptions_status_idx ON subscriptions (status);
CREATE INDEX subscriptions_plan_code_idx ON subscriptions (plan_code);
CREATE INDEX subscriptions_current_period_end_idx ON subscriptions (current_period_end) WHERE current_period_end IS NOT NULL;
CREATE INDEX subscriptions_razorpay_subscription_id_idx ON subscriptions (razorpay_subscription_id) WHERE razorpay_subscription_id IS NOT NULL;

-- ─── subscription_events (no RLS — FAM only) ──────────────────────────────────

CREATE TABLE subscription_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subscription_id   UUID NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX subscription_events_tenant_id_idx ON subscription_events (tenant_id);
CREATE INDEX subscription_events_subscription_id_idx ON subscription_events (subscription_id);
CREATE INDEX subscription_events_event_type_idx ON subscription_events (event_type);
CREATE INDEX subscription_events_created_at_idx ON subscription_events (created_at);

-- ─── tenant_health_snapshots (no RLS — FAM only) ─────────────────────────────

CREATE TABLE tenant_health_snapshots (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  snapshot_date           DATE NOT NULL,
  health_score            REAL,
  active_users_7d         INTEGER NOT NULL DEFAULT 0,
  active_users_30d        INTEGER NOT NULL DEFAULT 0,
  attendance_compliance   REAL,
  feature_adoption_score  REAL,
  support_tickets_open    INTEGER NOT NULL DEFAULT 0,
  signal                  health_signal NOT NULL DEFAULT 'new',
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX tenant_health_snapshots_tenant_date_unique
  ON tenant_health_snapshots (tenant_id, snapshot_date);
CREATE INDEX tenant_health_snapshots_tenant_id_idx ON tenant_health_snapshots (tenant_id);
CREATE INDEX tenant_health_snapshots_snapshot_date_idx ON tenant_health_snapshots (snapshot_date);
CREATE INDEX tenant_health_snapshots_signal_idx ON tenant_health_snapshots (signal);

-- ─── feature_flags (no RLS — platform admin only) ────────────────────────────

CREATE TABLE feature_flags (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key              TEXT NOT NULL UNIQUE,
  description           TEXT,
  is_enabled_globally   BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_tenant_ids    UUID[] NOT NULL DEFAULT '{}',
  rollout_percentage    INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percentage BETWEEN 0 AND 100),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX feature_flags_flag_key_idx ON feature_flags (flag_key);

-- ─── tenant_cohorts (no RLS — platform admin only) ───────────────────────────

CREATE TABLE tenant_cohorts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  tenant_ids    UUID[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX tenant_cohorts_name_idx ON tenant_cohorts (name);

-- =============================================================================
-- TRIGGERS — updated_at auto-maintenance
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER departments_updated_at BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER employees_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER attendance_records_updated_at BEFORE UPDATE ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER leave_balances_updated_at BEFORE UPDATE ON leave_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER leave_requests_updated_at BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER timesheet_periods_updated_at BEFORE UPDATE ON timesheet_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER timesheet_entries_updated_at BEFORE UPDATE ON timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER feature_flags_updated_at BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0002_owner_role.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0002_owner_role.sql
-- Adds the 'owner' value to the membership_role enum.
--
-- Per PRD §3.6 and the rosy-crafting-globe plan, tenant signup creates a
-- single founder user with role='owner'. The Owner has everything an
-- HR Admin has plus billing, tenant-level settings, and the ability to
-- promote or demote anyone in the workspace.
--
-- Idempotent: IF NOT EXISTS prevents re-adding if the value is already
-- present. Safe to re-run.

ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'owner';

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0003_notifications.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- In-app notifications. User-scoped (cross-tenant possible when a user
-- belongs to multiple workspaces); tenant_id is recorded for filtering
-- the notification surface to a single workspace when relevant.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0004_role_fam.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Rename the Specflicks-internal platform admin role from 'super_admin'
-- to 'fam' (the surface it administers is the FAM console). Postgres
-- doesn't support DROP VALUE on enums without rewriting the dependent
-- column, so 'super_admin' stays in the enum as deprecated; nothing in
-- the codebase references it anymore. Any existing memberships still
-- carrying the legacy value are migrated to 'fam' here.

BEGIN;

ALTER TYPE "membership_role" ADD VALUE IF NOT EXISTS 'fam';

COMMIT;

-- Postgres requires a separate transaction after ADD VALUE before the
-- new label can be used in a DML statement.
BEGIN;

UPDATE memberships
SET    role = 'fam'
WHERE  role = 'super_admin';

COMMIT;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0005_impersonation_sessions.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Sprint 3 C6 hardening — sessioned impersonation.
-- Adds an explicit impersonation_sessions table so we can:
--   • enforce a real 15-minute hard cap (ends_at) regardless of how long
--     the refresh token TTL is
--   • revoke an active session by setting ended_at = now()
--   • audit who, when, why, from where
-- And adds impersonator_user_id to refresh_tokens so the refresh handler
-- can tell impersonation refreshes apart from normal ones and join back
-- to the sessions table to validate them.

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

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0006_account_deletion_requests.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- D2 — DPDP right-to-erasure. Tracks account-deletion requests with a
-- 7-day cool-off (scheduled_for). The principal can cancel during the
-- window; the actual erasure honours the employer's 8-year statutory
-- retention, so "completed" soft-deletes the personal login rather than
-- the employment ledger (admin/cron step, deferred past MVP).

CREATE TABLE IF NOT EXISTS "account_deletion_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"    uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id"      uuid NOT NULL REFERENCES "users"("id")   ON DELETE CASCADE,
  "reason"       text,
  "status"       text NOT NULL DEFAULT 'pending',
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "scheduled_for" timestamptz NOT NULL,
  "processed_at" timestamptz,
  "ip_address"   text,
  "user_agent"   text
);

CREATE INDEX IF NOT EXISTS "account_deletion_requests_user_idx"
  ON "account_deletion_requests" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "account_deletion_requests_tenant_idx"
  ON "account_deletion_requests" ("tenant_id");

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0007_totp.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0007_totp.sql
-- FAM (platform-admin) second factor. FAM logins are gated on totp_secret
-- being non-null (PRD §11.6). Customer users never set these.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enrolled_at timestamptz;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0008_notification_preferences.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0008_notification_preferences.sql
-- Per-user, per-event, per-channel notification toggles (PRD §9.3).
-- Absence of a row = default on (resolved in NotificationsService).

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "channel"    text NOT NULL,
  "enabled"    boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_user_event_channel_unique"
  ON "notification_preferences" ("user_id", "event_type", "channel");
CREATE INDEX IF NOT EXISTS "notification_preferences_user_idx"
  ON "notification_preferences" ("user_id");

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0009_rls_bucket_b.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0009 — Row-Level Security for the remaining tenant-scoped tables.
--
-- 0001 enabled RLS on the 23 tenant business-data tables but left several
-- tenant-scoped tables without it. The most important is `memberships`
-- (tenant↔user roles): under the NOBYPASSRLS app role a cross-tenant read
-- of memberships was NOT isolated — a genuine gap (caught by the Gate-1
-- multi-tenant suite, test #9). The rest (subscriptions, subscription_events,
-- tenant_health_snapshots, account_deletion_requests, impersonation_sessions)
-- are accessed only via the service-role (BYPASSRLS) connection (FAM / auth),
-- so RLS here is defense-in-depth — it costs nothing at runtime but means a
-- future tenant-role query against them can never leak across tenants.
--
-- Idempotent: ENABLE/FORCE are no-ops if already set; policies are dropped
-- before (re)create since Postgres has no CREATE POLICY IF NOT EXISTS.

-- ─── memberships (tenant_id) — closes the real isolation gap ──────────────────
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_memberships ON memberships;
CREATE POLICY tenant_isolation_memberships ON memberships
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── subscriptions (tenant_id) — FAM-only, defense-in-depth ───────────────────
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscriptions ON subscriptions;
CREATE POLICY tenant_isolation_subscriptions ON subscriptions
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── subscription_events (tenant_id) — FAM-only, defense-in-depth ─────────────
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscription_events ON subscription_events;
CREATE POLICY tenant_isolation_subscription_events ON subscription_events
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── tenant_health_snapshots (tenant_id) — FAM-only, defense-in-depth ─────────
ALTER TABLE tenant_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_health_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_health_snapshots ON tenant_health_snapshots;
CREATE POLICY tenant_isolation_tenant_health_snapshots ON tenant_health_snapshots
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── account_deletion_requests (tenant_id) — accessed via service role ────────
ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_account_deletion_requests ON account_deletion_requests;
CREATE POLICY tenant_isolation_account_deletion_requests ON account_deletion_requests
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── impersonation_sessions (target_tenant_id) — FAM-only, defense-in-depth ───
-- The tenant column here is target_tenant_id (the tenant being impersonated).
ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_impersonation_sessions ON impersonation_sessions;
CREATE POLICY tenant_isolation_impersonation_sessions ON impersonation_sessions
  FOR ALL USING (target_tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (target_tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0010_rls_users_tenants.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0010 — Row-Level Security for users and tenants.
--
-- These are identity/platform tables (no tenant_id of their own), but the
-- tenant connection legitimately reads them: employee list/detail/org-chart
-- join `users` for member display names, and the invite flow reads `tenants`
-- for the company name. So instead of a blanket deny, we scope them:
--
--   users   — visible to a tenant connection only for users who are MEMBERS
--             of the current tenant (app.tenant_id). Cross-tenant user rows
--             are invisible. Identity provisioning that must see/create users
--             globally (auth, and the employee-invite email lookup) runs on
--             the service-role connection, which bypasses RLS.
--   tenants — a tenant connection sees only its own row (id = app.tenant_id).
--
-- The service role (FAM / auth / onboarding) is a superuser and bypasses RLS,
-- so platform-wide reads/writes are unaffected.
--
-- Idempotent: ENABLE/FORCE are no-ops if set; policies dropped before create.

-- ─── users — members of the current tenant only ───────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_users ON users;
CREATE POLICY tenant_members_users ON users
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  );

-- ─── tenants — own row only ───────────────────────────────────────────────────
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_tenants ON tenants;
CREATE POLICY tenant_self_tenants ON tenants
  FOR ALL USING (id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0011_rls_identity_lockdown.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0011 — Lock down the identity / platform tables with deny-all RLS.
--
-- These tables have no tenant dimension a tenant connection could be scoped
-- to, and they are touched ONLY by the service-role (BYPASSRLS) connection
-- (auth.service, notifications.service, fam.service, audit.service's platform
-- log). So we enable RLS with a policy that denies everyone: the service role
-- bypasses RLS and keeps working, while the NOBYPASSRLS app role can never
-- read or write them — even by accident.
--
-- This also re-enables RLS on auth_otps the RIGHT way. It had been enabled
-- out-of-band (Supabase dashboard) with NO policy, which default-denied the
-- app role's OTP insert and 500'd login; the documented hotfix was to disable
-- it. This migration restores it as an explicit, intentional deny-all.
--
-- Idempotent: ENABLE/FORCE are no-ops if set; policies dropped before create.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'auth_otps',
    'refresh_tokens',
    'trusted_devices',
    'auth_events',
    'notification_preferences',
    'notifications',
    'feature_flags',
    'tenant_cohorts',
    'audit_log_platform'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS service_role_only_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY service_role_only_%I ON %I FOR ALL USING (false) WITH CHECK (false)',
      t, t
    );
  END LOOP;
END $$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0012_invoicing_core.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0012 — Invoicing module: core data model (PRD v3 §4.2 / §4.3)
-- =============================================================================
-- Creates all invoicing business tables + the shared company bank-account
-- tables. RLS is applied separately in 0014; the auditor role/platform tables
-- in 0013; seeds in 0015. No RLS here so the table-creation step is reviewable
-- on its own. Idempotent via IF NOT EXISTS.
--
-- Conventions: UUID PK (gen_random_uuid), tenant_id FK cascade, TIMESTAMPTZ,
-- NUMERIC(15,2) money / NUMERIC(5,2) rates / NUMERIC(15,6) fx /
-- NUMERIC(15,4) quantity. Status/type columns are TEXT (app-validated).
-- =============================================================================

-- ─── hsn_sac_codes (GLOBAL — no tenant_id, no RLS) ──────────────────────────────
CREATE TABLE IF NOT EXISTS hsn_sac_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL,                 -- HSN | SAC
  description       TEXT NOT NULL,
  default_gst_rate  NUMERIC(5,2),
  category          TEXT,
  popularity        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hsn_sac_codes_type_idx ON hsn_sac_codes (type);
CREATE INDEX IF NOT EXISTS hsn_sac_codes_popularity_idx ON hsn_sac_codes (popularity);

-- ─── invoicing_settings (one row per tenant) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoicing_settings (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  default_currency              TEXT NOT NULL DEFAULT 'INR',
  default_payment_terms_days    INTEGER NOT NULL DEFAULT 30,
  default_gst_rate              NUMERIC(5,2) NOT NULL DEFAULT 18,
  default_invoice_notes         TEXT,
  default_terms_and_conditions  TEXT,
  invoice_template              TEXT NOT NULL DEFAULT 'classic',
  brand_color_override          TEXT,
  show_gstin_on_pdf             BOOLEAN DEFAULT TRUE,
  show_tds_section_on_pdf       BOOLEAN DEFAULT TRUE,
  show_upi_qr_on_pdf            BOOLEAN DEFAULT TRUE,
  show_powered_by_footer        BOOLEAN DEFAULT TRUE,
  email_sender_name             TEXT,
  email_reply_to                TEXT,
  email_signature               TEXT,
  cc_owner_on_customer_emails   BOOLEAN DEFAULT TRUE,
  additional_cc_emails          TEXT[],
  upi_id                        TEXT,
  upi_display_name              TEXT,
  razorpay_account_id           TEXT,
  razorpay_key_id               TEXT,
  razorpay_webhook_secret       TEXT,
  allow_partial_payments        BOOLEAN DEFAULT TRUE,
  fx_rate_source                TEXT DEFAULT 'openexchangerates',
  fx_rate_last_refresh          TIMESTAMPTZ,
  filing_frequency              TEXT DEFAULT 'monthly',
  declared_aato                 NUMERIC(15,2),
  composition_scheme            BOOLEAN DEFAULT FALSE,
  default_tds_section           TEXT DEFAULT '393',
  default_tds_payment_code      TEXT,
  default_tds_rate              NUMERIC(5,2),
  auto_suggest_tds              BOOLEAN DEFAULT FALSE,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoicing_settings_tenant_id_idx ON invoicing_settings (tenant_id);

-- ─── invoicing_setup_progress (wizard tracker) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS invoicing_setup_progress (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  wizard_started_at           TIMESTAMPTZ,
  wizard_completed_at         TIMESTAMPTZ,
  current_step                TEXT,
  business_details_confirmed  BOOLEAN DEFAULT FALSE,
  upi_configured              BOOLEAN DEFAULT FALSE,
  razorpay_connected          BOOLEAN DEFAULT FALSE,
  template_chosen             BOOLEAN DEFAULT FALSE,
  numbering_configured        BOOLEAN DEFAULT FALSE,
  payment_terms_set           BOOLEAN DEFAULT FALSE,
  currencies_enabled          BOOLEAN DEFAULT FALSE,
  default_gst_set             BOOLEAN DEFAULT FALSE,
  default_notes_set           BOOLEAN DEFAULT FALSE,
  email_signature_set         BOOLEAN DEFAULT FALSE,
  reminder_schedule_set       BOOLEAN DEFAULT FALSE,
  first_invoice_sent_at       TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoicing_setup_progress_tenant_id_idx ON invoicing_setup_progress (tenant_id);

-- ─── customers ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_code               TEXT NOT NULL,
  display_name                TEXT NOT NULL,
  legal_name                  TEXT,
  customer_type               TEXT NOT NULL DEFAULT 'business',
  primary_contact_name        TEXT,
  email                       TEXT,
  secondary_emails            TEXT[],
  phone                       TEXT,
  country_code                TEXT NOT NULL DEFAULT 'IN',
  state_code                  TEXT,
  billing_address_line1       TEXT,
  billing_address_line2       TEXT,
  billing_city                TEXT,
  billing_state               TEXT,
  billing_postal_code         TEXT,
  billing_country             TEXT,
  shipping_same_as_billing    BOOLEAN DEFAULT TRUE,
  shipping_address_line1      TEXT,
  shipping_address_line2      TEXT,
  shipping_city               TEXT,
  shipping_state              TEXT,
  shipping_postal_code        TEXT,
  shipping_country            TEXT,
  is_gst_registered           BOOLEAN DEFAULT FALSE,
  gstin                       TEXT,
  pan                         TEXT,
  intl_tax_id                 TEXT,
  default_currency            TEXT NOT NULL DEFAULT 'INR',
  default_payment_terms_days  INTEGER,
  default_language            TEXT DEFAULT 'en',
  default_notes               TEXT,
  internal_notes              TEXT,
  status                      TEXT NOT NULL DEFAULT 'active',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                  UUID REFERENCES users (id),
  updated_by                  UUID REFERENCES users (id),
  deleted_at                  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_code_unique ON customers (tenant_id, customer_code);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_status ON customers (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_gstin ON customers (tenant_id, gstin) WHERE gstin IS NOT NULL;

-- ─── customer_credit_balance (+ entries) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_credit_balance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  balance_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'INR',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_balance_unique ON customer_credit_balance (tenant_id, customer_id, currency);
CREATE INDEX IF NOT EXISTS customer_credit_balance_tenant_idx ON customer_credit_balance (tenant_id);

CREATE TABLE IF NOT EXISTS customer_credit_balance_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  entry_date      DATE NOT NULL,
  entry_type      TEXT NOT NULL,
  amount          NUMERIC(15,2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  reference_type  TEXT,
  reference_id    UUID,
  description     TEXT,
  created_by      UUID REFERENCES users (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_credit_entries_tenant_customer_date_idx
  ON customer_credit_balance_entries (tenant_id, customer_id, entry_date);

-- ─── items ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  item_code         TEXT NOT NULL,
  name              TEXT NOT NULL,
  category          TEXT,
  description       TEXT,
  default_rate      NUMERIC(15,2) NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  unit              TEXT NOT NULL DEFAULT 'units',
  hsn_sac_code      TEXT,
  default_gst_rate  NUMERIC(5,2) DEFAULT 18,
  cess_rate         NUMERIC(5,2) DEFAULT 0,
  country_override  TEXT,
  intl_tax_code     TEXT,
  intl_tax_rate     NUMERIC(5,2),
  tax_exempt        BOOLEAN DEFAULT FALSE,
  status            TEXT NOT NULL DEFAULT 'active',
  usage_count       INTEGER DEFAULT 0,
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID REFERENCES users (id),
  updated_by        UUID REFERENCES users (id),
  deleted_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS items_tenant_code_unique ON items (tenant_id, item_code);
CREATE INDEX IF NOT EXISTS idx_items_tenant_status ON items (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_items_name ON items USING gin (to_tsvector('english', name));

-- ─── invoice_sequences ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_sequences (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  document_type    TEXT NOT NULL,
  fy_label         TEXT NOT NULL,
  fy_start_date    DATE NOT NULL,
  fy_end_date      DATE NOT NULL,
  prefix           TEXT NOT NULL DEFAULT 'INV',
  separator        TEXT NOT NULL DEFAULT '/',
  fy_format        TEXT NOT NULL DEFAULT '26-27',
  zero_padding     INTEGER NOT NULL DEFAULT 4,
  starting_number  INTEGER NOT NULL DEFAULT 1,
  current_number   INTEGER NOT NULL DEFAULT 0,
  branch_code      VARCHAR(10) NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_sequences_unique
  ON invoice_sequences (tenant_id, document_type, fy_label, branch_code);
CREATE INDEX IF NOT EXISTS invoice_sequences_tenant_idx ON invoice_sequences (tenant_id);

-- ─── tenant_bank_accounts (+ currency defaults) — shared Org → Financial (§8) ───
CREATE TABLE IF NOT EXISTS tenant_bank_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  beneficiary_name  TEXT NOT NULL,
  account_number    TEXT NOT NULL,
  account_type      TEXT NOT NULL DEFAULT 'Current',
  bank_name         TEXT NOT NULL,
  branch            TEXT,
  ifsc              VARCHAR(11) CHECK (ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  swift_bic         VARCHAR(11) CHECK (swift_bic IS NULL OR swift_bic ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$'),
  bank_address      TEXT,
  iban              VARCHAR(34),
  is_default        BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID REFERENCES users (id),
  updated_by        UUID REFERENCES users (id),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenant_bank_accounts_tenant ON tenant_bank_accounts (tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_bank_default ON tenant_bank_accounts (tenant_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant_currency_bank_defaults (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  currency         CHAR(3) NOT NULL,
  bank_account_id  UUID NOT NULL REFERENCES tenant_bank_accounts (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_currency_bank_defaults_unique ON tenant_currency_bank_defaults (tenant_id, currency);

-- ─── invoice_subscriptions (recurring; distinct from FAM SaaS `subscriptions`) ──
CREATE TABLE IF NOT EXISTS invoice_subscriptions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id               UUID NOT NULL REFERENCES customers (id),
  name                      TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'PENDING_MANDATE',
  pricing_model             TEXT NOT NULL,
  currency                  TEXT NOT NULL,
  flat_amount               NUMERIC(15,2),
  seat_rate                 NUMERIC(15,2),
  seat_count                INTEGER,
  billing_period            TEXT NOT NULL,
  custom_period_days        INTEGER,
  anchor_day                INTEGER,
  start_date                DATE NOT NULL,
  end_condition             TEXT NOT NULL DEFAULT 'until_cancelled',
  end_after_cycles          INTEGER,
  end_date                  DATE,
  trial_days                INTEGER DEFAULT 0,
  trial_ends_at             DATE,
  next_billing_date         DATE,
  next_billing_amount       NUMERIC(15,2),
  razorpay_subscription_id  TEXT UNIQUE,
  razorpay_plan_id          TEXT,
  mandate_authorized_at     TIMESTAMPTZ,
  mandate_revoked_at        TIMESTAMPTZ,
  payment_method            TEXT,
  total_cycles_billed       INTEGER DEFAULT 0,
  total_amount_billed       NUMERIC(15,2) DEFAULT 0,
  failed_charge_count       INTEGER DEFAULT 0,
  last_failure_at           TIMESTAMPTZ,
  paused_at                 TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  cancellation_reason       TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                UUID REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS invoice_subscriptions_tenant_idx ON invoice_subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoice_subscriptions_next_billing ON invoice_subscriptions (next_billing_date)
  WHERE status IN ('ACTIVE','TRIALING');

-- ─── invoices ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id                   UUID NOT NULL REFERENCES customers (id),
  invoice_number                TEXT NOT NULL,
  quote_number                  TEXT,
  document_type                 TEXT NOT NULL DEFAULT 'INVOICE',
  status                        TEXT NOT NULL DEFAULT 'DRAFT',
  invoice_date                  DATE NOT NULL,
  due_date                      DATE NOT NULL,
  valid_until                   DATE,
  reference                     TEXT,
  fy_label                      TEXT NOT NULL,
  currency                      TEXT NOT NULL,
  fx_rate_to_inr                NUMERIC(15,6),
  subtotal                      NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_type                 TEXT,
  discount_value                NUMERIC(15,2) DEFAULT 0,
  discount_amount               NUMERIC(15,2) DEFAULT 0,
  taxable_amount                NUMERIC(15,2) NOT NULL DEFAULT 0,
  cgst_amount                   NUMERIC(15,2) DEFAULT 0,
  sgst_amount                   NUMERIC(15,2) DEFAULT 0,
  igst_amount                   NUMERIC(15,2) DEFAULT 0,
  cess_amount                   NUMERIC(15,2) DEFAULT 0,
  total_amount                  NUMERIC(15,2) NOT NULL DEFAULT 0,
  tds_section                   TEXT,
  tds_payment_code              TEXT,
  tds_rate                      NUMERIC(5,2),
  tds_amount                    NUMERIC(15,2) DEFAULT 0,
  net_receivable                NUMERIC(15,2),
  amount_paid                   NUMERIC(15,2) DEFAULT 0,
  amount_outstanding            NUMERIC(15,2),
  credit_applied                NUMERIC(15,2) DEFAULT 0,
  place_of_supply               TEXT,
  tax_treatment                 TEXT,
  reverse_charge                BOOLEAN DEFAULT FALSE,
  notes                         TEXT,
  terms_and_conditions          TEXT,
  subscription_id               UUID REFERENCES invoice_subscriptions (id),
  bank_account_id               UUID REFERENCES tenant_bank_accounts (id),
  pdf_storage_key               TEXT,
  customer_email_at_send        TEXT,
  email_sent_at                 TIMESTAMPTZ,
  email_delivered_at            TIMESTAMPTZ,
  first_viewed_at               TIMESTAMPTZ,
  last_viewed_at                TIMESTAMPTZ,
  view_count                    INTEGER DEFAULT 0,
  paid_at                       TIMESTAMPTZ,
  cancelled_at                  TIMESTAMPTZ,
  cancellation_reason           TEXT,
  voided_at                     TIMESTAMPTZ,
  refunded_at                   TIMESTAMPTZ,
  write_off_at                  TIMESTAMPTZ,
  write_off_reason              TEXT,
  public_view_token             TEXT UNIQUE,
  public_view_token_expires_at  TIMESTAMPTZ,
  invoice_template              TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                    UUID REFERENCES users (id),
  updated_by                    UUID REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_number_unique ON invoices (tenant_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_status ON invoices (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_customer ON invoices (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices (tenant_id, due_date)
  WHERE status IN ('SENT','VIEWED','PARTIALLY_PAID','OVERDUE');
CREATE INDEX IF NOT EXISTS idx_invoices_public_token ON invoices (public_view_token);

-- ─── invoice_line_items ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  line_number      INTEGER NOT NULL,
  item_id          UUID REFERENCES items (id),
  item_name        TEXT NOT NULL,
  description      TEXT,
  hsn_sac_code     TEXT,
  quantity         NUMERIC(15,4) NOT NULL,
  unit             TEXT,
  rate             NUMERIC(15,2) NOT NULL,
  gst_rate         NUMERIC(5,2) DEFAULT 0,
  cess_rate        NUMERIC(5,2) DEFAULT 0,
  line_amount      NUMERIC(15,2) DEFAULT 0,
  discount_amount  NUMERIC(15,2) DEFAULT 0,
  taxable_amount   NUMERIC(15,2) DEFAULT 0,
  cgst_amount      NUMERIC(15,2) DEFAULT 0,
  sgst_amount      NUMERIC(15,2) DEFAULT 0,
  igst_amount      NUMERIC(15,2) DEFAULT 0,
  cess_amount      NUMERIC(15,2) DEFAULT 0,
  line_total       NUMERIC(15,2) DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_line_items_unique ON invoice_line_items (invoice_id, line_number);
CREATE INDEX IF NOT EXISTS invoice_line_items_tenant_idx ON invoice_line_items (tenant_id);
CREATE INDEX IF NOT EXISTS invoice_line_items_invoice_idx ON invoice_line_items (invoice_id);

-- ─── invoice_payments ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id           UUID REFERENCES invoices (id) ON DELETE CASCADE,
  customer_id          UUID NOT NULL REFERENCES customers (id),
  payment_number       TEXT NOT NULL,
  payment_date         DATE NOT NULL,
  amount               NUMERIC(15,2) NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'INR',
  payment_method       TEXT NOT NULL,
  reference_number     TEXT,
  razorpay_payment_id  TEXT,
  razorpay_order_id    TEXT,
  notes                TEXT,
  source               TEXT NOT NULL DEFAULT 'manual',
  receipt_sent         BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_number_unique ON invoice_payments (tenant_id, payment_number);
CREATE INDEX IF NOT EXISTS invoice_payments_tenant_idx ON invoice_payments (tenant_id);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON invoice_payments (invoice_id);

-- ─── invoice_subscription_line_items + proration ────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_subscription_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subscription_id  UUID NOT NULL REFERENCES invoice_subscriptions (id) ON DELETE CASCADE,
  item_id          UUID REFERENCES items (id),
  item_name        TEXT NOT NULL,
  description      TEXT,
  hsn_sac_code     TEXT,
  quantity         NUMERIC(15,4) NOT NULL DEFAULT 1,
  unit             TEXT,
  rate             NUMERIC(15,2) NOT NULL,
  gst_rate         NUMERIC(5,2) DEFAULT 0,
  cess_rate        NUMERIC(5,2) DEFAULT 0,
  effective_from   DATE,
  effective_until  DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_subscription_line_items_tenant_idx ON invoice_subscription_line_items (tenant_id);
CREATE INDEX IF NOT EXISTS invoice_subscription_line_items_sub_idx ON invoice_subscription_line_items (subscription_id);

CREATE TABLE IF NOT EXISTS invoice_subscription_proration_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subscription_id        UUID NOT NULL REFERENCES invoice_subscriptions (id) ON DELETE CASCADE,
  event_date             DATE NOT NULL,
  event_type             TEXT NOT NULL,
  amount                 NUMERIC(15,2) NOT NULL,
  applied_to_invoice_id  UUID REFERENCES invoices (id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_subscription_proration_tenant_idx ON invoice_subscription_proration_events (tenant_id);
CREATE INDEX IF NOT EXISTS invoice_subscription_proration_sub_idx ON invoice_subscription_proration_events (subscription_id);

-- ─── credit_notes (+ lines) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id          UUID REFERENCES invoices (id),
  customer_id         UUID NOT NULL REFERENCES customers (id),
  credit_note_number  TEXT NOT NULL,
  fy_label            TEXT NOT NULL,
  credit_note_date    DATE NOT NULL,
  reason              TEXT NOT NULL,
  reason_description  TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  currency            TEXT NOT NULL DEFAULT 'INR',
  subtotal            NUMERIC(15,2) DEFAULT 0,
  taxable_amount      NUMERIC(15,2) DEFAULT 0,
  cgst_amount         NUMERIC(15,2) DEFAULT 0,
  sgst_amount         NUMERIC(15,2) DEFAULT 0,
  igst_amount         NUMERIC(15,2) DEFAULT 0,
  cess_amount         NUMERIC(15,2) DEFAULT 0,
  total_amount        NUMERIC(15,2) DEFAULT 0,
  applied_to_balance  NUMERIC(15,2) DEFAULT 0,
  refunded_amount     NUMERIC(15,2) DEFAULT 0,
  refund_reference    TEXT,
  refund_date         DATE,
  pdf_storage_key     TEXT,
  notes               TEXT,
  issued_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_number_unique ON credit_notes (tenant_id, credit_note_number);
CREATE INDEX IF NOT EXISTS credit_notes_tenant_idx ON credit_notes (tenant_id);
CREATE INDEX IF NOT EXISTS credit_notes_customer_idx ON credit_notes (customer_id);

CREATE TABLE IF NOT EXISTS credit_note_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  credit_note_id   UUID NOT NULL REFERENCES credit_notes (id) ON DELETE CASCADE,
  line_number      INTEGER NOT NULL,
  item_id          UUID REFERENCES items (id),
  item_name        TEXT NOT NULL,
  description      TEXT,
  hsn_sac_code     TEXT,
  quantity         NUMERIC(15,4) NOT NULL,
  unit             TEXT,
  rate             NUMERIC(15,2) NOT NULL,
  gst_rate         NUMERIC(5,2) DEFAULT 0,
  cess_rate        NUMERIC(5,2) DEFAULT 0,
  line_amount      NUMERIC(15,2) DEFAULT 0,
  discount_amount  NUMERIC(15,2) DEFAULT 0,
  taxable_amount   NUMERIC(15,2) DEFAULT 0,
  cgst_amount      NUMERIC(15,2) DEFAULT 0,
  sgst_amount      NUMERIC(15,2) DEFAULT 0,
  igst_amount      NUMERIC(15,2) DEFAULT 0,
  cess_amount      NUMERIC(15,2) DEFAULT 0,
  line_total       NUMERIC(15,2) DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_note_line_items_unique ON credit_note_line_items (credit_note_id, line_number);
CREATE INDEX IF NOT EXISTS credit_note_line_items_tenant_idx ON credit_note_line_items (tenant_id);

-- ─── debit_notes (+ lines) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS debit_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id          UUID REFERENCES invoices (id),
  customer_id         UUID NOT NULL REFERENCES customers (id),
  debit_note_number   TEXT NOT NULL,
  fy_label            TEXT NOT NULL,
  debit_note_date     DATE NOT NULL,
  reason              TEXT NOT NULL,
  reason_description  TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  currency            TEXT NOT NULL DEFAULT 'INR',
  subtotal            NUMERIC(15,2) DEFAULT 0,
  taxable_amount      NUMERIC(15,2) DEFAULT 0,
  cgst_amount         NUMERIC(15,2) DEFAULT 0,
  sgst_amount         NUMERIC(15,2) DEFAULT 0,
  igst_amount         NUMERIC(15,2) DEFAULT 0,
  cess_amount         NUMERIC(15,2) DEFAULT 0,
  total_amount        NUMERIC(15,2) DEFAULT 0,
  pdf_storage_key     TEXT,
  notes               TEXT,
  issued_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS debit_notes_number_unique ON debit_notes (tenant_id, debit_note_number);
CREATE INDEX IF NOT EXISTS debit_notes_tenant_idx ON debit_notes (tenant_id);
CREATE INDEX IF NOT EXISTS debit_notes_customer_idx ON debit_notes (customer_id);

CREATE TABLE IF NOT EXISTS debit_note_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  debit_note_id    UUID NOT NULL REFERENCES debit_notes (id) ON DELETE CASCADE,
  line_number      INTEGER NOT NULL,
  item_id          UUID REFERENCES items (id),
  item_name        TEXT NOT NULL,
  description      TEXT,
  hsn_sac_code     TEXT,
  quantity         NUMERIC(15,4) NOT NULL,
  unit             TEXT,
  rate             NUMERIC(15,2) NOT NULL,
  gst_rate         NUMERIC(5,2) DEFAULT 0,
  cess_rate        NUMERIC(5,2) DEFAULT 0,
  line_amount      NUMERIC(15,2) DEFAULT 0,
  discount_amount  NUMERIC(15,2) DEFAULT 0,
  taxable_amount   NUMERIC(15,2) DEFAULT 0,
  cgst_amount      NUMERIC(15,2) DEFAULT 0,
  sgst_amount      NUMERIC(15,2) DEFAULT 0,
  igst_amount      NUMERIC(15,2) DEFAULT 0,
  cess_amount      NUMERIC(15,2) DEFAULT 0,
  line_total       NUMERIC(15,2) DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS debit_note_line_items_unique ON debit_note_line_items (debit_note_id, line_number);
CREATE INDEX IF NOT EXISTS debit_note_line_items_tenant_idx ON debit_note_line_items (tenant_id);

-- ─── adjustments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS adjustments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id             UUID NOT NULL REFERENCES customers (id),
  adjustment_date         DATE NOT NULL,
  amount                  NUMERIC(15,2) NOT NULL,
  currency                TEXT NOT NULL DEFAULT 'INR',
  type                    TEXT NOT NULL,
  reason                  TEXT,
  affects_credit_balance  BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by              UUID REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS adjustments_tenant_idx ON adjustments (tenant_id);
CREATE INDEX IF NOT EXISTS adjustments_customer_idx ON adjustments (customer_id);

-- ─── reminder_schedule + reminder_sent ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reminder_schedule (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  reminder_number         INTEGER NOT NULL,
  offset_days             INTEGER NOT NULL,
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  email_subject_template  TEXT,
  email_body_template     TEXT,
  scope                   TEXT NOT NULL DEFAULT 'tenant',
  customer_id             UUID REFERENCES customers (id) ON DELETE CASCADE,
  invoice_id              UUID REFERENCES invoices (id) ON DELETE CASCADE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reminder_schedule_tenant_idx ON reminder_schedule (tenant_id);
CREATE INDEX IF NOT EXISTS reminder_schedule_scope_idx ON reminder_schedule (tenant_id, scope);

CREATE TABLE IF NOT EXISTS reminder_sent (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  reminder_number  INTEGER NOT NULL,
  offset_days      INTEGER NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at     TIMESTAMPTZ,
  bounced          BOOLEAN DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_sent_unique ON reminder_sent (invoice_id, reminder_number);
CREATE INDEX IF NOT EXISTS reminder_sent_tenant_idx ON reminder_sent (tenant_id);

-- ─── razorpay_webhook_events (tenant_id nullable; service-role access) ──────────
CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID REFERENCES tenants (id) ON DELETE CASCADE,
  event_id            TEXT NOT NULL UNIQUE,
  event_type          TEXT NOT NULL,
  payload             JSONB,
  signature           TEXT,
  signature_verified  BOOLEAN DEFAULT FALSE,
  processed           BOOLEAN DEFAULT FALSE,
  processed_at        TIMESTAMPTZ,
  processing_error    TEXT,
  retry_count         INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS razorpay_webhook_events_type_idx ON razorpay_webhook_events (event_type);

-- ─── gstr1_exports ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gstr1_exports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  fy_label             TEXT NOT NULL,
  period_month         INTEGER,
  period_year          INTEGER,
  format               TEXT NOT NULL DEFAULT 'json',
  storage_key          TEXT,
  file_hash            TEXT,
  invoice_count        INTEGER DEFAULT 0,
  total_taxable_value  NUMERIC(15,2) DEFAULT 0,
  total_tax            NUMERIC(15,2) DEFAULT 0,
  b2b_count            INTEGER DEFAULT 0,
  b2cl_count           INTEGER DEFAULT 0,
  b2cs_count           INTEGER DEFAULT 0,
  export_count         INTEGER DEFAULT 0,
  cdnr_count           INTEGER DEFAULT 0,
  generated_by         UUID REFERENCES users (id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gstr1_exports_tenant_idx ON gstr1_exports (tenant_id, fy_label);

-- ─── form_131_received (TDS Form 131 tracking) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS form_131_received (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id             UUID NOT NULL REFERENCES customers (id),
  fy_label                TEXT NOT NULL,
  quarter                 INTEGER NOT NULL,
  total_tds_amount        NUMERIC(15,2) DEFAULT 0,
  form_131_received       BOOLEAN DEFAULT FALSE,
  form_131_received_date  DATE,
  form_131_storage_key    TEXT,
  expected_invoices       UUID[],
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS form_131_received_unique ON form_131_received (tenant_id, customer_id, fy_label, quarter);
CREATE INDEX IF NOT EXISTS form_131_received_tenant_idx ON form_131_received (tenant_id);

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0013_invoicing_auditor.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0013 — Invoicing v3: Auditor role + per-membership grants + module toggles
-- =============================================================================
-- PRD §3 (Auditor RBAC), §4.3 (membership_grants, tenant_module_toggles,
-- memberships ALTER). RLS for the two new tenant-scoped tables is applied in
-- 0014. Idempotent.
--
-- NOTE: this file does NOT insert any 'auditor' rows — it only registers the
-- enum value. Postgres (12+) permits ALTER TYPE … ADD VALUE inside a transaction
-- (e.g. when pasted into the Supabase SQL editor, which runs each batch in one
-- transaction); the only rule is that the new value cannot be *used* in that
-- same transaction, which we don't. Idempotent via ADD VALUE IF NOT EXISTS.
-- =============================================================================

-- ─── membership_role gains 'auditor' ────────────────────────────────────────────
ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'auditor';

-- ─── memberships: external flag + optional time-boxed access window (P1) ────────
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;

-- ─── membership_grants — per-membership module scopes (drives Auditor sidebar) ──
CREATE TABLE IF NOT EXISTS membership_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  membership_id  UUID NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  module         TEXT NOT NULL,                 -- invoicing | reports | org_financial | payroll | expenses
  access_level   TEXT NOT NULL DEFAULT 'view',  -- none | view | edit
  capabilities   JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_grants_membership_module_unique
  ON membership_grants (membership_id, module);
CREATE INDEX IF NOT EXISTS idx_membership_grants_membership ON membership_grants (membership_id);
CREATE INDEX IF NOT EXISTS membership_grants_tenant_idx ON membership_grants (tenant_id);

-- ─── tenant_module_toggles — FAM per-module enablement ──────────────────────────
CREATE TABLE IF NOT EXISTS tenant_module_toggles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  module      TEXT NOT NULL,                    -- invoicing | payroll | expenses
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by  UUID REFERENCES users (id),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_module_toggles_unique ON tenant_module_toggles (tenant_id, module);
CREATE INDEX IF NOT EXISTS tenant_module_toggles_tenant_idx ON tenant_module_toggles (tenant_id);

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0014_invoicing_rls.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0014 — Invoicing v3: Row-Level Security (PRD §4.4)
-- =============================================================================
-- ENABLE + FORCE RLS + standard tenant_isolation_<t> policy on every
-- tenant-scoped invoicing/org/auditor table. Special cases:
--   • hsn_sac_codes        — GLOBAL, read-only → intentionally NO RLS.
--   • razorpay_webhook_events — written without tenant context (service role);
--                            deny-all for the tenant connection (service role
--                            bypasses RLS). Matches the 0011 lockdown pattern.
--   • memberships          — gains an additional SELECT-only self-visibility
--                            policy keyed on app.user_id for the company switcher
--                            (the FOR ALL tenant_isolation policy from 0009 still
--                            governs writes/tenant reads; permissive policies OR).
-- Idempotent: ENABLE/FORCE are no-ops if set; policies are dropped before create.
-- =============================================================================

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'invoicing_settings',
    'invoicing_setup_progress',
    'customers',
    'customer_credit_balance',
    'customer_credit_balance_entries',
    'items',
    'invoice_sequences',
    'tenant_bank_accounts',
    'tenant_currency_bank_defaults',
    'invoice_subscriptions',
    'invoices',
    'invoice_line_items',
    'invoice_payments',
    'invoice_subscription_line_items',
    'invoice_subscription_proration_events',
    'credit_notes',
    'credit_note_line_items',
    'debit_notes',
    'debit_note_line_items',
    'adjustments',
    'reminder_schedule',
    'reminder_sent',
    'gstr1_exports',
    'form_131_received',
    'membership_grants',
    'tenant_module_toggles'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I;', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I '
      'FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid);',
      t, t
    );
  END LOOP;
END $$;

-- ─── razorpay_webhook_events — deny-all for the tenant connection ───────────────
ALTER TABLE razorpay_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE razorpay_webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_only_razorpay_webhook_events ON razorpay_webhook_events;
CREATE POLICY service_role_only_razorpay_webhook_events ON razorpay_webhook_events
  FOR ALL USING (false) WITH CHECK (false);

-- ─── memberships self-visibility (company switcher) ─────────────────────────────
-- NULLIF(...,'') so an unset/empty app.user_id resolves to NULL (no match)
-- rather than raising on a ''::uuid cast — this permissive SELECT policy is
-- evaluated for every read of memberships, including those that set only
-- app.tenant_id.
DROP POLICY IF EXISTS memberships_self_visibility ON memberships;
CREATE POLICY memberships_self_visibility ON memberships
  FOR SELECT USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0015_invoicing_seeds.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0015 — Invoicing v3: seed data
-- =============================================================================
-- 1) hsn_sac_codes — global master of popular HSN (goods) + SAC (services)
--    codes with indicative default GST rates. Illustrative; tenants may add
--    their own. Idempotent via ON CONFLICT (code).
-- 2) tenant_module_toggles — enable Invoicing for every existing tenant
--    (PRD §10: default invoicing=enabled). Idempotent.
--
-- NOTE: GST rates here are common defaults for convenience only — the final
-- rate on an invoice is always the user-/item-selected rate.
-- =============================================================================

INSERT INTO hsn_sac_codes (code, type, description, default_gst_rate, category, popularity) VALUES
  -- ── Services (SAC, 99xxxx) ──────────────────────────────────────────────────
  ('998314', 'SAC', 'Information technology (IT) design and development services', 18, 'IT & Software', 100),
  ('998313', 'SAC', 'IT consulting and support services', 18, 'IT & Software', 98),
  ('998315', 'SAC', 'Hosting and IT infrastructure provisioning services', 18, 'IT & Software', 90),
  ('998316', 'SAC', 'IT infrastructure and network management services', 18, 'IT & Software', 80),
  ('997331', 'SAC', 'Licensing services for the right to use computer software', 18, 'IT & Software', 88),
  ('998319', 'SAC', 'Other information technology services n.e.c.', 18, 'IT & Software', 70),
  ('998311', 'SAC', 'Management consulting and management services', 18, 'Consulting', 95),
  ('998312', 'SAC', 'Business consulting services', 18, 'Consulting', 92),
  ('998399', 'SAC', 'Other professional, technical and business services n.e.c.', 18, 'Professional', 75),
  ('998221', 'SAC', 'Accounting and bookkeeping services', 18, 'Finance & Accounting', 85),
  ('998222', 'SAC', 'Auditing and financial statement review services', 18, 'Finance & Accounting', 84),
  ('998231', 'SAC', 'Corporate tax consulting and preparation services', 18, 'Finance & Accounting', 82),
  ('998232', 'SAC', 'Individual tax preparation and planning services', 18, 'Finance & Accounting', 70),
  ('998212', 'SAC', 'Legal services concerning business and commercial law', 18, 'Legal', 80),
  ('998213', 'SAC', 'Legal documentation and certification services', 18, 'Legal', 72),
  ('998361', 'SAC', 'Advertising services', 18, 'Marketing & Advertising', 86),
  ('998365', 'SAC', 'Sale of internet advertising space', 18, 'Marketing & Advertising', 78),
  ('998363', 'SAC', 'Sale of advertising space in print media', 5, 'Marketing & Advertising', 60),
  ('998341', 'SAC', 'Architectural and design services', 18, 'Design', 74),
  ('998342', 'SAC', 'Engineering and technical consulting services', 18, 'Engineering', 76),
  ('998391', 'SAC', 'Specialty design services (graphic, web, UI/UX)', 18, 'Design', 82),
  ('998596', 'SAC', 'Events, exhibitions and convention services', 18, 'Events', 64),
  ('998511', 'SAC', 'Recruitment and executive search services', 18, 'HR & Staffing', 70),
  ('998513', 'SAC', 'Contract staffing and manpower supply services', 18, 'HR & Staffing', 68),
  ('999293', 'SAC', 'Commercial training and coaching services', 18, 'Education & Training', 66),
  ('998431', 'SAC', 'Online content, software-as-a-service (subscription)', 18, 'IT & Software', 96),
  ('996511', 'SAC', 'Road transport services for goods', 5, 'Logistics & Transport', 62),
  ('996812', 'SAC', 'Courier and express delivery services', 18, 'Logistics & Transport', 60),
  ('997212', 'SAC', 'Rental or leasing services of commercial property', 18, 'Real Estate', 58),
  ('998714', 'SAC', 'Maintenance and repair of computers and peripherals', 18, 'IT & Software', 64),
  ('998722', 'SAC', 'Maintenance and repair of electrical equipment', 18, 'Maintenance', 50),
  ('997221', 'SAC', 'Property management services', 18, 'Real Estate', 48),
  ('998381', 'SAC', 'Photography and videography services', 18, 'Media', 55),
  ('998346', 'SAC', 'Technical testing and analysis services', 18, 'Engineering', 52),
  ('999511', 'SAC', 'Membership organisation and association services', 18, 'Professional', 40),
  -- ── Goods (HSN) ─────────────────────────────────────────────────────────────
  ('8471', 'HSN', 'Computers, laptops and data-processing machines', 18, 'Electronics', 90),
  ('8517', 'HSN', 'Telephones, smartphones and communication apparatus', 18, 'Electronics', 88),
  ('8523', 'HSN', 'Storage media; software on physical media', 18, 'Electronics', 70),
  ('8528', 'HSN', 'Monitors, projectors and display units', 18, 'Electronics', 72),
  ('8443', 'HSN', 'Printers, copiers and printing machinery', 18, 'Electronics', 60),
  ('8504', 'HSN', 'Power adapters, UPS and electrical transformers', 18, 'Electronics', 58),
  ('8544', 'HSN', 'Insulated wires, cables and connectors', 18, 'Electronics', 50),
  ('9403', 'HSN', 'Furniture (office, wooden and metal) and parts', 18, 'Furniture', 64),
  ('9401', 'HSN', 'Seats and chairs (office and other)', 18, 'Furniture', 62),
  ('4820', 'HSN', 'Registers, notebooks, files and paper stationery', 18, 'Stationery', 55),
  ('4901', 'HSN', 'Printed books, brochures and similar printed matter', 0, 'Publishing', 48),
  ('4911', 'HSN', 'Printed advertising material and catalogues', 12, 'Publishing', 44),
  ('4202', 'HSN', 'Bags, cases and similar containers', 18, 'Accessories', 40),
  ('6109', 'HSN', 'T-shirts, singlets and vests (knitted)', 5, 'Apparel', 52),
  ('6205', 'HSN', 'Men''s shirts', 5, 'Apparel', 46),
  ('6110', 'HSN', 'Sweaters, pullovers and similar knitted apparel', 12, 'Apparel', 45),
  ('4819', 'HSN', 'Cartons, boxes and packaging of paper', 18, 'Packaging', 42),
  ('3923', 'HSN', 'Plastic packaging articles and containers', 18, 'Packaging', 38),
  ('2106', 'HSN', 'Food preparations not elsewhere specified', 18, 'Food & Beverage', 50),
  ('2202', 'HSN', 'Waters and non-alcoholic beverages', 18, 'Food & Beverage', 48),
  ('0902', 'HSN', 'Tea', 5, 'Food & Beverage', 36),
  ('0901', 'HSN', 'Coffee', 5, 'Food & Beverage', 36),
  ('3304', 'HSN', 'Beauty and cosmetic preparations', 18, 'Personal Care', 40),
  ('3401', 'HSN', 'Soaps and organic surface-active products', 18, 'Personal Care', 34),
  ('8703', 'HSN', 'Motor cars and passenger vehicles', 28, 'Automotive', 44),
  ('8708', 'HSN', 'Parts and accessories of motor vehicles', 28, 'Automotive', 38),
  ('8714', 'HSN', 'Parts and accessories of bicycles and two-wheelers', 18, 'Automotive', 30),
  ('9018', 'HSN', 'Medical, surgical and diagnostic instruments', 12, 'Medical', 42),
  ('3004', 'HSN', 'Medicaments (packaged for retail sale)', 12, 'Pharma', 46),
  ('9404', 'HSN', 'Mattresses, cushions and bedding articles', 18, 'Furniture', 32),
  ('7308', 'HSN', 'Structures and parts of iron or steel', 18, 'Construction', 40),
  ('2523', 'HSN', 'Cement', 28, 'Construction', 44),
  ('6802', 'HSN', 'Worked stone (marble, granite) for construction', 18, 'Construction', 30),
  ('3208', 'HSN', 'Paints and varnishes', 18, 'Construction', 34),
  ('8413', 'HSN', 'Pumps for liquids', 18, 'Machinery', 28),
  ('8419', 'HSN', 'Industrial machinery for temperature treatment', 18, 'Machinery', 26),
  ('8537', 'HSN', 'Boards, panels and control equipment', 18, 'Machinery', 28),
  ('9405', 'HSN', 'Lamps, lighting fittings and LED luminaires', 18, 'Electronics', 36),
  ('8536', 'HSN', 'Electrical switches, relays and fuses', 18, 'Electronics', 34),
  ('3926', 'HSN', 'Other articles of plastics', 18, 'General', 30),
  ('7323', 'HSN', 'Household articles of iron or steel', 18, 'General', 26),
  ('4016', 'HSN', 'Articles of vulcanised rubber', 18, 'General', 24),
  ('8421', 'HSN', 'Filtering and purifying machinery (air/water)', 18, 'Machinery', 28),
  ('9031', 'HSN', 'Measuring or checking instruments', 18, 'Engineering', 30),
  ('8473', 'HSN', 'Parts and accessories of computers/office machines', 18, 'Electronics', 56),
  ('8518', 'HSN', 'Microphones, loudspeakers and audio equipment', 18, 'Electronics', 40),
  ('9504', 'HSN', 'Video game consoles and gaming articles', 28, 'Electronics', 30),
  ('4823', 'HSN', 'Other paper, cut to size, and paper articles', 18, 'Stationery', 28),
  ('3215', 'HSN', 'Printing ink, writing ink and toner', 18, 'Stationery', 26),
  ('8472', 'HSN', 'Other office machines (shredders, laminators)', 18, 'Electronics', 30)
ON CONFLICT (code) DO NOTHING;

-- ─── tenant_module_toggles: enable Invoicing for all existing tenants ───────────
INSERT INTO tenant_module_toggles (tenant_id, module, enabled)
SELECT id, 'invoicing', TRUE FROM tenants
ON CONFLICT (tenant_id, module) DO NOTHING;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0016_tenant_hsn_sac.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0016 — Invoicing v3: tenant-specific HSN/SAC additions
-- =============================================================================
-- The global hsn_sac_codes master stays shared/read-only (no RLS). Tenants may
-- add their own codes here; tenant-scoped + RLS. Search unions the two.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_hsn_sac_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code              TEXT NOT NULL,
  type              TEXT NOT NULL,                 -- HSN | SAC
  description       TEXT NOT NULL,
  default_gst_rate  NUMERIC(5,2),
  category          TEXT,
  created_by        UUID REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_hsn_sac_codes_unique ON tenant_hsn_sac_codes (tenant_id, code);
CREATE INDEX IF NOT EXISTS tenant_hsn_sac_codes_tenant_idx ON tenant_hsn_sac_codes (tenant_id);

ALTER TABLE tenant_hsn_sac_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_hsn_sac_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_hsn_sac_codes ON tenant_hsn_sac_codes;
CREATE POLICY tenant_isolation_tenant_hsn_sac_codes ON tenant_hsn_sac_codes
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0017_invoicing_grants.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0017 — Invoicing v3: grant the new tables to the app role (flicks_app)
-- =============================================================================
-- Why this exists: the invoicing tables (0012–0016) are owned by the migration
-- role (Supabase `postgres`). The API connects as the NOBYPASSRLS `flicks_app`
-- role, which needs table-level privileges IN ADDITION to the RLS policies.
-- scripts/setup-supabase.sh / setup-database.sh re-GRANT after every run, so if
-- you apply migrations with those scripts you're already covered. This migration
-- makes the grant self-contained so applying the SQL any other way (e.g. pasting
-- into the Supabase SQL editor) still leaves the app able to read/write — without
-- it you'd get "permission denied for table …" even though RLS is correct.
--
-- Safe on any database:
--   • guarded by role existence (no-op if flicks_app isn't present);
--   • grants are additive + idempotent (re-running changes nothing);
--   • does NOT touch existing V1 data — only privileges.
-- RLS still confines flicks_app to its tenant rows (it is NOBYPASSRLS).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flicks_app') THEN
    -- Cover every current public table (new invoicing tables + existing V1).
    GRANT USAGE ON SCHEMA public TO flicks_app;
    GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER
      ON ALL TABLES IN SCHEMA public TO flicks_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flicks_app;
    -- Cover any tables created later in this schema by the migration role.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO flicks_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO flicks_app;
  END IF;
END $$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0018_hsn_sac_read_policy.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0018 — hsn_sac_codes: RLS on + global read policy (dashboard-drift-proof)
-- =============================================================================
-- The HSN/SAC master is a GLOBAL reference table (same rows for every tenant).
-- It originally shipped without RLS, but Supabase's dashboard/security advisor
-- tends to flag and enable RLS on it — and RLS with NO policy silently breaks
-- HSN search for the app role (zero rows). Observed live: a fresh sync against
-- Supabase reported 69/69 tables RLS-enabled, meaning the dashboard had already
-- turned it on.
--
-- Fix: own the posture in the migration. Enable RLS deliberately and add a
-- permissive SELECT-for-all policy:
--   • reads work for every role, with or without dashboard drift;
--   • writes by the app role are denied (no INSERT/UPDATE/DELETE policy) —
--     tenant-specific codes belong in tenant_hsn_sac_codes;
--   • seeds/admin writes still work (the postgres owner is not FORCEd).
-- Idempotent.
-- =============================================================================

ALTER TABLE hsn_sac_codes ENABLE ROW LEVEL SECURITY;
-- Deliberately NOT FORCE: the owning role (postgres) keeps seeding/managing the
-- master; only non-owner roles (flicks_app) are subject to the policies below.

DROP POLICY IF EXISTS hsn_sac_codes_global_read ON hsn_sac_codes;
CREATE POLICY hsn_sac_codes_global_read ON hsn_sac_codes
  FOR SELECT USING (true);

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0019_invoicing_debug_consents.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0019 — invoicing_debug_consents (FAM consented-debug, PRD §10.5)
-- =============================================================================
-- The hard FAM privacy line is "never read invoice content without explicit,
-- time-boxed, audited tenant consent." This table records that consent: an
-- Owner grants FAM a time-boxed, revocable window to view their workspace's
-- invoice count/status distribution + webhook/email/audit logs (metadata only,
-- never amounts/customers/descriptions). FAM access is gated on an active row
-- here and every access is written to the platform audit log.
--
-- Tenant-scoped + RLS (the Owner manages their own consent); FAM reads it on
-- the service-role connection. Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoicing_debug_consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES users(id),
  scope       text[] NOT NULL DEFAULT '{}',
  note        text,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoicing_debug_consents_tenant
  ON invoicing_debug_consents (tenant_id);

ALTER TABLE invoicing_debug_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing_debug_consents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_invoicing_debug_consents ON invoicing_debug_consents;
CREATE POLICY tenant_isolation_invoicing_debug_consents ON invoicing_debug_consents
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON invoicing_debug_consents TO flicks_app;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0020_account_security.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0020_account_security.sql
-- Sprint 13 §E — TOTP brute-force lockout + single-use backup codes.
-- Additive + idempotent. No RLS change (users keeps its existing policy; TOTP
-- columns are read/written via the service-role connection in auth.service).

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_locked_until timestamptz;
-- Array of { h: sha256(code), u: ISO-used-at | null }. Codes are shown once at
-- enrolment and stored only as hashes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes jsonb;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0021_razorpay_oauth.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0021 — Razorpay live payments via OAuth Connect (Sprint 15, PRD §6.6/§9.3)
-- =============================================================================
-- Closes the live half of the Razorpay integration (Sprint 4 shipped the safe
-- stub). Sellers connect their Razorpay account via OAuth (Partner model); we
-- store the resulting tokens encrypted at the app layer, create orders on the
-- sub-merchant account with a Bearer access token, and record captured payments
-- via the existing webhook → recordPayment path.
--
-- Additive + idempotent (ADD COLUMN / CREATE TABLE IF NOT EXISTS).
-- =============================================================================

-- ─── invoicing_settings: OAuth token storage ────────────────────────────────
-- Tokens are AES-256-GCM-encrypted by InvoicingCryptoService before they reach
-- these columns and are never returned by the settings API (masked to a
-- razorpay_connected boolean).
ALTER TABLE invoicing_settings
  ADD COLUMN IF NOT EXISTS razorpay_access_token     text,
  ADD COLUMN IF NOT EXISTS razorpay_refresh_token    text,
  ADD COLUMN IF NOT EXISTS razorpay_public_token     text,
  ADD COLUMN IF NOT EXISTS razorpay_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS razorpay_connected_at     timestamptz,
  ADD COLUMN IF NOT EXISTS razorpay_oauth_state      text;

-- ─── razorpay_orders: order → invoice/tenant mapping ────────────────────────
-- The webhook matches a captured payment by entity.order_id (order notes are
-- not echoed onto the payment entity). Tenant-scoped + RLS; the webhook reads
-- it on the service-role connection, the public order endpoint writes it via
-- service role too (no tenant JWT on the hosted page).
CREATE TABLE IF NOT EXISTS razorpay_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_id     text NOT NULL UNIQUE,
  amount_paise integer NOT NULL,
  currency     text NOT NULL DEFAULT 'INR',
  status       text NOT NULL DEFAULT 'created',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS razorpay_orders_tenant_invoice_idx
  ON razorpay_orders (tenant_id, invoice_id);

ALTER TABLE razorpay_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE razorpay_orders FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_razorpay_orders ON razorpay_orders;
CREATE POLICY tenant_isolation_razorpay_orders ON razorpay_orders
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON razorpay_orders TO flicks_app;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0022_trust_consent.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0022 — consent_records (PRD v4 §3.2 — append-only consent ledger)
-- =============================================================================
-- One row per consent decision (terms_privacy / analytics / marketing_email);
-- withdrawal = a new row with granted=false. Current state = the latest row per
-- (user_id, consent_type). Signup consents predate tenant creation, so
-- tenant_id is nullable.
--
-- RLS: SELF-VISIBILITY — a signed-in user can read and append ONLY their own
-- rows (user_id = app.user_id). There are deliberately NO UPDATE/DELETE
-- policies: the ledger is append-only under the app role. FAM/audit reads run
-- on the service-role connection.
--
-- Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consent_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE SET NULL,
  consent_type   text NOT NULL CHECK (consent_type IN ('terms_privacy','analytics','marketing_email')),
  granted        boolean NOT NULL,
  policy_version text NOT NULL,
  source         text NOT NULL CHECK (source IN ('signup','banner','settings','unsubscribe','import')),
  region_code    text,
  ip_hash        text,          -- SHA-256(ip + server salt); never the raw IP
  user_agent     text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consents_user_type
  ON consent_records (user_id, consent_type, occurred_at DESC);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;

-- Self-visibility read + append; NULLIF guards the unset-setting cast.
DROP POLICY IF EXISTS consent_self_select ON consent_records;
CREATE POLICY consent_self_select ON consent_records FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS consent_self_insert ON consent_records;
CREATE POLICY consent_self_insert ON consent_records FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- Append-only: no UPDATE/DELETE policies AND the grants are explicitly revoked
-- (the app role carries blanket table grants from the base setup, so the
-- narrow GRANT alone would not stop a 0-row-matching UPDATE from succeeding).
GRANT SELECT, INSERT ON consent_records TO flicks_app;
REVOKE UPDATE, DELETE ON consent_records FROM flicks_app;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0023_profile_media.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0023 — Profile pictures & company logos (PRD v4 §4, migration 0023)
-- =============================================================================
-- R2 object keys for the server-authoritative media pipeline. The legacy
-- avatar_url/logo_url string columns REMAIN: serialization prefers *_key
-- (served via short-lived signed URLs), falling back to *_url — so existing
-- data keeps rendering and the invoice logo path is untouched.
--
-- Additive + idempotent.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_key        text,
  ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS logo_key        text,
  ADD COLUMN IF NOT EXISTS logo_updated_at timestamptz;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0024_presence_status.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0024 — member_status (PRD v4 §5 — presence & status, Teams-style)
-- =============================================================================
-- One row per (tenant, user): the MANUAL status only. Auto states (in office /
-- out of office / available / away / offline) are resolved at read time from
-- attendance, leave, and the presence gateway's live activity — never stored.
-- Manual status is per company (auditors hold independent statuses per client).
--
-- RLS: everyone in the tenant can READ (org-wide visibility); a user can WRITE
-- only their own row (tenant + user_id = app.user_id).
--
-- Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS member_status (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manual_status  text CHECK (manual_status IN ('available','busy','dnd','brb','away','offline')),
  status_message varchar(80),
  expires_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_member_status_tenant ON member_status (tenant_id);

ALTER TABLE member_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_status FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_status_tenant_read ON member_status;
CREATE POLICY member_status_tenant_read ON member_status FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS member_status_write_own ON member_status;
CREATE POLICY member_status_write_own ON member_status FOR ALL
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON member_status TO flicks_app;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0025_product_events.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0025 — product_events (PRD v4 §6 — first-party internal analytics)
-- =============================================================================
-- Append-only event stream in our own Postgres (PostHog stays dormant as an
-- exit ramp). Properties are ids/enums/numbers ONLY — no PII, no free text.
-- tenant_id is nullable for pre-org events (signup starts before a tenant
-- exists); NULL-tenant rows are service-role-only by construction of the RLS
-- predicate (NULL never equals app.tenant_id).
--
-- Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  event_name  text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}',
  source      text NOT NULL DEFAULT 'api' CHECK (source IN ('web','api','job')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pe_tenant_event_time
  ON product_events (tenant_id, event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_event_time
  ON product_events (event_name, occurred_at DESC);

ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_product_events ON product_events;
CREATE POLICY tenant_isolation_product_events ON product_events
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON product_events TO flicks_app;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0026_feedback_nps.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0026 — feedback_submissions + nps_responses (PRD v4 §7)
-- =============================================================================
-- In-app feedback (menu-triggered, D10-R) and the beta NPS micro-survey.
-- RLS: SELF-VISIBILITY on both — a user reads/writes only their own rows;
-- the FAM inbox reads via the service role. Feedback status changes happen
-- through the FAM service (service role), so the app role needs no UPDATE.
--
-- Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN ('bug','idea','question','other')),
  message       text NOT NULL CHECK (char_length(message) <= 4000),
  contact_ok    boolean NOT NULL DEFAULT false,
  page_path     text,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','resolved','closed')),
  internal_note text,
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_tenant_created
  ON feedback_submissions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_submissions (status);
-- Hot paths: the per-submit 10/day throttle count and the unfiltered FAM inbox.
CREATE INDEX IF NOT EXISTS idx_feedback_user_created
  ON feedback_submissions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback_submissions (category);

ALTER TABLE feedback_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feedback_self_select ON feedback_submissions;
CREATE POLICY feedback_self_select ON feedback_submissions FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
DROP POLICY IF EXISTS feedback_self_insert ON feedback_submissions;
CREATE POLICY feedback_self_insert ON feedback_submissions FOR INSERT
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND tenant_id = current_setting('app.tenant_id', true)::uuid
  );
GRANT SELECT, INSERT ON feedback_submissions TO flicks_app;
REVOKE UPDATE, DELETE ON feedback_submissions FROM flicks_app;

CREATE TABLE IF NOT EXISTS nps_responses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  survey_key    text NOT NULL DEFAULT 'beta_nps_v1',
  score         smallint CHECK (score BETWEEN 0 AND 10),
  comment       text,
  status        text NOT NULL CHECK (status IN ('answered','dismissed','snoozed')),
  prompted_at   timestamptz,
  responded_at  timestamptz,
  snoozed_until timestamptz,
  UNIQUE (user_id, survey_key)
);

CREATE INDEX IF NOT EXISTS idx_nps_survey_status ON nps_responses (survey_key, status);

ALTER TABLE nps_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE nps_responses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nps_self_all ON nps_responses;
-- Self-visibility + tenant pinning: a user acts only on their own row, and
-- writes must carry the session's tenant (no cross-tenant mis-attribution).
CREATE POLICY nps_self_all ON nps_responses FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND tenant_id = current_setting('app.tenant_id', true)::uuid
  );
GRANT SELECT, INSERT, UPDATE ON nps_responses TO flicks_app;
-- No DELETE: answered/dismissed are permanent (§7 once-only) — without this
-- revoke the 0017 default privileges leave DELETE granted and the FOR ALL
-- policy would let a user erase their own row and get re-prompted.
REVOKE DELETE ON nps_responses FROM flicks_app;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0027_razorpay_autodebit.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0027 — tenant-track auto-debit (PRD v4 §8A, Sprint 23)
-- =============================================================================
-- Razorpay e-mandates on the SELLER's own (OAuth-connected) account for
-- recurring invoices: the customer authorizes once on a hosted page, then
-- cycles charge automatically. invoice_subscriptions already carried the
-- razorpay ids + mandate timestamps from v3; this adds the collection mode,
-- mandate lifecycle state, the public-page token, and the per-charge attempt
-- ledger. (Numbered 0027 by the PRD plan; applied after 0028 — both are
-- additive and order-independent, and sync-supabase applies every file.)
--
-- Additive + idempotent.
-- =============================================================================

-- ─── customers: sub-merchant customer handle ─────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS razorpay_customer_id text;

-- ─── invoice_subscriptions: collection mode + mandate lifecycle ──────────────
-- collection_mode: manual (send invoices, D14a default) | auto_debit
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS collection_mode text NOT NULL DEFAULT 'manual';
-- mandate_status: none | pending_authorization | authorized | active | revoked
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_status text NOT NULL DEFAULT 'none';
-- Razorpay-hosted authorization page for this subscription's mandate.
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_short_url text;
-- Public /sub/<token> page token (public-invoice pattern; NULL until minted).
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_token text;
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_token_expires_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_subscriptions_mandate_token
  ON invoice_subscriptions (mandate_token) WHERE mandate_token IS NOT NULL;

-- ─── subscription_charge_attempts: per-cycle charge ledger (D14b timeline) ───
CREATE TABLE IF NOT EXISTS subscription_charge_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES invoice_subscriptions(id) ON DELETE CASCADE,
  invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,
  razorpay_payment_id text,
  status          text NOT NULL CHECK (status IN ('succeeded','failed','pending')),
  amount          numeric(15,2) NOT NULL,
  currency        text NOT NULL,
  failure_reason  text,
  attempted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_charge_attempts_subscription
  ON subscription_charge_attempts (subscription_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_charge_attempts_tenant
  ON subscription_charge_attempts (tenant_id, attempted_at DESC);

-- House tenant-isolation RLS (matches every other invoicing table).
ALTER TABLE subscription_charge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charge_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscription_charge_attempts ON subscription_charge_attempts;
CREATE POLICY tenant_isolation_subscription_charge_attempts ON subscription_charge_attempts
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON subscription_charge_attempts TO flicks_app;
REVOKE UPDATE, DELETE ON subscription_charge_attempts FROM flicks_app;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0028_platform_billing_coupons.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0028 — platform billing core + FAM coupons (PRD v4 §8B, Sprints 21–22)
-- =============================================================================
-- The platform `subscriptions` table (fam.ts) gains the Razorpay wiring and
-- grace state; coupon_codes/coupon_redemptions land for the FAM beta-coupon
-- program; razorpay_webhook_events learns which track an event belongs to.
-- A one-time backfill gives every existing tenant a trialing subscription row
-- (the write path starts at tenant creation from this sprint on).
--
-- Additive + idempotent.
-- =============================================================================

-- ─── subscriptions: Razorpay linkage + coupon + grace ────────────────────────
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS razorpay_plan_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS authorization_url text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS applied_coupon_id uuid;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz;

-- ─── coupon_codes (FAM service-layer only — no tenant access at all) ─────────
CREATE TABLE IF NOT EXISTS coupon_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  campaign         text NOT NULL DEFAULT 'general',
  months           int  NOT NULL CHECK (months BETWEEN 1 AND 12),
  max_redemptions  int  NOT NULL DEFAULT 1 CHECK (max_redemptions >= 1),
  redemption_count int  NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  expires_at       timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coupon_codes_campaign ON coupon_codes (campaign);
-- Deny-all for the tenant connection: RLS on with no policies, no grants.
ALTER TABLE coupon_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_codes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON coupon_codes FROM flicks_app;

-- ─── coupon_redemptions (tenant-visible history; writes are service-role) ────
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id   uuid NOT NULL REFERENCES coupon_codes(id),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  redeemed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  months      int  NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  -- One coupon EVER per tenant (§8B.3) — enforced by the database, not code.
  CONSTRAINT coupon_redemptions_tenant_once UNIQUE (tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions (coupon_id);
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_coupon_redemptions ON coupon_redemptions;
CREATE POLICY tenant_isolation_coupon_redemptions ON coupon_redemptions
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT ON coupon_redemptions TO flicks_app;
REVOKE INSERT, UPDATE, DELETE ON coupon_redemptions FROM flicks_app;


-- A user's DPDP account deletion must never be blocked by a coupon trail
-- (idempotent re-run fix for databases that applied the earlier 0028).
ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_redeemed_by_fkey;
ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_redeemed_by_fkey
  FOREIGN KEY (redeemed_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE coupon_codes DROP CONSTRAINT IF EXISTS coupon_codes_created_by_fkey;
ALTER TABLE coupon_codes ADD CONSTRAINT coupon_codes_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- ─── razorpay_webhook_events: platform vs tenant track ───────────────────────
ALTER TABLE razorpay_webhook_events
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'tenant'
  CHECK (source IN ('tenant', 'platform'));

-- ─── one-time backfill: a trialing subscription row for every tenant ─────────
-- New tenants get their row at creation (onboarding.service). Existing tenants
-- get at least 7 days of runway from migration time so the billing launch
-- never hard-locks a workspace that predates it; the Specflicks internal
-- tenant is exempt from billing entirely.
INSERT INTO subscriptions (tenant_id, plan_code, status, per_user_price, user_count, billing_cycle, trial_ends_at)
SELECT
  t.id,
  'beta',
  'trialing',
  499,
  GREATEST(1, (
    SELECT count(*) FROM memberships m
    WHERE m.tenant_id = t.id AND m.status = 'active'
      AND m.role NOT IN ('auditor', 'fam', 'super_admin')
  )),
  'monthly',
  GREATEST(coalesce(t.trial_ends_at, now()), now() + interval '7 days')
FROM tenants t
WHERE t.id <> '00000000-0000-0000-0000-000000000001'
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id)
ON CONFLICT (tenant_id) DO NOTHING;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0029_autodebit_enum_alignment.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0029 — auto-debit enum alignment (PRD v4 §8.3 conformance)
-- =============================================================================
-- 0027 shipped invoice_subscriptions.mandate_status / collection_mode and the
-- subscription_charge_attempts ledger WITHOUT the CHECK constraints the PRD
-- specifies, and with a couple of value names that drifted from §8.3/§8.4:
--   • mandate_status used 'authorized'          → PRD says 'authenticated'
--   • charge status used 'succeeded'/'pending'  → PRD says 'captured'/'created'
--   • the ledger lacked attempt_no + failure_code
-- This migration reconciles the stored values to the PRD set, adds the missing
-- columns, and pins both enums with CHECK constraints. Writers are updated in
-- lockstep (subscription-mandates.service.ts).
--
-- Additive + idempotent (drop-then-add constraints, IF NOT EXISTS columns,
-- value UPDATEs that no-op once migrated). Safe to re-run.
-- =============================================================================

-- ─── invoice_subscriptions.mandate_status: migrate legacy value, then constrain ─
UPDATE invoice_subscriptions SET mandate_status = 'authenticated' WHERE mandate_status = 'authorized';
ALTER TABLE invoice_subscriptions DROP CONSTRAINT IF EXISTS invoice_subscriptions_mandate_status_check;
ALTER TABLE invoice_subscriptions ADD  CONSTRAINT invoice_subscriptions_mandate_status_check
  CHECK (mandate_status IN ('none','pending_authorization','authenticated','active','paused','halted','revoked','failed'));

-- ─── invoice_subscriptions.collection_mode: constrain ────────────────────────
ALTER TABLE invoice_subscriptions DROP CONSTRAINT IF EXISTS invoice_subscriptions_collection_mode_check;
ALTER TABLE invoice_subscriptions ADD  CONSTRAINT invoice_subscriptions_collection_mode_check
  CHECK (collection_mode IN ('manual','auto_debit'));

-- ─── subscription_charge_attempts: new columns + status reconciliation ───────
ALTER TABLE subscription_charge_attempts ADD COLUMN IF NOT EXISTS attempt_no   smallint;
ALTER TABLE subscription_charge_attempts ADD COLUMN IF NOT EXISTS failure_code text;
UPDATE subscription_charge_attempts SET status = 'captured' WHERE status = 'succeeded';
UPDATE subscription_charge_attempts SET status = 'created'  WHERE status = 'pending';
-- Postgres names the inline column CHECK from 0027 '<table>_<column>_check'.
ALTER TABLE subscription_charge_attempts DROP CONSTRAINT IF EXISTS subscription_charge_attempts_status_check;
ALTER TABLE subscription_charge_attempts ADD  CONSTRAINT subscription_charge_attempts_status_check
  CHECK (status IN ('created','captured','failed'));

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0030_platform_evolution.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0030 — platform evolution (PRD v5 §2.2, §2.5, §11 · Sprint 24)
-- =============================================================================
-- Foundation for the CRM module and everything after it:
--   • domain_events — transactional OUTBOX. State changes write an event row in
--     the SAME transaction; a worker-side dispatcher drains undispatched rows
--     to BullMQ for async subscribers (webhooks, timeline, workflows, the
--     future AI module). Payloads carry ids/enums/amounts ONLY — never PII.
--   • api_keys — hashed per-tenant public-API keys (flk_live_… prefix shown,
--     SHA-256 stored), scoped + revocable.
--   • webhook_endpoints / webhook_deliveries — tenant-configured outbound
--     webhooks with encrypted secrets, HMAC signing and a delivery ledger.
--
-- RLS posture (PRD §15): service-layer only for reads/management everywhere;
-- domain_events additionally allows tenant-scoped INSERT so the outbox write
-- can ride inside the app-role transaction (that is the whole point of an
-- outbox). api_keys / webhook secrets are NEVER readable by the app role.
--
-- Additive + idempotent.
-- =============================================================================

-- ─── domain_events (outbox) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform event
  event_name        text NOT NULL,                                  -- e.g. 'crm.deal.won'
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  payload           jsonb NOT NULL DEFAULT '{}',
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  dispatched_at     timestamptz,
  dispatch_attempts smallint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_de_undispatched
  ON domain_events (occurred_at) WHERE dispatched_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_de_tenant_name_time
  ON domain_events (tenant_id, event_name, occurred_at DESC);

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
-- App role: INSERT-only, and only into its own tenant (outbox write in-tx).
DROP POLICY IF EXISTS domain_events_tenant_insert ON domain_events;
CREATE POLICY domain_events_tenant_insert ON domain_events
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT INSERT ON domain_events TO flicks_app;
REVOKE SELECT, UPDATE, DELETE ON domain_events FROM flicks_app;

-- ─── api_keys (public API §11) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,          -- SHA-256 hex of the full key
  key_prefix   text NOT NULL,                 -- display: 'flk_live_ab12…' (never the key)
  scopes       text[] NOT NULL DEFAULT '{}',  -- crm:read|crm:write|directory:read|directory:write|webhooks:manage
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
-- Service-layer only — hashes must never be readable by the app role.
REVOKE ALL ON api_keys FROM flicks_app;

-- ─── webhook_endpoints ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url                  text NOT NULL,
  secret_encrypted     text NOT NULL,                  -- AES-256-GCM under WEBHOOK_SECRET_ENC_KEY
  events               text[] NOT NULL DEFAULT '{}',   -- subscribed event names (Appendix A)
  active               boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at          timestamptz,
  disabled_reason      text,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant
  ON webhook_endpoints (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
-- Service-layer only — encrypted secrets stay out of app-role reach.
REVOKE ALL ON webhook_endpoints FROM flicks_app;

-- ─── webhook_deliveries (ledger) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id         uuid,                                -- domain_events.id
  event_name       text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','success','failed','exhausted')),
  attempts         smallint NOT NULL DEFAULT 0,
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant
  ON webhook_deliveries (tenant_id, created_at DESC);
-- At-least-once outbox + redelivered fan-out jobs would otherwise create
-- duplicate delivery rows (and duplicate POSTs). One delivery per
-- (endpoint, event) makes the fan-out idempotent. Non-partial: NULL event_id
-- rows (e.g. test/manual deliveries) are already distinct under a unique
-- index, so only real event ids dedupe — and ON CONFLICT matches cleanly.
DROP INDEX IF EXISTS uq_webhook_delivery_endpoint_event;
CREATE UNIQUE INDEX uq_webhook_delivery_endpoint_event
  ON webhook_deliveries (endpoint_id, event_id);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
-- Service-layer only (delivery-log UI is served through the service role).
REVOKE ALL ON webhook_deliveries FROM flicks_app;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0031_directory_kernel.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0031 — directory kernel (PRD v5 §3 · Sprint 25)
-- =============================================================================
-- Shared people/companies that CRM presents as Contacts/Companies and that
-- Invoicing links from `customers`. ONE canonical person/org per tenant — no
-- dual records. Backfills existing invoicing customers idempotently:
--   business  → directory_companies (dedupe by domain, else exact name)
--   individual→ directory_people    (dedupe by email)
-- and links customers.directory_company_id / directory_person_id.
--
-- Additive + idempotent.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ─── directory_companies ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS directory_companies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  domain         citext,
  website        text, industry text, size_band text, phone text,
  address_line1  text, address_line2 text, city text, state text,
  postal_code    text, country_code char(2),
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  source         text,                          -- manual|import|form|api|invoicing_backfill
  last_activity_at timestamptz,
  custom         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dir_company_domain
  ON directory_companies (tenant_id, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dir_company_name
  ON directory_companies USING gin (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS idx_dir_company_name_trgm
  ON directory_companies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dir_company_tenant
  ON directory_companies (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE directory_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_directory_companies ON directory_companies;
CREATE POLICY tenant_isolation_directory_companies ON directory_companies
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON directory_companies TO flicks_app;

-- ─── directory_people ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS directory_people (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name     text, last_name text,
  display_name   text GENERATED ALWAYS AS
                   (COALESCE(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),''),
                             first_name, last_name)) STORED,
  email          citext, secondary_emails citext[],
  phone          text, secondary_phones text[],
  title          text,
  company_id     uuid REFERENCES directory_companies(id) ON DELETE SET NULL,
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  source         text, last_activity_at timestamptz,
  custom         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dir_people_email
  ON directory_people (tenant_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dir_people_company
  ON directory_people (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_dir_people_name
  ON directory_people USING gin (to_tsvector('simple', coalesce(first_name,'')||' '||coalesce(last_name,'')));
CREATE INDEX IF NOT EXISTS idx_dir_people_name_trgm
  ON directory_people USING gin ((coalesce(first_name,'')||' '||coalesce(last_name,'')) gin_trgm_ops);

ALTER TABLE directory_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_people FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_directory_people ON directory_people;
CREATE POLICY tenant_isolation_directory_people ON directory_people
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON directory_people TO flicks_app;

-- ─── invoicing linkage (non-breaking) ────────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS directory_company_id uuid REFERENCES directory_companies(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS directory_person_id  uuid REFERENCES directory_people(id);

-- ─── backfill (idempotent) ───────────────────────────────────────────────────
-- Only touches customers not yet linked. Runs as service role (superuser),
-- so RLS is bypassed here; tenant_id is carried explicitly on every row.
DO $backfill$
DECLARE c RECORD;
  v_company_id uuid;
  v_person_id  uuid;
  v_domain     text;
BEGIN
  FOR c IN
    SELECT * FROM customers
    WHERE deleted_at IS NULL
      AND directory_company_id IS NULL AND directory_person_id IS NULL
  LOOP
    IF c.customer_type = 'individual' THEN
      -- Dedupe people by email within the tenant.
      v_person_id := NULL;
      IF c.email IS NOT NULL AND c.email <> '' THEN
        SELECT id INTO v_person_id FROM directory_people
          WHERE tenant_id = c.tenant_id AND email = c.email::citext AND deleted_at IS NULL
          LIMIT 1;
      END IF;
      IF v_person_id IS NULL THEN
        INSERT INTO directory_people (tenant_id, first_name, email, phone, source)
        VALUES (c.tenant_id, c.display_name, NULLIF(c.email,'')::citext, c.phone, 'invoicing_backfill')
        RETURNING id INTO v_person_id;
      END IF;
      UPDATE customers SET directory_person_id = v_person_id WHERE id = c.id;
    ELSE
      -- Business: dedupe companies by domain (from email) else exact name.
      v_domain := NULLIF(lower(split_part(COALESCE(c.email,''), '@', 2)), '');
      v_company_id := NULL;
      IF v_domain IS NOT NULL THEN
        SELECT id INTO v_company_id FROM directory_companies
          WHERE tenant_id = c.tenant_id AND domain = v_domain::citext AND deleted_at IS NULL
          LIMIT 1;
      END IF;
      IF v_company_id IS NULL THEN
        SELECT id INTO v_company_id FROM directory_companies
          WHERE tenant_id = c.tenant_id AND lower(name) = lower(c.display_name) AND deleted_at IS NULL
          LIMIT 1;
      END IF;
      IF v_company_id IS NULL THEN
        INSERT INTO directory_companies
          (tenant_id, name, domain, phone, country_code, address_line1, city, state, postal_code, source)
        VALUES
          (c.tenant_id, c.display_name, v_domain::citext, c.phone,
           NULLIF(c.country_code,'')::char(2), c.billing_address_line1, c.billing_city,
           c.billing_state, c.billing_postal_code, 'invoicing_backfill')
        RETURNING id INTO v_company_id;
      END IF;
      -- A named primary contact becomes a linked person under the company.
      v_person_id := NULL;
      IF c.primary_contact_name IS NOT NULL AND c.primary_contact_name <> '' THEN
        INSERT INTO directory_people (tenant_id, first_name, email, phone, company_id, source)
        VALUES (c.tenant_id, c.primary_contact_name, NULLIF(c.email,'')::citext, c.phone,
                v_company_id, 'invoicing_backfill')
        RETURNING id INTO v_person_id;
      END IF;
      UPDATE customers SET directory_company_id = v_company_id,
             directory_person_id = COALESCE(v_person_id, directory_person_id)
        WHERE id = c.id;
    END IF;
  END LOOP;
END
$backfill$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0032_crm_core.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- =============================================================================
-- 0032 — CRM core: pipelines, deals, products, tags, FX (PRD v5 §4, §12.1, §19.1)
-- =============================================================================
-- Additive + idempotent. Seeds a default "Sales" pipeline + stages + lost
-- reasons (Appendix B) for every existing tenant that lacks one; onboarding
-- seeds the same for new tenants.
-- =============================================================================

-- ─── fx_rates: real multi-currency (§12.1) ───────────────────────────────────
-- USD-based daily rates from openexchangerates; cross-rates computed in app.
CREATE TABLE IF NOT EXISTS fx_rates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base        char(3) NOT NULL DEFAULT 'USD',
  quote       char(3) NOT NULL,               -- ISO-4217
  rate        numeric(18,8) NOT NULL,          -- 1 base = <rate> quote
  as_of       date NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_rate_day ON fx_rates (base, quote, as_of);
CREATE INDEX IF NOT EXISTS idx_fx_rate_latest ON fx_rates (quote, as_of DESC);
-- Global reference data (no tenant_id): readable by the app role, writable
-- only by the service-role refresh job.
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_rates_read ON fx_rates;
CREATE POLICY fx_rates_read ON fx_rates FOR SELECT USING (true);
GRANT SELECT ON fx_rates TO flicks_app;
REVOKE INSERT, UPDATE, DELETE ON fx_rates FROM flicks_app;

-- ─── pipelines & stages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipelines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  display_order smallint NOT NULL DEFAULT 0,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pipelines_tenant ON pipelines (tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id     uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name            text NOT NULL,
  display_order   smallint NOT NULL,
  win_probability smallint NOT NULL DEFAULT 0 CHECK (win_probability BETWEEN 0 AND 100),
  rotting_days    smallint,
  stage_type      text NOT NULL DEFAULT 'open' CHECK (stage_type IN ('open','won','lost')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON pipeline_stages (tenant_id, pipeline_id, display_order);

-- ─── deals ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id        uuid NOT NULL REFERENCES pipelines(id),
  stage_id           uuid NOT NULL REFERENCES pipeline_stages(id),
  title              text NOT NULL,
  company_id         uuid REFERENCES directory_companies(id),
  primary_person_id  uuid REFERENCES directory_people(id),
  owner_user_id      uuid NOT NULL REFERENCES users(id),
  value_amount       numeric(15,2) NOT NULL DEFAULT 0,
  currency           char(3) NOT NULL,
  fx_rate_to_base    numeric(15,6) NOT NULL DEFAULT 1,
  value_base_amount  numeric(15,2) NOT NULL DEFAULT 0,
  expected_close_date date,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  won_at             timestamptz, lost_at timestamptz,
  lost_reason_id     uuid, lost_reason_note text,
  source             text,
  score              int,
  stage_entered_at   timestamptz NOT NULL DEFAULT now(),
  next_activity_at   timestamptz,
  last_activity_at   timestamptz,
  invoice_id         uuid,
  custom             jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_deals_board ON deals (tenant_id, pipeline_id, stage_id)
  WHERE deleted_at IS NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals (tenant_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_deals_close ON deals (tenant_id, expected_close_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_deals_custom ON deals USING gin (custom);

CREATE TABLE IF NOT EXISTS deal_people (
  deal_id   uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role      text,
  PRIMARY KEY (deal_id, person_id)
);

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_stage_id uuid, to_stage_id uuid NOT NULL,
  changed_by    uuid REFERENCES users(id),
  changed_at    timestamptz NOT NULL DEFAULT now(),
  seconds_in_previous_stage bigint
);
CREATE INDEX IF NOT EXISTS idx_stage_history_deal ON deal_stage_history (tenant_id, deal_id, changed_at);

CREATE TABLE IF NOT EXISTS lost_reasons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label         text NOT NULL,
  display_order smallint DEFAULT 0,
  archived      boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS deal_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  item_id       uuid REFERENCES items(id),
  name          text NOT NULL,
  quantity      numeric(15,4) NOT NULL DEFAULT 1,
  unit_price    numeric(15,2) NOT NULL,
  currency      char(3) NOT NULL,
  discount_pct  numeric(5,2) DEFAULT 0,
  line_total    numeric(15,2) NOT NULL,
  display_order smallint DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deal_products_deal ON deal_products (tenant_id, deal_id);

-- Invoicing back-link (non-breaking).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES deals(id);

-- ─── tags / record_tags (§19.1) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label      text NOT NULL,
  color      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_label ON tags (tenant_id, lower(label));

CREATE TABLE IF NOT EXISTS record_tags (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  object_type text NOT NULL CHECK (object_type IN ('person','company','deal','lead')),
  object_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, tag_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS idx_record_tags_object ON record_tags (tenant_id, object_type, object_id);

-- ─── RLS (tenant isolation on every CRM table) ───────────────────────────────
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pipelines','pipeline_stages','deals','deal_people','deal_stage_history',
    'lost_reasons','deal_products','tags','record_tags'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I FOR ALL '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

-- ─── seed default pipeline/stages/lost reasons per tenant (Appendix B) ────────
DO $seed$
DECLARE tn RECORD; v_pipeline uuid;
BEGIN
  FOR tn IN SELECT id FROM tenants LOOP
    -- Skip tenants that already have a pipeline (idempotent).
    IF EXISTS (SELECT 1 FROM pipelines WHERE tenant_id = tn.id AND deleted_at IS NULL) THEN
      CONTINUE;
    END IF;
    INSERT INTO pipelines (tenant_id, name, is_default, display_order)
    VALUES (tn.id, 'Sales', true, 0) RETURNING id INTO v_pipeline;
    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, display_order, win_probability, rotting_days, stage_type) VALUES
      (tn.id, v_pipeline, 'Qualified',       0, 10,  NULL, 'open'),
      (tn.id, v_pipeline, 'Contact Made',    1, 25,  NULL, 'open'),
      (tn.id, v_pipeline, 'Demo Scheduled',  2, 40,  7,    'open'),
      (tn.id, v_pipeline, 'Proposal Sent',   3, 60,  10,   'open'),
      (tn.id, v_pipeline, 'Negotiation',     4, 80,  10,   'open'),
      (tn.id, v_pipeline, 'Won',             5, 100, NULL, 'won'),
      (tn.id, v_pipeline, 'Lost',            6, 0,   NULL, 'lost');
    INSERT INTO lost_reasons (tenant_id, label, display_order) VALUES
      (tn.id, 'Price', 0), (tn.id, 'Competitor', 1), (tn.id, 'No budget', 2),
      (tn.id, 'No response', 3), (tn.id, 'Bad timing', 4), (tn.id, 'Not a fit', 5);
  END LOOP;
END
$seed$;

-- CRM module toggle default-enabled marker (guard already defaults on; this
-- makes the state explicit and visible in the FAM console).
INSERT INTO tenant_module_toggles (tenant_id, module, enabled)
SELECT id, 'crm', true FROM tenants
ON CONFLICT (tenant_id, module) DO NOTHING;

-- ─── Deal→invoice idempotency guards (review finding M5) ──────────────────────
-- Defense-in-depth so a repeated deal→invoice call (double-click, retry, race)
-- can never fan out duplicates: at most ONE billing customer per directory link,
-- and at most ONE invoice per deal. The service also short-circuits on the
-- deal↔invoice back-link; these make the invariant true at the storage layer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_directory_company
  ON customers (tenant_id, directory_company_id)
  WHERE directory_company_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_directory_person
  ON customers (tenant_id, directory_person_id)
  WHERE directory_person_id IS NOT NULL AND deleted_at IS NULL;
-- One invoice AND one quote per deal (document_type keyed) — a deal legitimately
-- produces a quote and, separately, an invoice, but never two of the same kind.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_deal_doc
  ON invoices (tenant_id, deal_id, document_type)
  WHERE deal_id IS NOT NULL;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0033_crm_views_fields.sql
-- ═════════════════════════════════════════════════════════════════════════════
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

-- Forward-drop the 0032-era per-deal invoice index. 0032 was amended in-place to
-- key on (tenant_id, deal_id, document_type) — fresh DBs only ever create the new
-- index, but ALREADY-PROVISIONED DBs still carry the old two-column one, which
-- would reject "one quote AND one invoice on the same deal" with a unique
-- violation. Idempotent on both kinds of environment.
DROP INDEX IF EXISTS uq_invoices_deal;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_deal_doc
  ON invoices (tenant_id, deal_id, document_type)
  WHERE deal_id IS NOT NULL;

-- Quote acceptance audit timestamp (the ACCEPTED status lives in invoices.status).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quote_accepted_at timestamptz;

-- ─── Custom fields (§9.1) ─────────────────────────────────────────────────────
-- Definitions live here; VALUES live in the object's existing `custom` jsonb
-- (deals.custom, directory_companies.custom, directory_people.custom) — no
-- per-value table needed.
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type  text NOT NULL CHECK (object_type IN ('deal','person','company','lead')),
  key          text NOT NULL,
  label        text NOT NULL,
  field_type   text NOT NULL CHECK (field_type IN ('text','number','date','select','multiselect','checkbox','url')),
  options      jsonb NOT NULL DEFAULT '[]',
  is_required  boolean NOT NULL DEFAULT false,
  display_order smallint NOT NULL DEFAULT 0,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_key
  ON custom_field_defs (tenant_id, object_type, key) WHERE archived = false;

-- ─── Saved views (§9.2) ───────────────────────────────────────────────────────
-- A named filter/sort/column set on a list or board. Private to the owner unless
-- is_shared; RLS keeps it tenant-scoped, the service enforces owner-vs-shared.
CREATE TABLE IF NOT EXISTS saved_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type   text NOT NULL CHECK (object_type IN ('deal','person','company','lead')),
  name          text NOT NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  is_shared     boolean NOT NULL DEFAULT false,
  filters       jsonb NOT NULL DEFAULT '{}',
  sort          jsonb NOT NULL DEFAULT '{}',
  columns       jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_views_scope ON saved_views (tenant_id, object_type);

-- ─── Record files / attachments (§19.2) ───────────────────────────────────────
-- Table lands now (joins the isolation suite); the generalized magic-byte upload
-- service is built in Phase C alongside email attachments (shared surface).
CREATE TABLE IF NOT EXISTS record_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type  text NOT NULL CHECK (object_type IN ('deal','person','company','lead')),
  object_id    uuid NOT NULL,
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  storage_key  text NOT NULL,
  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_record_files_object
  ON record_files (tenant_id, object_type, object_id) WHERE deleted_at IS NULL;

-- ─── RLS for the new tables (FORCE + tenant isolation + app grants) ───────────
DO $v5views$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['custom_field_defs','saved_views','record_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$v5views$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0034_crm_activities.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0034 — CRM activities (PRD v5 §6, Sprint 28)
--
-- The activity loop that drives activity-based selling: tasks, calls, meetings
-- and notes attached to deals/people/companies, with an assignee and a due
-- time. deals.next_activity_at / last_activity_at are maintained by the
-- service on every write, so the board's "no next activity" doctrine line and
-- idle detection stay cheap. Idempotent + additive per house convention.

CREATE TABLE IF NOT EXISTS activities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('task','call','meeting','note')),
  subject          text NOT NULL,
  body             text,
  deal_id          uuid REFERENCES deals(id) ON DELETE CASCADE,
  person_id        uuid REFERENCES directory_people(id) ON DELETE SET NULL,
  company_id       uuid REFERENCES directory_companies(id) ON DELETE SET NULL,
  assignee_user_id uuid NOT NULL REFERENCES users(id),
  due_at           timestamptz,                       -- NULL for logged notes
  completed_at     timestamptz,
  completed_by     uuid REFERENCES users(id),
  outcome          text,                              -- call outcomes: connected|no_answer|busy|voicemail|wrong_number
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_activities_assignee_due
  ON activities (tenant_id, assignee_user_id, due_at)
  WHERE completed_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activities_deal
  ON activities (tenant_id, deal_id, due_at) WHERE deleted_at IS NULL;

-- @mentions inside activity bodies → in-app notifications (§6.3).
CREATE TABLE IF NOT EXISTS activity_mentions (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  activity_id       uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, mentioned_user_id)
);

DO $act$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activities','activity_mentions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$act$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0035_crm_email.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0035 — CRM Email Phase A (PRD v5 §7.1, §19.4/§19.5, Sprint 29)
--
-- Compose/track/sequence infrastructure + the BCC dropbox + do-not-contact.
-- Idempotent + additive per house convention; every tenant table gets FORCE
-- RLS + isolation policy + flicks_app grants and joins the isolation suite.

-- Per-user signature (§19.4) appended to composed email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_signature_html text;

-- Do-not-contact (§19.5): hard block on compose/sequences; auto-set on
-- bounce/complaint; surfaced as a badge on the person.
ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS email_do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS email_do_not_contact_reason text;

-- Reusable message templates (manager UI in chunk 2; API now).
CREATE TABLE IF NOT EXISTS email_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  subject     text NOT NULL,
  body_html   text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived    boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_template_name
  ON email_templates (tenant_id, lower(name)) WHERE archived = false;

-- Every CRM email, both directions. Outbound rows carry tracking counters;
-- inbound rows come from the BCC dropbox webhook.
CREATE TABLE IF NOT EXISTS email_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('out','in')),
  status        text NOT NULL DEFAULT 'sent', -- sent|delivered|bounced|complained|failed|received
  provider_id   text,                          -- Resend message id (webhook correlation)
  from_email    text,
  to_email      text NOT NULL,
  subject       text NOT NULL,
  body_html     text,
  person_id     uuid REFERENCES directory_people(id) ON DELETE SET NULL,
  deal_id       uuid REFERENCES deals(id) ON DELETE SET NULL,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  open_token    text UNIQUE,                   -- signed pixel token
  open_count    integer NOT NULL DEFAULT 0,
  click_count   integer NOT NULL DEFAULT 0,
  tracking      boolean NOT NULL DEFAULT false,
  sequence_enrollment_id uuid,                 -- set by the sequence engine (chunk 2)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_messages_deal ON email_messages (tenant_id, deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_person ON email_messages (tenant_id, person_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_provider ON email_messages (provider_id);

-- Wrapped links (one row per distinct href per message) for click tracking.
CREATE TABLE IF NOT EXISTS email_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  url         text NOT NULL,
  click_count integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_links_message ON email_links (tenant_id, message_id);

-- Delivery/engagement lifecycle (webhook + tracking endpoints append here).
CREATE TABLE IF NOT EXISTS email_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  type        text NOT NULL, -- delivered|bounced|complained|opened|clicked|unsubscribed
  meta        jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_message ON email_events (tenant_id, message_id, occurred_at);

-- Sequences (C10) — tables land now; the engine ships in the next chunk.
CREATE TABLE IF NOT EXISTS sequences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  send_window_start text NOT NULL DEFAULT '09:00',
  send_window_end   text NOT NULL DEFAULT '18:00',
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sequence_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id  uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order   smallint NOT NULL,
  wait_days    smallint NOT NULL DEFAULT 0,
  subject      text NOT NULL,
  body_html    text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sequence_steps ON sequence_steps (tenant_id, sequence_id, step_order);
CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id  uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
  deal_id      uuid REFERENCES deals(id) ON DELETE SET NULL,
  enrolled_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  current_step smallint NOT NULL DEFAULT 0,
  next_send_at timestamptz,
  status       text NOT NULL DEFAULT 'active', -- active|completed|exited
  exit_reason  text,                            -- replied|won|lost|dnc|manual
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_enrollment
  ON sequence_enrollments (sequence_id, person_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
  ON sequence_enrollments (tenant_id, next_send_at) WHERE status = 'active';

-- BCC dropbox address per tenant: {slug}-{token}@in.<domain> (§7.1).
CREATE TABLE IF NOT EXISTS tenant_inbound_addresses (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Phase-B scaffold (C21): two-way sync accounts, dark behind feature.email_sync.
-- Token columns are AES-256-GCM ciphertext; a self-visibility RLS policy keeps
-- one member's tokens invisible to everyone else in the tenant.
CREATE TABLE IF NOT EXISTS connected_email_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('google','microsoft')),
  email         text NOT NULL,
  access_token_enc  text,
  refresh_token_enc text,
  status        text NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connected_account ON connected_email_accounts (tenant_id, user_id, provider);

-- Resend webhook idempotency ledger (service-role only, like razorpay_events).
CREATE TABLE IF NOT EXISTS resend_webhook_events (
  id          text PRIMARY KEY,        -- svix message id
  received_at timestamptz NOT NULL DEFAULT now()
);

DO $mail$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_templates','email_messages','email_links','email_events','sequences','sequence_steps','sequence_enrollments','tenant_inbound_addresses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$mail$;

-- connected_email_accounts: tenant isolation AND self-visibility — only the
-- OWNING user's transactions may read/write their row (tokens stay private).
ALTER TABLE connected_email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_email_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS self_connected_email_accounts ON connected_email_accounts;
CREATE POLICY self_connected_email_accounts ON connected_email_accounts
  FOR ALL USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = current_setting('app.user_id', true)::uuid
  ) WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = current_setting('app.user_id', true)::uuid
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON connected_email_accounts TO flicks_app;
-- resend_webhook_events: service-role only — NO app grants on purpose.

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0036_crm_automation.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0036 — CRM Automation & Capture (PRD v5 §5/§8, Sprint 30)
--
-- Leads inbox (C6), web forms + hosted capture (C13), workflows engine (C12)
-- with a run audit. Idempotent + additive per house convention; every tenant
-- table gets FORCE RLS + isolation policy + flicks_app grants and joins the
-- isolation suite.

-- Leads (§5.1): a lightweight triage row — converting creates/links directory
-- records + a deal and never leaves a duplicate lead object behind.
CREATE TABLE IF NOT EXISTS leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name    text NOT NULL,
  last_name     text,
  company_name  text,
  email         text,
  phone         text,
  note          text,
  source        text NOT NULL DEFAULT 'manual',       -- manual|api|import|email_in|form:<tag>
  score         integer NOT NULL DEFAULT 0,           -- rule-based (§5.3), recomputed on write
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','working','converted','discarded')),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  form_id       uuid,                                  -- set when captured via a web form
  utm           jsonb NOT NULL DEFAULT '{}',
  extra         jsonb NOT NULL DEFAULT '{}',           -- non-standard form fields
  converted_person_id  uuid REFERENCES directory_people(id) ON DELETE SET NULL,
  converted_company_id uuid REFERENCES directory_companies(id) ON DELETE SET NULL,
  converted_deal_id    uuid REFERENCES deals(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_inbox ON leads (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (tenant_id, lower(email));

-- Web forms (C13, §5.2): hosted at /f/:token + embeddable; submissions become
-- leads. Spam defense is honeypot + min-fill-time + per-IP throttle — no
-- third-party CAPTCHAs.
CREATE TABLE IF NOT EXISTS web_forms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  token           text NOT NULL UNIQUE,                -- public URL part, hex
  title           text NOT NULL DEFAULT 'Talk to sales',
  intro           text,
  fields          jsonb NOT NULL DEFAULT '[]',         -- [{key,label,type,required}]
  source_tag      text NOT NULL DEFAULT 'form',        -- lead.source becomes form:<tag>
  assignment      text NOT NULL DEFAULT 'round_robin' CHECK (assignment IN ('none','round_robin')),
  success_message text NOT NULL DEFAULT E'Thanks — we''ll be in touch',
  redirect_url    text,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_web_form_name ON web_forms (tenant_id, lower(name));

-- Submission audit (C13 Submissions tab) — payload snapshot + the lead it made.
CREATE TABLE IF NOT EXISTS form_submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  form_id    uuid NOT NULL REFERENCES web_forms(id) ON DELETE CASCADE,
  lead_id    uuid REFERENCES leads(id) ON DELETE SET NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  utm        jsonb NOT NULL DEFAULT '{}',
  ip_hash    text,                                     -- sha256(ip), throttle key — never the raw IP
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_submissions ON form_submissions (tenant_id, form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_throttle ON form_submissions (ip_hash, created_at);

-- Workflows (C12, §8): trigger → conditions → actions, stored as validated
-- JSON. Beta limits (20 active / 2,000 runs/day / chain depth ≤ 2) are
-- enforced in the service, not the schema.
CREATE TABLE IF NOT EXISTS workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  trigger     text NOT NULL,                           -- domain event name (crm.*)
  conditions  jsonb NOT NULL DEFAULT '[]',             -- [{field,op,value}] AND-combined
  actions     jsonb NOT NULL DEFAULT '[]',             -- [{type,...config}] in order
  active      boolean NOT NULL DEFAULT true,
  runs_count  integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows (tenant_id, trigger) WHERE active = true;

-- Run audit (C12 run history): one row per workflow x trigger event —
-- the unique pair makes runs idempotent under outbox redelivery.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id  uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  event_id     text NOT NULL,                          -- domain_events.id that fired it
  subject_type text,                                   -- deal|lead|activity|email
  subject_id   uuid,
  status       text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','skipped')),
  steps        jsonb NOT NULL DEFAULT '[]',            -- [{label,status,error?}]
  depth        smallint NOT NULL DEFAULT 0,            -- workflow-caused chain depth (loop guard)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_run ON workflow_runs (workflow_id, event_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs ON workflow_runs (tenant_id, created_at DESC);

DO $auto$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','web_forms','form_submissions','workflows','workflow_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$auto$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0037_crm_reports_import.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0037 — CRM Reports/Goals + Import/Merge + Sample data (PRD v5
-- §10, §19.6/§19.7, C14–C17, C22 — Sprint 31, beta gate).
-- Idempotent + additive per house convention; tenant tables get FORCE RLS +
-- isolation policy + flicks_app grants.

-- §19.6 goals: monthly won-revenue targets, per user or team (user_id NULL).
CREATE TABLE IF NOT EXISTS sales_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,  -- NULL = whole team
  period      text NOT NULL,                                -- 'YYYY-MM'
  target_base numeric(14,2) NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (period ~ '^[0-9]{4}-[0-9]{2}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_goal
  ON sales_goals (tenant_id, period, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- C14 import: one row per run; created record ids are stamped with the batch
-- so the 24h undo window can retract exactly what the batch created.
CREATE TABLE IF NOT EXISTS import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type   text NOT NULL CHECK (object_type IN ('people','companies','leads')),
  file_name     text,
  rows_read     integer NOT NULL DEFAULT 0,
  rows_created  integer NOT NULL DEFAULT 0,
  rows_updated  integer NOT NULL DEFAULT 0,
  rows_skipped  integer NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]',   -- [{row, error}] first 200
  status        text NOT NULL DEFAULT 'done' CHECK (status IN ('done','undone')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  undone_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_import_batches ON import_batches (tenant_id, created_at DESC);

ALTER TABLE directory_people    ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE directory_companies ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE leads               ADD COLUMN IF NOT EXISTS import_batch_id uuid;

-- C15 merge tombstones: the loser row is soft-deleted and points at the
-- survivor so stale links/ids can be redirected.
ALTER TABLE directory_people    ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES directory_people(id) ON DELETE SET NULL;
ALTER TABLE directory_companies ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES directory_companies(id) ON DELETE SET NULL;

-- C22 sample data: remember exactly what the demo pack created so the toggle
-- can remove it cleanly.
CREATE TABLE IF NOT EXISTS sample_packs (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  record_ids jsonb NOT NULL DEFAULT '{}',      -- {table: [ids]}
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $rpt$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_goals','import_batches','sample_packs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rpt$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0038_crm_360_indexes.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0038 — Launch-readiness perf: indexes for the contact/company
-- 360° detail pages and the per-user email scans.
-- Additive + idempotent per house convention. These back queries shipped in
-- the MVP-polish pass that had no supporting index (sequential-scan cliff as a
-- tenant's data grows):
--   * deals.service.listForContact/listForCompany  → deals(primary_person_id|company_id)
--   * activities.service.listForContact/listForCompany → activities(person_id|company_id)
--   * sequences send throttle + reports activity leaderboard → email_messages(sender_user_id, created_at)
-- Partial on deleted_at IS NULL to match the query predicate and stay lean,
-- mirroring idx_activities_deal.

CREATE INDEX IF NOT EXISTS idx_deals_person
  ON deals (tenant_id, primary_person_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_company
  ON deals (tenant_id, company_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_activities_person
  ON activities (tenant_id, person_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activities_company
  ON activities (tenant_id, company_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_sender
  ON email_messages (sender_user_id, created_at);

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0039_pm_sync_engine.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0039 — Flicks Sync Engine foundations (PRD v6 §3.2; PRD-numbered
-- 0038, renumbered: 0038 was taken by the CRM 360° indexes).
-- Additive + idempotent per house convention.
--
-- 1. domain_events gains a globally monotonic sync_seq — the delta cursor for
--    the local-first client. Assigned at INSERT via sequence; existing rows
--    backfilled in occurred_at order in batches (prod table can be large).
-- 2. sync_mutations — the idempotency ledger for client mutation replays.

-- ── 1. sync_seq on the outbox ────────────────────────────────────────────────
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS sync_seq BIGINT;
CREATE SEQUENCE IF NOT EXISTS domain_events_sync_seq;

-- Batched backfill (10k/loop) in occurred_at order, only where NULL — safe to
-- re-run; no-op once complete. Explicit row_number assignment (NOT nextval in
-- UPDATE...FROM — the executor's join order is unspecified, which would break
-- the occurred_at ordering the cursor semantics document).
DO $bf$
DECLARE
  batch INTEGER;
BEGIN
  LOOP
    WITH batch_rows AS (
      SELECT id, row_number() OVER (ORDER BY occurred_at, id) AS rn
      FROM domain_events
      WHERE sync_seq IS NULL
      ORDER BY occurred_at, id
      LIMIT 10000
    ), base AS (
      SELECT coalesce(max(sync_seq), 0) AS off FROM domain_events
    )
    UPDATE domain_events de
    SET sync_seq = base.off + batch_rows.rn
    FROM batch_rows, base
    WHERE de.id = batch_rows.id;
    GET DIAGNOSTICS batch = ROW_COUNT;
    EXIT WHEN batch = 0;
  END LOOP;
END
$bf$;

-- Advance the sequence past the backfilled range, then let new rows take
-- nextval automatically.
SELECT setval('domain_events_sync_seq', greatest((SELECT coalesce(max(sync_seq), 0) FROM domain_events), 1));
ALTER TABLE domain_events ALTER COLUMN sync_seq SET DEFAULT nextval('domain_events_sync_seq');

-- NOT NULL only after a complete backfill (idempotent guard).
DO $nn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM domain_events WHERE sync_seq IS NULL) THEN
    ALTER TABLE domain_events ALTER COLUMN sync_seq SET NOT NULL;
  END IF;
END
$nn$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_de_sync_seq ON domain_events(sync_seq);
CREATE INDEX IF NOT EXISTS idx_de_tenant_seq ON domain_events(tenant_id, sync_seq);

-- ── 2. sync_mutations — idempotency ledger ───────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_mutations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_mutation_id UUID NOT NULL,
  result_seq BIGINT,                     -- sync_seq produced (NULL if rejected)
  status TEXT NOT NULL CHECK (status IN ('applied','rejected','conflict')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, client_mutation_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_mutations_prune ON sync_mutations(created_at);

-- Standard tenant RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sync_mutations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0040_pm_teams_core.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0040 — PM workspace model (PRD v6 §4; PRD-numbered 0039).
-- Teams, memberships, atomic per-team issue counters, workflow states, labels.
-- pm_issue_labels ships in 0041 with pm_issues (its FK target).
-- Additive + idempotent; FORCE RLS + tenant policy + grants on every table.

CREATE TABLE IF NOT EXISTS pm_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key VARCHAR(6) NOT NULL,                 -- "ENG" → ENG-123; uppercase A–Z0–9
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  timezone TEXT,                           -- cycle boundaries; NULL = tenant tz
  cycles_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cycle_length_weeks SMALLINT NOT NULL DEFAULT 2 CHECK (cycle_length_weeks BETWEEN 1 AND 6),
  cooldown_days SMALLINT NOT NULL DEFAULT 0 CHECK (cooldown_days BETWEEN 0 AND 7),
  cycle_start_dow SMALLINT NOT NULL DEFAULT 1 CHECK (cycle_start_dow BETWEEN 0 AND 6),
  cycle_auto_add_started BOOLEAN NOT NULL DEFAULT TRUE,
  upcoming_cycles SMALLINT NOT NULL DEFAULT 2 CHECK (upcoming_cycles BETWEEN 1 AND 4),
  estimate_scale TEXT NOT NULL DEFAULT 'count'
    CHECK (estimate_scale IN ('count','linear','fibonacci','exponential','tshirt')),
  triage_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  default_state_id UUID,                   -- backlog-category state for new issues
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_pm_teams_tenant ON pm_teams(tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pm_team_memberships (
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_lead BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_team_memberships_user ON pm_team_memberships(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS pm_team_counters (
  team_id UUID PRIMARY KEY REFERENCES pm_teams(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pm_workflow_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('triage','backlog','unstarted','started','completed','canceled')),
  position REAL NOT NULL,
  is_default_for_category BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (tenant_id, team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_pm_states_team ON pm_workflow_states(tenant_id, team_id);

CREATE TABLE IF NOT EXISTS pm_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID REFERENCES pm_teams(id) ON DELETE CASCADE,  -- NULL = workspace label
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_labels_scope
  ON pm_labels (tenant_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_teams','pm_team_memberships','pm_team_counters','pm_workflow_states','pm_labels'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

-- Module toggle seed: pm default-enabled for every tenant (CRM 0032 pattern).
INSERT INTO tenant_module_toggles (tenant_id, module, enabled)
SELECT id, 'pm', true FROM tenants
ON CONFLICT (tenant_id, module) DO NOTHING;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0041_pm_issues.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0041 — PM issues core (PRD v6 §5; PRD-numbered 0040).
-- pm_issues + companions (labels join, relations, subscribers, comments,
-- reactions, permanent field-change history) + FTS/trigram search columns
-- (§13) + record_files object_type extension. Additive + idempotent.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS pm_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id),
  number INTEGER NOT NULL,                          -- ENG-42 → 42 (pm_team_counters)
  title TEXT NOT NULL,
  description TEXT,                                 -- markdown; lazy-loaded by sync
  state_id UUID NOT NULL REFERENCES pm_workflow_states(id),
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  estimate NUMERIC(6,2),
  assignee_user_id UUID REFERENCES users(id),       -- SINGLE owner (doctrine)
  creator_user_id UUID REFERENCES users(id),
  parent_issue_id UUID REFERENCES pm_issues(id),
  project_id UUID,                                  -- FK added in 0042 (pm_projects)
  milestone_id UUID,
  cycle_id UUID,
  due_date DATE,
  board_rank TEXT NOT NULL,
  backlog_rank TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','import','api','github','intake','deal')),
  triaged_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, team_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_team_state ON pm_issues(tenant_id, team_id, state_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON pm_issues(tenant_id, assignee_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_issues_cycle ON pm_issues(tenant_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_issues_project ON pm_issues(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON pm_issues(parent_issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_search ON pm_issues USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_issues_title_trgm ON pm_issues USING GIN (title gin_trgm_ops);

CREATE TABLE IF NOT EXISTS pm_issue_labels (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES pm_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_issue_labels_label ON pm_issue_labels(tenant_id, label_id);

CREATE TABLE IF NOT EXISTS pm_issue_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,       -- a
  related_issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE, -- b
  type TEXT NOT NULL CHECK (type IN ('blocks','duplicate_of','relates_to')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, issue_id, related_issue_id, type),
  CHECK (issue_id <> related_issue_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_relations_related ON pm_issue_relations(tenant_id, related_issue_id);

CREATE TABLE IF NOT EXISTS pm_issue_subscribers (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_subscribers_user ON pm_issue_subscribers(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS pm_issue_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  parent_comment_id UUID REFERENCES pm_issue_comments(id) ON DELETE CASCADE, -- one level
  body TEXT NOT NULL,                               -- markdown
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED,
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pm_comments_issue ON pm_issue_comments(tenant_id, issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pm_comments_search ON pm_issue_comments USING GIN (search_tsv);

CREATE TABLE IF NOT EXISTS pm_comment_reactions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  comment_id UUID NOT NULL REFERENCES pm_issue_comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, user_id, emoji)
);

-- Permanent field-change ledger (outbox prunes at 90d; history does not).
CREATE TABLE IF NOT EXISTS pm_issue_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pm_history_issue ON pm_issue_history(tenant_id, issue_id, created_at);

-- record_files may now attach to issues/projects (§5.1; pipeline lands later).
DO $rf$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'record_files') THEN
    ALTER TABLE record_files DROP CONSTRAINT IF EXISTS record_files_object_type_check;
    ALTER TABLE record_files ADD CONSTRAINT record_files_object_type_check
      CHECK (object_type IN ('deal','person','company','lead','issue','project'));
  END IF;
END
$rf$;

-- RLS + grants.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_issues','pm_issue_labels','pm_issue_relations','pm_issue_subscribers','pm_issue_comments','pm_comment_reactions','pm_issue_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0042_pm_projects.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0042 — PM projects, milestones, health updates, initiatives
-- (PRD v6 §6, §9.3, §15.2; PRD-numbered 0041). Repo numbering is +1 because
-- 0038 was taken by crm_360_indexes. 0044 (templates/views) already shipped in
-- Sprint 34 — every PM migration is idempotent so numeric apply order on a
-- fresh sync stays correct.

-- §6.1 Projects — one lead, a target date, honest health updates.
CREATE TABLE IF NOT EXISTS pm_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT,                               -- one-line
  description_md TEXT,                        -- markdown doc (lazy-loaded)
  icon TEXT,                                  -- emoji
  color TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('backlog','planned','in_progress','paused','completed','canceled')),
  health TEXT NOT NULL DEFAULT 'on_track'
    CHECK (health IN ('on_track','at_risk','off_track')),  -- denormalized latest (updates are the log)
  lead_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  start_date DATE,
  target_date DATE,
  deal_id UUID,                               -- CRM back-link (§15.2); no FK — module boundary
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pm_projects_tenant ON pm_projects(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pm_projects_deal ON pm_projects(tenant_id, deal_id) WHERE deal_id IS NOT NULL;

-- §6.1 Projects span teams (M2M).
CREATE TABLE IF NOT EXISTS pm_project_teams (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_project_teams_team ON pm_project_teams(tenant_id, team_id);

-- §6.1 Optional roster for pinning/notifications.
CREATE TABLE IF NOT EXISTS pm_project_members (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

-- §6.2 Milestones — issues attach via pm_issues.milestone_id.
CREATE TABLE IF NOT EXISTS pm_project_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_date DATE,
  position SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pm_milestones_project ON pm_project_milestones(tenant_id, project_id);

-- §6.3 Health updates — the log; latest denormalizes onto pm_projects.health.
CREATE TABLE IF NOT EXISTS pm_project_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  health TEXT NOT NULL CHECK (health IN ('on_track','at_risk','off_track')),
  body_md TEXT NOT NULL,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pm_updates_project ON pm_project_updates(tenant_id, project_id, created_at DESC);

-- §6.4 Initiatives (light, v1).
CREATE TABLE IF NOT EXISTS pm_initiatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','paused')),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_quarter TEXT,                        -- 'Q3 2026'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS pm_initiative_projects (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  initiative_id UUID NOT NULL REFERENCES pm_initiatives(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (initiative_id, project_id)
);

-- 0041 reserved pm_issues.project_id/milestone_id without FK targets — add now
-- (idempotent via constraint-name checks; NOT VALID + VALIDATE avoids locks).
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_issues_project_id_fkey') THEN
    ALTER TABLE pm_issues ADD CONSTRAINT pm_issues_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES pm_projects(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE pm_issues VALIDATE CONSTRAINT pm_issues_project_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_issues_milestone_id_fkey') THEN
    ALTER TABLE pm_issues ADD CONSTRAINT pm_issues_milestone_id_fkey
      FOREIGN KEY (milestone_id) REFERENCES pm_project_milestones(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE pm_issues VALIDATE CONSTRAINT pm_issues_milestone_id_fkey;
  END IF;
END
$fk$;

-- record_files already accepts 'project' (0041's CHECK) — nothing to extend.

-- RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_projects','pm_project_teams','pm_project_members','pm_project_milestones','pm_project_updates','pm_initiatives','pm_initiative_projects'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0043_pm_cycles.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0043 — PM cycles, Autopilot, snapshots + triage snooze
-- (PRD v6 §7/§8; PRD-numbered 0042). Idempotent like every PM migration —
-- 0044 shipped first on existing databases; fresh syncs apply in file order.

-- §7.1 Cycles: per-team numbered periods; config lives on pm_teams (0040).
CREATE TABLE IF NOT EXISTS pm_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  cooldown_ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','active','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, number)
);
CREATE INDEX IF NOT EXISTS idx_pm_cycles_team ON pm_cycles(tenant_id, team_id, starts_at);

-- §7.3 Daily snapshots — the stats substrate (velocity/creep/burn).
CREATE TABLE IF NOT EXISTS pm_cycle_snapshots (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cycle_id UUID NOT NULL REFERENCES pm_cycles(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  scope_points NUMERIC(10,2) NOT NULL DEFAULT 0,
  started_points NUMERIC(10,2) NOT NULL DEFAULT 0,
  completed_points NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cycle_id, snapshot_date)
);

-- 0041 reserved pm_issues.cycle_id without an FK target — add now.
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_issues_cycle_id_fkey') THEN
    ALTER TABLE pm_issues ADD CONSTRAINT pm_issues_cycle_id_fkey
      FOREIGN KEY (cycle_id) REFERENCES pm_cycles(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE pm_issues VALIDATE CONSTRAINT pm_issues_cycle_id_fkey;
  END IF;
END
$fk$;

-- §8 Triage snooze (Z · 1d/3d/1w): hides the issue from the conveyor until due.
ALTER TABLE pm_issues ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

-- Appendix B sample pack ledger — every seeded id, so removal never touches
-- anything the team created themselves (same doctrine as CRM sample_packs).
CREATE TABLE IF NOT EXISTS pm_sample_packs (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  record_ids JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_cycles','pm_cycle_snapshots','pm_sample_packs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0044_pm_templates_views.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 0044 — PM templates + views plumbing (PRD v6 §9.4/§14; PRD-numbered
-- 0043). Ships in Sprint 34 (numerically after the projects/cycles migrations
-- that land in Sprints 36–37 — all four are independent and idempotent, so
-- apply order across a fresh sync stays correct).

-- Issue templates (per team; §14). Recurring schedule column reserved (v1.5).
CREATE TABLE IF NOT EXISTS pm_issue_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title_pattern TEXT,
  description_md TEXT,
  default_priority SMALLINT CHECK (default_priority BETWEEN 0 AND 4),
  default_estimate NUMERIC(6,2),
  default_state_id UUID,
  default_label_ids UUID[] NOT NULL DEFAULT '{}',
  is_team_default BOOLEAN NOT NULL DEFAULT FALSE,
  schedule TEXT,                       -- reserved: recurring issues (v1.5)
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, team_id, name)
);

-- Project templates + starter issue sets (§14; instantiated Sprint 40).
CREATE TABLE IF NOT EXISTS pm_project_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description_md TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS pm_project_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES pm_project_templates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description_md TEXT,
  default_priority SMALLINT CHECK (default_priority BETWEEN 0 AND 4),
  relative_due_days INTEGER,           -- due = project start + N days
  position SMALLINT NOT NULL DEFAULT 0
);

-- Saved views open to PM objects (§9.4) — CHECK re-created additively.
DO $sv$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'saved_views') THEN
    ALTER TABLE saved_views DROP CONSTRAINT IF EXISTS saved_views_object_type_check;
    ALTER TABLE saved_views ADD CONSTRAINT saved_views_object_type_check
      CHECK (object_type IN ('deal','person','company','lead','pm_issue','pm_project'));
  END IF;
END
$sv$;

-- Favorites pinned to the sidebar (§9.4).
CREATE TABLE IF NOT EXISTS pm_view_favorites (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  view_id UUID NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, view_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_view_favorites_user ON pm_view_favorites(tenant_id, user_id);

-- Import batches learn the PM object types early (§14 importers, Sprint 40).
DO $ib$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches') THEN
    ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_object_type_check;
    ALTER TABLE import_batches ADD CONSTRAINT import_batches_object_type_check
      CHECK (object_type IN ('people','companies','leads','pm_issues','pm_projects'));
  END IF;
END
$ib$;

-- RLS + grants (house DO-loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_issue_templates','pm_project_templates','pm_project_template_items','pm_view_favorites'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0045_pm_inbox_timesheet.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0045: PM Inbox lifecycle on notifications + timesheet ↔ PM linkage (PRD v6 §11, §15.3)
-- Idempotent: safe to re-run.

-- ─── notifications: inbox lifecycle columns ──────────────────────────────────
-- archived_at: row leaves the inbox but stays queryable under the Archived filter.
-- snoozed_until: row hides from the inbox until due (server filters on read).
-- group_key: collapses repeats of the same subject (e.g. 'pm.issue:<id>') —
-- new activity on the same subject bumps the one row instead of stacking.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_key text;
-- group_count: how many events collapsed into this row ("+N more" in the UI).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_count integer NOT NULL DEFAULT 1;
-- emailed_at: exactly-once marker for the delayed-email sweeps (urgent + digest).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at timestamptz;

-- Per-user email digest cadence for inbox-style notifications (P10 segmented
-- control): 'urgent' = only the 5-min unread-mention/assignment emails,
-- 'hourly'/'daily' = fold everything else on that cadence.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email_digest text NOT NULL DEFAULT 'daily';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_notification_email_digest_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_notification_email_digest_check
      CHECK (notification_email_digest IN ('urgent', 'hourly', 'daily'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notifications_user_group_idx
  ON notifications (user_id, group_key);

-- Partial index for the hot inbox query: unarchived rows per user, newest first.
CREATE INDEX IF NOT EXISTS notifications_inbox_idx
  ON notifications (user_id, created_at DESC)
  WHERE archived_at IS NULL;

-- ─── timesheet_entries: real FKs to the PM tables (§15.3) ────────────────────
-- project_id/task_id predate the PM module as bare uuids. Null out any dangling
-- references first (pre-PM garbage), then attach FKs NOT VALID → VALIDATE so
-- the ALTER never rewrites the table under load.
UPDATE timesheet_entries te SET project_id = NULL
  WHERE te.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pm_projects p WHERE p.id = te.project_id);
UPDATE timesheet_entries te SET task_id = NULL
  WHERE te.task_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pm_issues i WHERE i.id = te.task_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'timesheet_entries_project_id_fkey'
  ) THEN
    ALTER TABLE timesheet_entries
      ADD CONSTRAINT timesheet_entries_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES pm_projects(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'timesheet_entries_task_id_fkey'
  ) THEN
    ALTER TABLE timesheet_entries
      ADD CONSTRAINT timesheet_entries_task_id_fkey
      FOREIGN KEY (task_id) REFERENCES pm_issues(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

ALTER TABLE timesheet_entries VALIDATE CONSTRAINT timesheet_entries_project_id_fkey;
ALTER TABLE timesheet_entries VALIDATE CONSTRAINT timesheet_entries_task_id_fkey;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0046_pm_github.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0046: GitHub App integration (PRD v6 §12, P16) — installations, repo↔team
-- mappings, issue git links, webhook delivery ledger, per-team automations.
-- Idempotent: safe to re-run.

-- ─── pm_github_installations: one App installation per tenant ────────────────
CREATE TABLE IF NOT EXISTS pm_github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  -- Workspace-level branch template (P16 branch format card).
  branch_format TEXT NOT NULL DEFAULT '{user}/{team-key-lower}-{number}-{slug}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
  failed_deliveries INTEGER NOT NULL DEFAULT 0,
  last_delivery_status INTEGER,
  last_delivery_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── pm_github_repos: repo → team mapping (installation-scoped) ──────────────
CREATE TABLE IF NOT EXISTS pm_github_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL,
  repo_id BIGINT,
  repo_full_name TEXT NOT NULL,
  team_id UUID NOT NULL REFERENCES pm_teams(id) ON DELETE CASCADE,
  autolink BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, repo_full_name)
);
CREATE INDEX IF NOT EXISTS idx_pm_github_repos_team ON pm_github_repos(tenant_id, team_id);

-- ─── pm_issue_git_links: branch/PR/commit chips on issues ────────────────────
CREATE TABLE IF NOT EXISTS pm_issue_git_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('branch', 'pr', 'commit')),
  -- ref = stable identity within the kind: branch name, PR number, short sha.
  ref TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'merged', 'closed')),
  url TEXT,
  repo_full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, issue_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_pm_issue_git_links_issue ON pm_issue_git_links(tenant_id, issue_id);

-- ─── github_webhook_events: delivery-id idempotency ledger ───────────────────
-- Stores every inbound delivery (verified or not); processing is gated on
-- signature_verified. payload retained so failed deliveries can be re-run.
CREATE TABLE IF NOT EXISTS github_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  action TEXT,
  installation_id BIGINT,
  tenant_id UUID,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_github_webhook_events_pending
  ON github_webhook_events (received_at)
  WHERE signature_verified AND NOT processed;

-- ─── pm_teams: per-team status automations (P16, on by default) ──────────────
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_auto_branch BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_auto_pr_open BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_auto_pr_merge BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_auto_pr_close BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_magic_words BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pm_teams ADD COLUMN IF NOT EXISTS gh_bot_comment BOOLEAN NOT NULL DEFAULT false;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Tenant-scoped tables: standard FORCE-RLS + flicks_app grants.
DO $rls$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_github_installations', 'pm_github_repos', 'pm_issue_git_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t, t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;

-- Webhook ledger: service-role only (no tenant context on inbound deliveries) —
-- FORCE RLS with no policies and no app grants, like razorpay/resend ledgers.
ALTER TABLE github_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_webhook_events FORCE ROW LEVEL SECURITY;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0047_pm_import.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0047: PM importers (PRD v6 §14) — batch stamping + external-id dedupe.
-- Idempotent: safe to re-run. The import_batches CHECK already knows
-- 'pm_issues'/'pm_projects' (0044).

-- Batch stamp → 24h undo retracts exactly the imported rows (0037 pattern).
ALTER TABLE pm_issues ADD COLUMN IF NOT EXISTS import_batch_id UUID;
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS import_batch_id UUID;
CREATE INDEX IF NOT EXISTS idx_pm_issues_import_batch
  ON pm_issues (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pm_projects_import_batch
  ON pm_projects (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- external_ref = '<source>:<external id>' (e.g. 'linear:ENG-142',
-- 'jira:PROJ-9') — re-running an import is idempotent per tenant.
ALTER TABLE pm_issues ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS external_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_issues_external_ref
  ON pm_issues (tenant_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_projects_external_ref
  ON pm_projects (tenant_id, external_ref) WHERE external_ref IS NOT NULL;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0048_security_hardening.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- 0048 — security hardening pass (pre-beta audit)
--
-- 1. resend_webhook_events was the ONE table in the schema with no RLS at all.
--    Its only protection was "we never granted it", which any blanket
--    GRANT ... ON ALL TABLES silently undoes. Its siblings
--    (razorpay_webhook_events, github_webhook_events) are FORCE + deny-all;
--    bring this one in line so provisioning order stops mattering.
-- 2. Re-assert the service-role-only posture for the webhook ledgers.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'resend_webhook_events') THEN
    EXECUTE 'ALTER TABLE resend_webhook_events ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE resend_webhook_events FORCE ROW LEVEL SECURITY';
    -- Deny-all for the app role; the service role bypasses RLS entirely.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'resend_webhook_events'
        AND policyname = 'service_role_only_resend_webhook_events'
    ) THEN
      EXECUTE 'CREATE POLICY service_role_only_resend_webhook_events ON resend_webhook_events
                 USING (false) WITH CHECK (false)';
    END IF;
  END IF;
END $$;

-- Belt-and-braces: strip any grant a blanket provisioning step handed out.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flicks_app') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'resend_webhook_events') THEN
      EXECUTE 'REVOKE ALL ON resend_webhook_events FROM flicks_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'github_webhook_events') THEN
      EXECUTE 'REVOKE ALL ON github_webhook_events FROM flicks_app';
    END IF;
  END IF;
END $$;

COMMIT; -- migration boundary (mirrors per-file execution; a "no transaction in progress" warning here is harmless)


-- ═════════════════════════════════════════════════════════════════════════════
-- GRANTS — mirrors setup-database.sh step 5 (after all tables exist)
-- ═════════════════════════════════════════════════════════════════════════════
GRANT USAGE ON SCHEMA public TO "flicks_app";
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO "flicks_app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "flicks_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO "flicks_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "flicks_app";

-- ═════════════════════════════════════════════════════════════════════════════
-- RE-LOCK PER-TABLE GRANTS — scripts/sql/relock-grants.sql verbatim
-- ═════════════════════════════════════════════════════════════════════════════
-- Re-assert the per-table lockdowns the migrations establish.
--
-- Every provisioning path ends with a blanket
--   GRANT ... ON ALL TABLES IN SCHEMA public TO flicks_app
-- which silently undoes the append-only ledgers and service-role-only tables
-- the migrations carefully locked down. RLS absorbs most of it, but the
-- grant-only controls (ledger immutability, read-only reference data) are NOT
-- RLS-backed — they are exactly what the isolation suite asserts.
--
-- Run this AFTER the grant, on every path. Idempotent.
-- Kept in ONE file so the three setup scripts can never drift apart again.

DO $$
DECLARE
  r text := 'flicks_app';
  has_table boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    RAISE NOTICE 'role % absent — nothing to re-lock', r;
    RETURN;
  END IF;

  -- (table, revoke clause) pairs — mirrors the migration that locked each one.
  FOR has_table IN SELECT true LOOP EXIT; END LOOP; -- no-op to keep the block tidy

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='consent_records') THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON consent_records FROM %I', r);              -- 0022 append-only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='feedback_submissions') THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON feedback_submissions FROM %I', r);         -- 0026
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='nps_responses') THEN
    EXECUTE format('REVOKE DELETE ON nps_responses FROM %I', r);                        -- 0026
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='subscription_charge_attempts') THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON subscription_charge_attempts FROM %I', r); -- 0027 ledger
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='coupon_codes') THEN
    EXECUTE format('REVOKE ALL ON coupon_codes FROM %I', r);                            -- 0028 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='coupon_redemptions') THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON coupon_redemptions FROM %I', r);   -- 0028 read-only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='domain_events') THEN
    EXECUTE format('REVOKE SELECT, UPDATE, DELETE ON domain_events FROM %I', r);        -- 0030 outbox: INSERT-only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='api_keys') THEN
    EXECUTE format('REVOKE ALL ON api_keys FROM %I', r);                                -- 0030 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='webhook_endpoints') THEN
    EXECUTE format('REVOKE ALL ON webhook_endpoints FROM %I', r);                       -- 0030 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='webhook_deliveries') THEN
    EXECUTE format('REVOKE ALL ON webhook_deliveries FROM %I', r);                      -- 0030 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='fx_rates') THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON fx_rates FROM %I', r);             -- 0032 read-only reference
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='resend_webhook_events') THEN
    EXECUTE format('REVOKE ALL ON resend_webhook_events FROM %I', r);                   -- 0035 service-role only
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='github_webhook_events') THEN
    EXECUTE format('REVOKE ALL ON github_webhook_events FROM %I', r);                   -- 0046 service-role only
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- SEED TENANT — mirrors setup-database.sh step 6
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO tenants (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Seed Tenant', 'seed-tenant', 'trialing')
ON CONFLICT (id) DO NOTHING;

SELECT 'DATABASE SETUP COMPLETE — now run 03-verify-rls.sql' AS result;
