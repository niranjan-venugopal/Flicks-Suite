-- Rename the Specflicks-internal platform admin role from 'super_admin'
-- to 'fam' (the surface it administers is the FAM console). Postgres
-- doesn't support DROP VALUE on enums without rewriting the dependent
-- column, so 'super_admin' stays in the enum as deprecated; nothing in
-- the codebase references it anymore. Any existing memberships still
-- carrying the legacy value are migrated to 'fam' here.

BEGIN;

ALTER TYPE "membership_role" ADD VALUE IF NOT EXISTS 'fam';

COMMIT;

-- Postgres requires a separate transaction after ADD VALUE before the
-- new label can be used in a DML statement.
BEGIN;

UPDATE memberships
SET    role = 'fam'
WHERE  role = 'super_admin';

COMMIT;
