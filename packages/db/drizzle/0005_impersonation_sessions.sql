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
