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
