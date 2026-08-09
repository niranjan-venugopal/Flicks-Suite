-- =============================================================================
-- FIRST-BOOT step (runbook Phase 5) — promote the founder to platform admin.
-- Paste into: Supabase Dashboard -> SQL Editor -> New query.
--
-- BEFORE CLICKING RUN:
--   1. The founder must ALREADY have signed up in the app (the script fails
--      loudly otherwise — that is intentional).
--   2. Find & replace ALL occurrences of
--         REPLACE_WITH_YOUR_EMAIL
--      with the founder's sign-in email address.
--
-- SQL-editor equivalent of scripts/promote-platform-admin.sh. Safe to re-run.
-- =============================================================================
DO $guard$
BEGIN
  IF 'REPLACE_WITH_YOUR_EMAIL' = 'REPLACE_WITH' || '_YOUR_EMAIL' THEN
    RAISE EXCEPTION 'STOP: replace REPLACE_WITH_YOUR_EMAIL with the founder''s email first, then Run again.';
  END IF;
END
$guard$;

-- (No explicit BEGIN/COMMIT: the SQL editor runs this whole file as one
-- implicit transaction — on any error everything rolls back automatically.)

INSERT INTO tenants (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Specflicks', 'specflicks', 'active')
ON CONFLICT (id) DO NOTHING;

DO $promote$
DECLARE
  promoted int;
BEGIN
  UPDATE users SET is_platform_admin = true, updated_at = now()
   WHERE lower(email) = lower('REPLACE_WITH_YOUR_EMAIL');
  GET DIAGNOSTICS promoted = ROW_COUNT;
  IF promoted = 0 THEN
    RAISE EXCEPTION 'No user found for REPLACE_WITH_YOUR_EMAIL — sign up in the app first, then re-run.';
  END IF;
END
$promote$;

INSERT INTO memberships (tenant_id, user_id, role, status, accepted_at)
SELECT '00000000-0000-0000-0000-000000000001', u.id, 'fam', 'active', now()
  FROM users u
 WHERE lower(u.email) = lower('REPLACE_WITH_YOUR_EMAIL')
ON CONFLICT (tenant_id, user_id)
DO UPDATE SET role = 'fam', status = 'active',
              accepted_at = coalesce(memberships.accepted_at, now());

SELECT u.email, u.is_platform_admin, m.role AS fam_role, m.status AS fam_status,
       (u.totp_secret IS NOT NULL) AS totp_enrolled
  FROM users u
  LEFT JOIN memberships m ON m.user_id = u.id
   AND m.tenant_id = '00000000-0000-0000-0000-000000000001'
 WHERE lower(u.email) = lower('REPLACE_WITH_YOUR_EMAIL');
