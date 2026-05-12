-- 0002_owner_role.sql
-- Adds the 'owner' value to the membership_role enum.
--
-- Per PRD §3.6 and the rosy-crafting-globe plan, tenant signup creates a
-- single founder user with role='owner'. The Owner has everything an
-- HR Admin has plus billing, tenant-level settings, and the ability to
-- promote or demote anyone in the workspace.
--
-- Idempotent: IF NOT EXISTS prevents re-adding if the value is already
-- present. Safe to re-run.

ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'owner';
