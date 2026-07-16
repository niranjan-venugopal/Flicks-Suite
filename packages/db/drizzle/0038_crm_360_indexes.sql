-- Migration 0038 — Launch-readiness perf: indexes for the contact/company
-- 360° detail pages and the per-user email scans.
-- Additive + idempotent per house convention. These back queries shipped in
-- the MVP-polish pass that had no supporting index (sequential-scan cliff as a
-- tenant's data grows):
--   * deals.service.listForContact/listForCompany  → deals(primary_person_id|company_id)
--   * activities.service.listForContact/listForCompany → activities(person_id|company_id)
--   * sequences send throttle + reports activity leaderboard → email_messages(sender_user_id, created_at)
-- Partial on deleted_at IS NULL to match the query predicate and stay lean,
-- mirroring idx_activities_deal.

CREATE INDEX IF NOT EXISTS idx_deals_person
  ON deals (tenant_id, primary_person_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_company
  ON deals (tenant_id, company_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_activities_person
  ON activities (tenant_id, person_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activities_company
  ON activities (tenant_id, company_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_sender
  ON email_messages (sender_user_id, created_at);
