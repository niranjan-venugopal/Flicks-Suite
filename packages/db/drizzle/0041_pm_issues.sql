-- Migration 0041 — PM issues core (PRD v6 §5; PRD-numbered 0040).
-- pm_issues + companions (labels join, relations, subscribers, comments,
-- reactions, permanent field-change history) + FTS/trigram search columns
-- (§13) + record_files object_type extension. Additive + idempotent.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS pm_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES pm_teams(id),
  number INTEGER NOT NULL,                          -- ENG-42 → 42 (pm_team_counters)
  title TEXT NOT NULL,
  description TEXT,                                 -- markdown; lazy-loaded by sync
  state_id UUID NOT NULL REFERENCES pm_workflow_states(id),
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  estimate NUMERIC(6,2),
  assignee_user_id UUID REFERENCES users(id),       -- SINGLE owner (doctrine)
  creator_user_id UUID REFERENCES users(id),
  parent_issue_id UUID REFERENCES pm_issues(id),
  project_id UUID,                                  -- FK added in 0042 (pm_projects)
  milestone_id UUID,
  cycle_id UUID,
  due_date DATE,
  board_rank TEXT NOT NULL,
  backlog_rank TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','import','api','github','intake','deal')),
  triaged_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, team_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_team_state ON pm_issues(tenant_id, team_id, state_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON pm_issues(tenant_id, assignee_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_issues_cycle ON pm_issues(tenant_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_issues_project ON pm_issues(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON pm_issues(parent_issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_search ON pm_issues USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_issues_title_trgm ON pm_issues USING GIN (title gin_trgm_ops);

CREATE TABLE IF NOT EXISTS pm_issue_labels (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES pm_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_issue_labels_label ON pm_issue_labels(tenant_id, label_id);

CREATE TABLE IF NOT EXISTS pm_issue_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,       -- a
  related_issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE, -- b
  type TEXT NOT NULL CHECK (type IN ('blocks','duplicate_of','relates_to')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, issue_id, related_issue_id, type),
  CHECK (issue_id <> related_issue_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_relations_related ON pm_issue_relations(tenant_id, related_issue_id);

CREATE TABLE IF NOT EXISTS pm_issue_subscribers (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_subscribers_user ON pm_issue_subscribers(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS pm_issue_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  parent_comment_id UUID REFERENCES pm_issue_comments(id) ON DELETE CASCADE, -- one level
  body TEXT NOT NULL,                               -- markdown
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED,
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pm_comments_issue ON pm_issue_comments(tenant_id, issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pm_comments_search ON pm_issue_comments USING GIN (search_tsv);

CREATE TABLE IF NOT EXISTS pm_comment_reactions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  comment_id UUID NOT NULL REFERENCES pm_issue_comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, user_id, emoji)
);

-- Permanent field-change ledger (outbox prunes at 90d; history does not).
CREATE TABLE IF NOT EXISTS pm_issue_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES pm_issues(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pm_history_issue ON pm_issue_history(tenant_id, issue_id, created_at);

-- record_files may now attach to issues/projects (§5.1; pipeline lands later).
DO $rf$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'record_files') THEN
    ALTER TABLE record_files DROP CONSTRAINT IF EXISTS record_files_object_type_check;
    ALTER TABLE record_files ADD CONSTRAINT record_files_object_type_check
      CHECK (object_type IN ('deal','person','company','lead','issue','project'));
  END IF;
END
$rf$;

-- RLS + grants.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_issues','pm_issue_labels','pm_issue_relations','pm_issue_subscribers','pm_issue_comments','pm_comment_reactions','pm_issue_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;
