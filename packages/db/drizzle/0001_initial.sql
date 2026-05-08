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
