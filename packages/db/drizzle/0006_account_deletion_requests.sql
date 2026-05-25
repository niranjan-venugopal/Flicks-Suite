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
