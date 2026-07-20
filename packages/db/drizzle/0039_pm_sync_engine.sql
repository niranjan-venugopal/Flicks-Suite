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
