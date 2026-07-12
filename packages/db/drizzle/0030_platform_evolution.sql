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

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
-- Service-layer only (delivery-log UI is served through the service role).
REVOKE ALL ON webhook_deliveries FROM flicks_app;
