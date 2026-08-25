-- 0051: PM guest seats (founder round 7)
--
-- 1) New membership role 'guest' — a project-scoped external seat for the
--    PM module. Non-hierarchical like 'auditor' (RolesGuard level 0); PM
--    access comes from a membership_grants {module:'pm'} row written by the
--    invite, and visibility is scoped to pm_project_members rows.
--    ⚠ The value is deliberately NOT used by any DML in this file (0013
--    precedent): ADD VALUE inside a transaction cannot be consumed in the
--    same transaction. All 'guest' usage is runtime-only.
ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'guest';

-- 2) Guest visibility lookups walk pm_project_members by (tenant, user).
--    The table + RLS + grants ship in 0042; this adds the missing index.
CREATE INDEX IF NOT EXISTS idx_pm_project_members_user
  ON pm_project_members (tenant_id, user_id);
