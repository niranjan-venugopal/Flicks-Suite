-- Migration 0034 — CRM activities (PRD v5 §6, Sprint 28)
--
-- The activity loop that drives activity-based selling: tasks, calls, meetings
-- and notes attached to deals/people/companies, with an assignee and a due
-- time. deals.next_activity_at / last_activity_at are maintained by the
-- service on every write, so the board's "no next activity" doctrine line and
-- idle detection stay cheap. Idempotent + additive per house convention.

CREATE TABLE IF NOT EXISTS activities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('task','call','meeting','note')),
  subject          text NOT NULL,
  body             text,
  deal_id          uuid REFERENCES deals(id) ON DELETE CASCADE,
  person_id        uuid REFERENCES directory_people(id) ON DELETE SET NULL,
  company_id       uuid REFERENCES directory_companies(id) ON DELETE SET NULL,
  assignee_user_id uuid NOT NULL REFERENCES users(id),
  due_at           timestamptz,                       -- NULL for logged notes
  completed_at     timestamptz,
  completed_by     uuid REFERENCES users(id),
  outcome          text,                              -- call outcomes: connected|no_answer|busy|voicemail|wrong_number
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_activities_assignee_due
  ON activities (tenant_id, assignee_user_id, due_at)
  WHERE completed_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activities_deal
  ON activities (tenant_id, deal_id, due_at) WHERE deleted_at IS NULL;

-- @mentions inside activity bodies → in-app notifications (§6.3).
CREATE TABLE IF NOT EXISTS activity_mentions (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  activity_id       uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, mentioned_user_id)
);

DO $act$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activities','activity_mentions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$act$;
