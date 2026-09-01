-- Round F — the cross-tenant CRM leak, closed at the database layer.
--
-- What happened: RLS only binds a connection whose role is subject to it.
-- Supabase's DEFAULT connection string connects as `postgres`, which carries
-- BYPASSRLS — point the API's DATABASE_URL at it and every tenant_isolation
-- policy silently stops applying, so queries that lean on RLS (the CRM lists
-- did) return every tenant's rows. One customer's imported leads showing up
-- in every workspace is exactly that failure.
--
-- The code fix (same commit) makes withTenant assume the RLS-bound app role
-- inside every tenant transaction via set_config('role','flicks_app',true).
-- For that to WORK on a mis-configured pool, the admin user running this
-- migration (postgres on Supabase) must be a member of flicks_app — which is
-- what this grants. Net effect by configuration:
--   DATABASE_URL = flicks_app  → no-op (a role can always set itself)
--   DATABASE_URL = postgres    → transactions drop to flicks_app: SAFE
--   role can't be assumed      → tenant transactions FAIL CLOSED, never leak
--
-- Idempotent; skips when flicks_app is missing, when running AS flicks_app,
-- or when the membership already exists.

DO $selfheal$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flicks_app')
     AND current_user <> 'flicks_app'
     AND NOT EXISTS (
       SELECT 1
       FROM pg_auth_members m
       JOIN pg_roles grp ON grp.oid = m.roleid
       JOIN pg_roles mem ON mem.oid = m.member
       WHERE grp.rolname = 'flicks_app' AND mem.rolname = current_user
     ) THEN
    EXECUTE format('GRANT flicks_app TO %I', current_user);
  END IF;
END
$selfheal$;
