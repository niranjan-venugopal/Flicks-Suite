-- =============================================================================
-- STEP 1 of the dashboard-only deploy — generate production secrets.
-- Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- Copy each value from the result grid STRAIGHT into your password manager
-- under the name shown, then CLOSE this query tab (do not save it).
-- Every run generates fresh values; run it once and keep that set.
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SELECT 'JWT_SECRET'                AS name, encode(gen_random_bytes(48), 'base64') AS value
UNION ALL
SELECT 'INVOICING_SECRET_ENC_KEY', encode(gen_random_bytes(32), 'hex')
UNION ALL
SELECT 'WEBHOOK_SECRET_ENC_KEY',   encode(gen_random_bytes(32), 'hex')
UNION ALL
SELECT 'EMAIL_TOKEN_KEY',          encode(gen_random_bytes(32), 'hex')
UNION ALL
SELECT 'TOTP_SECRET',              encode(gen_random_bytes(32), 'hex')
UNION ALL
SELECT 'APP_ROLE_PASSWORD',        encode(gen_random_bytes(24), 'hex');
