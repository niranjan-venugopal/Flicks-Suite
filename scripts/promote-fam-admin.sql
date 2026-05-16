-- Promote niranjan@demo.co to super_admin in the Demo workspace so you can
-- log in and exercise the new /fam/* shell (Sprint 3 C1).
--
-- This is reversible — running scripts/setup-demo.sh again resets all
-- demo roles back to their seeded values.
--
-- Apply via Supabase SQL editor or:
--   psql "$DATABASE_DIRECT_URL" -f scripts/promote-fam-admin.sql

BEGIN;

UPDATE memberships
SET    role       = 'super_admin',
       updated_at = now()
WHERE  user_id = (SELECT id FROM users WHERE email = 'niranjan@demo.co');

COMMIT;

-- Spot-check:
--   select u.email, m.role from memberships m
--   join users u on u.id = m.user_id
--   where u.email = 'niranjan@demo.co';
