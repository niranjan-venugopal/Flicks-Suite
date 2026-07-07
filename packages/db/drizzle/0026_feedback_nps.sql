-- =============================================================================
-- 0026 — feedback_submissions + nps_responses (PRD v4 §7)
-- =============================================================================
-- In-app feedback (menu-triggered, D10-R) and the beta NPS micro-survey.
-- RLS: SELF-VISIBILITY on both — a user reads/writes only their own rows;
-- the FAM inbox reads via the service role. Feedback status changes happen
-- through the FAM service (service role), so the app role needs no UPDATE.
--
-- Additive + idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN ('bug','idea','question','other')),
  message       text NOT NULL CHECK (char_length(message) <= 4000),
  contact_ok    boolean NOT NULL DEFAULT false,
  page_path     text,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','resolved','closed')),
  internal_note text,
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_tenant_created
  ON feedback_submissions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_submissions (status);
-- Hot paths: the per-submit 10/day throttle count and the unfiltered FAM inbox.
CREATE INDEX IF NOT EXISTS idx_feedback_user_created
  ON feedback_submissions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback_submissions (category);

ALTER TABLE feedback_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feedback_self_select ON feedback_submissions;
CREATE POLICY feedback_self_select ON feedback_submissions FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
DROP POLICY IF EXISTS feedback_self_insert ON feedback_submissions;
CREATE POLICY feedback_self_insert ON feedback_submissions FOR INSERT
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND tenant_id = current_setting('app.tenant_id', true)::uuid
  );
GRANT SELECT, INSERT ON feedback_submissions TO flicks_app;
REVOKE UPDATE, DELETE ON feedback_submissions FROM flicks_app;

CREATE TABLE IF NOT EXISTS nps_responses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  survey_key    text NOT NULL DEFAULT 'beta_nps_v1',
  score         smallint CHECK (score BETWEEN 0 AND 10),
  comment       text,
  status        text NOT NULL CHECK (status IN ('answered','dismissed','snoozed')),
  prompted_at   timestamptz,
  responded_at  timestamptz,
  snoozed_until timestamptz,
  UNIQUE (user_id, survey_key)
);

CREATE INDEX IF NOT EXISTS idx_nps_survey_status ON nps_responses (survey_key, status);

ALTER TABLE nps_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE nps_responses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nps_self_all ON nps_responses;
-- Self-visibility + tenant pinning: a user acts only on their own row, and
-- writes must carry the session's tenant (no cross-tenant mis-attribution).
CREATE POLICY nps_self_all ON nps_responses FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND tenant_id = current_setting('app.tenant_id', true)::uuid
  );
GRANT SELECT, INSERT, UPDATE ON nps_responses TO flicks_app;
-- No DELETE: answered/dismissed are permanent (§7 once-only) — without this
-- revoke the 0017 default privileges leave DELETE granted and the FOR ALL
-- policy would let a user erase their own row and get re-prompted.
REVOKE DELETE ON nps_responses FROM flicks_app;
