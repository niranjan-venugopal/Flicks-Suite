-- Promote niranjan@demo.co to the FAM platform admin role so you can
-- log in and exercise /fam/* (Sprint 3 C1). Requires 0004_role_fam.sql
-- to have been applied first (adds 'fam' to the membership_role enum).
--
-- Reversible — re-running setup-demo.sh resets all demo roles to seeded
-- values.
--
-- Apply via the Supabase SQL editor or:
--   psql "$DATABASE_DIRECT_URL" -f scripts/promote-fam-admin.sql

BEGIN;

UPDATE memberships
SET    role = 'fam'
WHERE  user_id = (SELECT id FROM users WHERE email = 'niranjan@demo.co');

COMMIT;

-- Spot-check:
--   select u.email, m.role from memberships m
--   join users u on u.id = m.user_id
--   where u.email = 'niranjan@demo.co';
