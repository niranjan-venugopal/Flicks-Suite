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
