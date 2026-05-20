-- DEPRECATED: setup-demo.sh now seeds fam@flickssuite.com as the FAM
-- platform admin out of the box. You don't need this script anymore.
--
-- If you want the FAM persona, just run:
--   bash scripts/setup-demo.sh
-- and sign in as fam@flickssuite.com (OTP prints to the API server log).
--
-- This file is kept as a manual escape hatch in case you want to bless
-- a different user as the FAM admin without re-seeding. Edit the email
-- below and apply.

BEGIN;

UPDATE memberships
SET    role = 'fam'
WHERE  user_id = (SELECT id FROM users WHERE email = 'fam@flickssuite.com');

COMMIT;
