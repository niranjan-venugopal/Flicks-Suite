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
#   • ALTER TYPE membership_role ADD VALUE 'owner' / 'fam'
#   • notifications · impersonation_sessions · account_deletion_requests ·
#     notification_preferences · TOTP/account-security columns (0003–0008, 0020)
#   • PRD v4 (0022–0028): consent_records · avatar/logo key columns · member_status ·
#     product_events · feedback/nps · platform billing + coupons · auto-debit mandates ·
#     member_status · product_events — with their RLS policies + grants
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

-- account_deletion_requests (DPDP right-to-erasure) —
-- matches packages/db/drizzle/0006_account_deletion_requests.sql.
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

-- FAM second factor (TOTP) — matches packages/db/drizzle/0007_totp.sql.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enrolled_at" timestamptz;

-- TOTP brute-force lockout + single-use backup codes —
-- matches packages/db/drizzle/0020_account_security.sql. Inlined so login
-- (auth verify-otp reads these) works on databases that predate Sprint 13 §E.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_failed_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_locked_until" timestamptz;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_backup_codes" jsonb;

-- notification_preferences — matches packages/db/drizzle/0008_notification_preferences.sql.
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

-- ══ PRD v4 deltas (Sprints 16–19) ═══════════════════════════════════════════
-- Inlined WITH their RLS policies + grants, matching the migration files
-- (0022–0025) exactly, so a fresh setup-supabase + setup-demo is whole
-- without a separate sync.

-- consent_records — matches packages/db/drizzle/0022_trust_consent.sql.
CREATE TABLE IF NOT EXISTS consent_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE SET NULL,
  consent_type   text NOT NULL CHECK (consent_type IN ('terms_privacy','analytics','marketing_email')),
  granted        boolean NOT NULL,
  policy_version text NOT NULL,
  source         text NOT NULL CHECK (source IN ('signup','banner','settings','unsubscribe','import')),
  region_code    text,
  ip_hash        text,
  user_agent     text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consents_user_type
  ON consent_records (user_id, consent_type, occurred_at DESC);
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_self_select ON consent_records;
CREATE POLICY consent_self_select ON consent_records FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
DROP POLICY IF EXISTS consent_self_insert ON consent_records;
CREATE POLICY consent_self_insert ON consent_records FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT ON consent_records TO flicks_app;
REVOKE UPDATE, DELETE ON consent_records FROM flicks_app;

-- media keys — matches packages/db/drizzle/0023_profile_media.sql.
ALTER TABLE users   ADD COLUMN IF NOT EXISTS avatar_key text;
ALTER TABLE users   ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_key text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_updated_at timestamptz;

-- member_status — matches packages/db/drizzle/0024_presence_status.sql.
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

-- product_events — matches packages/db/drizzle/0025_product_events.sql.
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

-- feedback_submissions + nps_responses — matches packages/db/drizzle/0026_feedback_nps.sql.
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

-- platform billing + coupons — matches packages/db/drizzle/0028_platform_billing_coupons.sql.
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

-- auto-debit mandates + charge ledger — matches packages/db/drizzle/0027_razorpay_autodebit.sql.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS razorpay_customer_id text;
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS collection_mode text NOT NULL DEFAULT 'manual';
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_status text NOT NULL DEFAULT 'none';
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_short_url text;
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_token text;
ALTER TABLE invoice_subscriptions ADD COLUMN IF NOT EXISTS mandate_token_expires_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_subscriptions_mandate_token
  ON invoice_subscriptions (mandate_token) WHERE mandate_token IS NOT NULL;
CREATE TABLE IF NOT EXISTS subscription_charge_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES invoice_subscriptions(id) ON DELETE CASCADE,
  invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,
  razorpay_payment_id text,
  status          text NOT NULL CHECK (status IN ('created','captured','failed')),
  attempt_no      smallint,
  amount          numeric(15,2) NOT NULL,
  currency        text NOT NULL,
  failure_reason  text,
  failure_code    text,
  attempted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_charge_attempts_subscription
  ON subscription_charge_attempts (subscription_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_charge_attempts_tenant
  ON subscription_charge_attempts (tenant_id, attempted_at DESC);
ALTER TABLE subscription_charge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charge_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscription_charge_attempts ON subscription_charge_attempts;
CREATE POLICY tenant_isolation_subscription_charge_attempts ON subscription_charge_attempts
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON subscription_charge_attempts TO flicks_app;
REVOKE UPDATE, DELETE ON subscription_charge_attempts FROM flicks_app;

-- auto-debit enum alignment — matches packages/db/drizzle/0029_autodebit_enum_alignment.sql.
-- Reconciles pre-existing demo DBs (created with the older value set) and pins
-- both enums; no-ops on a fresh DB created by the CREATE TABLE above.
UPDATE invoice_subscriptions SET mandate_status = 'authenticated' WHERE mandate_status = 'authorized';
ALTER TABLE invoice_subscriptions DROP CONSTRAINT IF EXISTS invoice_subscriptions_mandate_status_check;
ALTER TABLE invoice_subscriptions ADD  CONSTRAINT invoice_subscriptions_mandate_status_check
  CHECK (mandate_status IN ('none','pending_authorization','authenticated','active','paused','halted','revoked','failed'));
ALTER TABLE invoice_subscriptions DROP CONSTRAINT IF EXISTS invoice_subscriptions_collection_mode_check;
ALTER TABLE invoice_subscriptions ADD  CONSTRAINT invoice_subscriptions_collection_mode_check
  CHECK (collection_mode IN ('manual','auto_debit'));
ALTER TABLE subscription_charge_attempts ADD COLUMN IF NOT EXISTS attempt_no   smallint;
ALTER TABLE subscription_charge_attempts ADD COLUMN IF NOT EXISTS failure_code text;
UPDATE subscription_charge_attempts SET status = 'captured' WHERE status = 'succeeded';
UPDATE subscription_charge_attempts SET status = 'created'  WHERE status = 'pending';
ALTER TABLE subscription_charge_attempts DROP CONSTRAINT IF EXISTS subscription_charge_attempts_status_check;
ALTER TABLE subscription_charge_attempts ADD  CONSTRAINT subscription_charge_attempts_status_check
  CHECK (status IN ('created','captured','failed'));

-- platform evolution: domain-event outbox + API keys + webhooks —
-- matches packages/db/drizzle/0030_platform_evolution.sql (PRD v5 §2/§11).
CREATE TABLE IF NOT EXISTS domain_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid REFERENCES tenants(id) ON DELETE CASCADE,
  event_name        text NOT NULL,
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
DROP POLICY IF EXISTS domain_events_tenant_insert ON domain_events;
CREATE POLICY domain_events_tenant_insert ON domain_events
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT INSERT ON domain_events TO flicks_app;
REVOKE SELECT, UPDATE, DELETE ON domain_events FROM flicks_app;

CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
REVOKE ALL ON api_keys FROM flicks_app;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url                  text NOT NULL,
  secret_encrypted     text NOT NULL,
  events               text[] NOT NULL DEFAULT '{}',
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
REVOKE ALL ON webhook_endpoints FROM flicks_app;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id         uuid,
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_delivery_endpoint_event
  ON webhook_deliveries (endpoint_id, event_id);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON webhook_deliveries FROM flicks_app;

-- CRM directory kernel — matches packages/db/drizzle/0031_directory_kernel.sql.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TABLE IF NOT EXISTS directory_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, domain citext, website text, industry text, size_band text, phone text,
  address_line1 text, address_line2 text, city text, state text, postal_code text, country_code char(2),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL, source text, last_activity_at timestamptz,
  custom jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dir_company_domain ON directory_companies (tenant_id, domain)
  WHERE domain IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dir_company_name ON directory_companies USING gin (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS idx_dir_company_name_trgm ON directory_companies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dir_company_tenant ON directory_companies (tenant_id) WHERE deleted_at IS NULL;
ALTER TABLE directory_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_directory_companies ON directory_companies;
CREATE POLICY tenant_isolation_directory_companies ON directory_companies FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON directory_companies TO flicks_app;
CREATE TABLE IF NOT EXISTS directory_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name text, last_name text,
  display_name text GENERATED ALWAYS AS
    (COALESCE(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),''), first_name, last_name)) STORED,
  email citext, secondary_emails citext[], phone text, secondary_phones text[], title text,
  company_id uuid REFERENCES directory_companies(id) ON DELETE SET NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL, source text, last_activity_at timestamptz,
  custom jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dir_people_email ON directory_people (tenant_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dir_people_company ON directory_people (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_dir_people_name ON directory_people
  USING gin (to_tsvector('simple', coalesce(first_name,'')||' '||coalesce(last_name,'')));
CREATE INDEX IF NOT EXISTS idx_dir_people_name_trgm ON directory_people
  USING gin ((coalesce(first_name,'')||' '||coalesce(last_name,'')) gin_trgm_ops);
ALTER TABLE directory_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_people FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_directory_people ON directory_people;
CREATE POLICY tenant_isolation_directory_people ON directory_people FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON directory_people TO flicks_app;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS directory_company_id uuid REFERENCES directory_companies(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS directory_person_id  uuid REFERENCES directory_people(id);

-- CRM core: pipelines, deals, tags, FX — matches 0032_crm_core.sql (PRD v5 §4).
CREATE TABLE IF NOT EXISTS fx_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base char(3) NOT NULL DEFAULT 'USD', quote char(3) NOT NULL,
  rate numeric(18,8) NOT NULL, as_of date NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_rate_day ON fx_rates (base, quote, as_of);
CREATE INDEX IF NOT EXISTS idx_fx_rate_latest ON fx_rates (quote, as_of DESC);
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_rates_read ON fx_rates;
CREATE POLICY fx_rates_read ON fx_rates FOR SELECT USING (true);
GRANT SELECT ON fx_rates TO flicks_app;
REVOKE INSERT, UPDATE, DELETE ON fx_rates FROM flicks_app;
CREATE TABLE IF NOT EXISTS pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, display_order smallint NOT NULL DEFAULT 0, is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pipelines_tenant ON pipelines (tenant_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name text NOT NULL, display_order smallint NOT NULL,
  win_probability smallint NOT NULL DEFAULT 0 CHECK (win_probability BETWEEN 0 AND 100),
  rotting_days smallint, stage_type text NOT NULL DEFAULT 'open' CHECK (stage_type IN ('open','won','lost')),
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON pipeline_stages (tenant_id, pipeline_id, display_order);
CREATE TABLE IF NOT EXISTS deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id), stage_id uuid NOT NULL REFERENCES pipeline_stages(id),
  title text NOT NULL, company_id uuid REFERENCES directory_companies(id),
  primary_person_id uuid REFERENCES directory_people(id), owner_user_id uuid NOT NULL REFERENCES users(id),
  value_amount numeric(15,2) NOT NULL DEFAULT 0, currency char(3) NOT NULL,
  fx_rate_to_base numeric(15,6) NOT NULL DEFAULT 1, value_base_amount numeric(15,2) NOT NULL DEFAULT 0,
  expected_close_date date, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  won_at timestamptz, lost_at timestamptz, lost_reason_id uuid, lost_reason_note text, source text, score int,
  stage_entered_at timestamptz NOT NULL DEFAULT now(), next_activity_at timestamptz, last_activity_at timestamptz,
  invoice_id uuid, custom jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL, deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_deals_board ON deals (tenant_id, pipeline_id, stage_id) WHERE deleted_at IS NULL AND status='open';
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals (tenant_id, owner_user_id, status);
CREATE TABLE IF NOT EXISTS deal_people (
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, role text, PRIMARY KEY (deal_id, person_id)
);
CREATE TABLE IF NOT EXISTS deal_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE, from_stage_id uuid, to_stage_id uuid NOT NULL,
  changed_by uuid REFERENCES users(id), changed_at timestamptz NOT NULL DEFAULT now(), seconds_in_previous_stage bigint
);
CREATE INDEX IF NOT EXISTS idx_stage_history_deal ON deal_stage_history (tenant_id, deal_id, changed_at);
CREATE TABLE IF NOT EXISTS lost_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label text NOT NULL, display_order smallint DEFAULT 0, archived boolean DEFAULT false
);
CREATE TABLE IF NOT EXISTS deal_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE, item_id uuid REFERENCES items(id),
  name text NOT NULL, quantity numeric(15,4) NOT NULL DEFAULT 1, unit_price numeric(15,2) NOT NULL,
  currency char(3) NOT NULL, discount_pct numeric(5,2) DEFAULT 0, line_total numeric(15,2) NOT NULL, display_order smallint DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deal_products_deal ON deal_products (tenant_id, deal_id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES deals(id);
-- Deal→invoice idempotency guards (review M5): one customer per directory link,
-- one invoice per deal — repeated deal→invoice calls can never fan out dupes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_directory_company ON customers (tenant_id, directory_company_id) WHERE directory_company_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_directory_person ON customers (tenant_id, directory_person_id) WHERE directory_person_id IS NOT NULL AND deleted_at IS NULL;
DROP INDEX IF EXISTS uq_invoices_deal; -- 0032-era 2-col index; superseded by _doc (see 0033)
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_deal_doc ON invoices (tenant_id, deal_id, document_type) WHERE deal_id IS NOT NULL;
-- 0033: deal→quote support (per-pipeline on-accept move, deal↔quote back-link, accept audit).
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS quote_accepted_stage_id uuid;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS quote_id uuid;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quote_accepted_at timestamptz;
CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label text NOT NULL, color text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_label ON tags (tenant_id, lower(label));
CREATE TABLE IF NOT EXISTS record_tags (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  object_type text NOT NULL CHECK (object_type IN ('person','company','deal','lead')), object_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, tag_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS idx_record_tags_object ON record_tags (tenant_id, object_type, object_id);
-- 0033: custom fields, saved views, record files (§9.1-9.2, §19.2).
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type text NOT NULL CHECK (object_type IN ('deal','person','company','lead')), key text NOT NULL, label text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('text','number','date','select','multiselect','checkbox','url')),
  options jsonb NOT NULL DEFAULT '[]', is_required boolean NOT NULL DEFAULT false, display_order smallint NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_key ON custom_field_defs (tenant_id, object_type, key) WHERE archived = false;
CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type text NOT NULL CHECK (object_type IN ('deal','person','company','lead')), name text NOT NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL, is_shared boolean NOT NULL DEFAULT false,
  filters jsonb NOT NULL DEFAULT '{}', sort jsonb NOT NULL DEFAULT '{}', columns jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_views_scope ON saved_views (tenant_id, object_type);
CREATE TABLE IF NOT EXISTS record_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type text NOT NULL CHECK (object_type IN ('deal','person','company','lead')), object_id uuid NOT NULL,
  file_name text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL, storage_key text NOT NULL,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_record_files_object ON record_files (tenant_id, object_type, object_id) WHERE deleted_at IS NULL;
-- 0034: activities + mentions (§6).
CREATE TABLE IF NOT EXISTS activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('task','call','meeting','note')), subject text NOT NULL, body text,
  deal_id uuid REFERENCES deals(id) ON DELETE CASCADE, person_id uuid REFERENCES directory_people(id) ON DELETE SET NULL,
  company_id uuid REFERENCES directory_companies(id) ON DELETE SET NULL, assignee_user_id uuid NOT NULL REFERENCES users(id),
  due_at timestamptz, completed_at timestamptz, completed_by uuid REFERENCES users(id), outcome text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL, deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_activities_assignee_due ON activities (tenant_id, assignee_user_id, due_at) WHERE completed_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activities_deal ON activities (tenant_id, deal_id, due_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS activity_mentions (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, mentioned_user_id)
);
-- 0035: Email Phase A (§7.1, §19.4/5).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_signature_html text;
ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS email_do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS email_do_not_contact_reason text;
CREATE TABLE IF NOT EXISTS email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, subject text NOT NULL, body_html text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), archived boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_template_name ON email_templates (tenant_id, lower(name)) WHERE archived = false;
CREATE TABLE IF NOT EXISTS email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('out','in')), status text NOT NULL DEFAULT 'sent', provider_id text,
  from_email text, to_email text NOT NULL, subject text NOT NULL, body_html text,
  person_id uuid REFERENCES directory_people(id) ON DELETE SET NULL, deal_id uuid REFERENCES deals(id) ON DELETE SET NULL,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL, open_token text UNIQUE,
  open_count integer NOT NULL DEFAULT 0, click_count integer NOT NULL DEFAULT 0, tracking boolean NOT NULL DEFAULT false,
  sequence_enrollment_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_messages_deal ON email_messages (tenant_id, deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_person ON email_messages (tenant_id, person_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_provider ON email_messages (provider_id);
CREATE TABLE IF NOT EXISTS email_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE, token text NOT NULL UNIQUE,
  url text NOT NULL, click_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_links_message ON email_links (tenant_id, message_id);
CREATE TABLE IF NOT EXISTS email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE, type text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_message ON email_events (tenant_id, message_id, occurred_at);
CREATE TABLE IF NOT EXISTS sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, is_active boolean NOT NULL DEFAULT true, send_window_start text NOT NULL DEFAULT '09:00',
  send_window_end text NOT NULL DEFAULT '18:00', timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sequence_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE, step_order smallint NOT NULL,
  wait_days smallint NOT NULL DEFAULT 0, subject text NOT NULL, body_html text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sequence_steps ON sequence_steps (tenant_id, sequence_id, step_order);
CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE, person_id uuid NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
  deal_id uuid REFERENCES deals(id) ON DELETE SET NULL, enrolled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  current_step smallint NOT NULL DEFAULT 0, next_send_at timestamptz, status text NOT NULL DEFAULT 'active',
  exit_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_enrollment ON sequence_enrollments (sequence_id, person_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due ON sequence_enrollments (tenant_id, next_send_at) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS tenant_inbound_addresses (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, token text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS connected_email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider text NOT NULL CHECK (provider IN ('google','microsoft')),
  email text NOT NULL, access_token_enc text, refresh_token_enc text, status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connected_account ON connected_email_accounts (tenant_id, user_id, provider);
CREATE TABLE IF NOT EXISTS resend_webhook_events (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE connected_email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_email_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS self_connected_email_accounts ON connected_email_accounts;
CREATE POLICY self_connected_email_accounts ON connected_email_accounts
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid AND user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid AND user_id = current_setting('app.user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON connected_email_accounts TO flicks_app;
DO $crmrls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pipelines','pipeline_stages','deals','deal_people','deal_stage_history','lost_reasons','deal_products','tags','record_tags','custom_field_defs','saved_views','record_files','activities','activity_mentions','email_templates','email_messages','email_links','email_events','sequences','sequence_steps','sequence_enrollments','tenant_inbound_addresses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$crmrls$;
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

# ─── Invoicing: one ready-to-open invoice ────────────────────────────────────
# setup-demo.sh is HRMS-focused; without this the Invoices screen is empty and
# the "PDF" download button has no target. Seeds a customer + a SENT invoice
# (2 line items, inter-state IGST @ 18%) into Demo Co. Idempotent: fixed UUIDs,
# ON CONFLICT, and a delete-then-insert for line items (no natural unique key).
# Mirrors packages/db/src/seed-demo-invoice.ts (same UUIDs → the two are safe to
# run in any combination).
psql "${CONN_TARGET[@]}" -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL' >/dev/null
INSERT INTO customers (
  id, tenant_id, customer_code, display_name, legal_name, email,
  country_code, state_code, is_gst_registered, gstin, default_currency, status,
  billing_address_line1, billing_city, billing_state, billing_postal_code, billing_country
) VALUES (
  'de300000-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'DEMO-CUST-01', 'Acme Test Pvt Ltd', 'Acme Test Private Limited', 'ap@acme.test',
  'IN', '29', true, '29ABCDE1234F1Z5', 'INR', 'active',
  '4th Floor, Tech Park, Outer Ring Road', 'Bengaluru', 'Karnataka', '560103', 'India'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO invoices (
  id, tenant_id, customer_id, invoice_number, document_type, status,
  invoice_date, due_date, fy_label, currency,
  subtotal, taxable_amount, igst_amount, total_amount, net_receivable, amount_outstanding,
  place_of_supply, tax_treatment, notes, created_by
) VALUES (
  'de100000-0000-4000-8000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'de300000-0000-4000-8000-000000000001',
  'INV-DEMO-0001', 'INVOICE', 'SENT',
  current_date - 5, current_date + 10, '2026-27', 'INR',
  15000, 15000, 2700, 17700, 17700, 17700,
  '27', 'inter_state', 'Demo invoice seeded for PDF-download testing.',
  '22222222-2222-2222-2222-222222222220'  -- niranjan@demo.co (Owner)
)
ON CONFLICT (id) DO NOTHING;

DELETE FROM invoice_line_items WHERE invoice_id = 'de100000-0000-4000-8000-000000000001';
INSERT INTO invoice_line_items (
  tenant_id, invoice_id, line_number, item_name, description, hsn_sac_code,
  quantity, unit, rate, gst_rate, line_amount, taxable_amount, igst_amount, line_total
) VALUES
  ('11111111-1111-1111-1111-111111111111', 'de100000-0000-4000-8000-000000000001',
   1, 'Consulting — platform build', 'Senior engineering retainer', '998314',
   10, 'hrs', 1000, 18, 10000, 10000, 1800, 11800),
  ('11111111-1111-1111-1111-111111111111', 'de100000-0000-4000-8000-000000000001',
   2, 'Design system', 'Component library + design tokens', '998314',
   2, 'pkg', 2500, 18, 5000, 5000, 900, 5900);

-- Payment rails so the PDF's UPI QR + bank-transfer block render for the demo.
INSERT INTO invoicing_settings (tenant_id, default_currency, upi_id, upi_display_name, show_upi_qr_on_pdf)
VALUES ('11111111-1111-1111-1111-111111111111', 'INR', 'demoinc@hdfcbank', 'Demo INC', true)
ON CONFLICT (tenant_id) DO UPDATE
  SET upi_id = EXCLUDED.upi_id, upi_display_name = EXCLUDED.upi_display_name, show_upi_qr_on_pdf = true;

INSERT INTO tenant_bank_accounts (
  id, tenant_id, beneficiary_name, account_number, account_type, bank_name, branch, ifsc, is_default, is_active
) VALUES (
  'de4ba00c-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
  'Demo INC', '50200116982393', 'current', 'HDFC Bank', 'Chennai', 'HDFC0001234', true, true
)
ON CONFLICT (id) DO NOTHING;

UPDATE invoices SET bank_account_id = 'de4ba00c-0000-4000-8000-000000000001'
  WHERE id = 'de100000-0000-4000-8000-000000000001';

-- ═══ PRD v4 seeds (Sprints 16–19) ════════════════════════════════════════════

-- Consent ledger: every demo persona accepted ToS/Privacy "at signup" so the
-- re-acceptance interstitial doesn't block demo logins; niranjan also granted
-- analytics (so module_opened capture works out of the box). The ledger is
-- append-only with no natural unique key → WHERE NOT EXISTS keeps re-runs
-- from stacking duplicate rows.
INSERT INTO consent_records (user_id, tenant_id, consent_type, granted, policy_version, source, region_code)
SELECT u.id, '11111111-1111-1111-1111-111111111111', c.type, c.granted, c.version, 'import', 'IN'
FROM users u
CROSS JOIN (VALUES
  ('terms_privacy',   true,  'tos-2026-07-01'),
  ('marketing_email', false, 'consent-v1')
) AS c(type, granted, version)
WHERE u.email IN ('fam@flickssuite.com','niranjan@demo.co','manager@demo.co','sarah@demo.co',
                  'alice@demo.co','rohan@demo.co','diya@demo.co','kabir@demo.co',
                  'vikram@demo.co','ananya@demo.co','priya@demo.co','tanvi@demo.co')
  AND NOT EXISTS (
    SELECT 1 FROM consent_records cr
    WHERE cr.user_id = u.id AND cr.consent_type = c.type
  );

INSERT INTO consent_records (user_id, tenant_id, consent_type, granted, policy_version, source, region_code)
SELECT u.id, '11111111-1111-1111-1111-111111111111', 'analytics', true, 'consent-v1', 'import', 'IN'
FROM users u
WHERE u.email = 'niranjan@demo.co'
  AND NOT EXISTS (
    SELECT 1 FROM consent_records cr
    WHERE cr.user_id = u.id AND cr.consent_type = 'analytics'
  );

-- Presence: two manual statuses so team surfaces show live dots immediately
-- (Mira busy with a message, Sarah DND). Everyone else resolves automatically.
INSERT INTO member_status (tenant_id, user_id, manual_status, status_message)
SELECT '11111111-1111-1111-1111-111111111111', u.id, s.status, s.msg
FROM (VALUES
  ('manager@demo.co', 'busy', 'Sprint planning till 3'),
  ('sarah@demo.co',   'dnd',  'Heads-down · quarter close')
) AS s(email, status, msg)
JOIN users u ON u.email = s.email
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- Product events: a small funnel history for Demo Co so the FAM "Invoicing
-- activation" block + feature usage have data on day one. Fixed UUIDs keep
-- re-runs idempotent.
INSERT INTO product_events (id, tenant_id, user_id, event_name, properties, source, occurred_at)
SELECT v.id::uuid, '11111111-1111-1111-1111-111111111111',
       (SELECT id FROM users WHERE email = 'niranjan@demo.co'),
       v.event, v.props::jsonb, v.src, now() - (v.days_ago || ' days')::interval
FROM (VALUES
  ('4e000000-0000-4000-8000-000000000001', 'signed_up',        '{}',                                  'api', '14'),
  ('4e000000-0000-4000-8000-000000000002', 'org_configured',   '{}',                                  'api', '13'),
  ('4e000000-0000-4000-8000-000000000003', 'member_invited',   '{}',                                  'api', '12'),
  ('4e000000-0000-4000-8000-000000000004', 'first_login_day',  '{}',                                  'api', '12'),
  ('4e000000-0000-4000-8000-000000000005', 'first_login_day',  '{}',                                  'api', '8'),
  ('4e000000-0000-4000-8000-000000000006', 'first_login_day',  '{}',                                  'api', '3'),
  ('4e000000-0000-4000-8000-000000000007', 'invoice_created',  '{"first": true}',                     'api', '6'),
  ('4e000000-0000-4000-8000-000000000008', 'invoice_sent',     '{"first": true}',                     'api', '6'),
  ('4e000000-0000-4000-8000-000000000009', 'payment_received', '{"first": true, "method": "CASH"}',   'api', '4'),
  ('4e000000-0000-4000-8000-00000000000a', 'module_opened',    '{"module": "invoicing"}',             'web', '2'),
  ('4e000000-0000-4000-8000-00000000000b', 'module_opened',    '{"module": "attendance"}',            'web', '1')
) AS v(id, event, props, src, days_ago)
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
echo "  • 1 invoice INV-DEMO-0001 (SENT, ₹17,700) for customer 'Acme Test Pvt Ltd'"
echo "      → Invoicing → Invoices → click 'PDF' to test the download"

psql "${CONN_TARGET[@]}" -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL' >/dev/null
-- Demo coupon so Billing & plan coupon redemption is testable end-to-end.
INSERT INTO coupon_codes (code, campaign, months, max_redemptions, expires_at, active)
VALUES ('FLICKS-DEMO-TEST1', 'demo', 2, 100, now() + interval '365 days', true)
ON CONFLICT (code) DO NOTHING;

-- CRM: seed the default "Sales" pipeline + stages + lost reasons for every
-- demo tenant that lacks one (mirrors 0032_crm_core.sql; runs after tenants
-- exist so the kanban board has a pipeline to render).
DO $crmseed$
DECLARE tn RECORD; v_pipeline uuid;
BEGIN
  FOR tn IN SELECT id FROM tenants LOOP
    IF EXISTS (SELECT 1 FROM pipelines WHERE tenant_id = tn.id AND deleted_at IS NULL) THEN CONTINUE; END IF;
    INSERT INTO pipelines (tenant_id, name, is_default, display_order) VALUES (tn.id, 'Sales', true, 0) RETURNING id INTO v_pipeline;
    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, display_order, win_probability, rotting_days, stage_type) VALUES
      (tn.id, v_pipeline, 'Qualified',0,10,NULL,'open'),(tn.id, v_pipeline, 'Contact Made',1,25,NULL,'open'),
      (tn.id, v_pipeline, 'Demo Scheduled',2,40,7,'open'),(tn.id, v_pipeline, 'Proposal Sent',3,60,10,'open'),
      (tn.id, v_pipeline, 'Negotiation',4,80,10,'open'),(tn.id, v_pipeline, 'Won',5,100,NULL,'won'),(tn.id, v_pipeline, 'Lost',6,0,NULL,'lost');
    INSERT INTO lost_reasons (tenant_id, label, display_order) VALUES
      (tn.id,'Price',0),(tn.id,'Competitor',1),(tn.id,'No budget',2),(tn.id,'No response',3),(tn.id,'Bad timing',4),(tn.id,'Not a fit',5);
  END LOOP;
END
$crmseed$;
INSERT INTO tenant_module_toggles (tenant_id, module, enabled) SELECT id, 'crm', true FROM tenants ON CONFLICT (tenant_id, module) DO NOTHING;
SQL

echo "  • PRD v4: ToS consent ledgered for all personas (no interstitial on demo logins),"
echo "    analytics consent for niranjan, 2 live presence statuses (Mira busy, Sarah DND),"
echo "    and a seeded product_events funnel → FAM 'Invoicing activation' has data"
