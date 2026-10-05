-- 0067 — Round P R3: company policies + acknowledgements (new module `policies`).
--
-- company_policies — one row per policy. HR/Owner (or anyone holding the
-- 'policies' module grant) writes it as rich text (body_md, cleaned server-side)
-- OR uploads a PDF (file_* columns; the object lives in private R2 under
-- tenants/<tenant>/policies/<policy>/<uuid>.pdf). `version` starts at 1 and
-- only moves when a PUBLISHED policy is re-published with "ask everyone to
-- agree again" — editing the body of a published policy keeps the version.
-- `applies_to_roles` NULL = every standard role (owner/admin/manager/finance/
-- employee); guest/auditor/fam seats are never asked. `last_reminded_at` is
-- the 1-per-hour throttle marker for POST /policies/:id/remind (an
-- updated_at-style column rather than an audit-log probe, so the throttle
-- holds even where the audit trail is pruned or stubbed).
--
-- policy_acknowledgements — one row per (policy, version, user); the UNIQUE
-- makes the acknowledge call idempotent (INSERT … ON CONFLICT DO NOTHING).
-- employee_id is the caller's employee record when the seat has one (NULL for
-- owner seats without a record); ip_hash = sha256(ip + server salt), never the
-- raw IP, mirroring the consent ledger.
--
-- Both tables: ENABLE + FORCE RLS, tenant_isolation_* policy on
-- current_setting('app.tenant_id') and grants to flicks_app (0037/0061 loop).
-- Idempotent and additive; mirrored in packages/db/src/schema/policies.ts.
--
-- Release ordering: the API module selects whole rows from both tables, so
-- apply this in Supabase BEFORE pushing the API.

-- 1. company_policies
CREATE TABLE IF NOT EXISTS company_policies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title                     text NOT NULL,
  category                  text,
  kind                      text NOT NULL DEFAULT 'rich_text'
                              CONSTRAINT company_policies_kind_chk CHECK (kind IN ('rich_text', 'pdf')),
  body_md                   text,
  file_key                  text,
  file_name                 text,
  file_size_bytes           integer,
  file_sha256               text,
  version                   integer NOT NULL DEFAULT 1,
  status                    text NOT NULL DEFAULT 'draft'
                              CONSTRAINT company_policies_status_chk CHECK (status IN ('draft', 'published', 'archived')),
  requires_acknowledgement  boolean NOT NULL DEFAULT true,
  applies_to_roles          text[],
  published_at              timestamptz,
  published_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at               timestamptz,
  last_reminded_at          timestamptz,
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Re-runs against a table created by an earlier draft of this file.
ALTER TABLE company_policies ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_company_policies_tenant_status
  ON company_policies (tenant_id, status);

-- 2. policy_acknowledgements
CREATE TABLE IF NOT EXISTS policy_acknowledgements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_id        uuid NOT NULL REFERENCES company_policies(id) ON DELETE CASCADE,
  policy_version   integer NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id      uuid REFERENCES employees(id) ON DELETE SET NULL,
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  ip_hash          text,
  user_agent       text,
  CONSTRAINT policy_acknowledgements_tenant_policy_version_user_key
    UNIQUE (tenant_id, policy_id, policy_version, user_id)
);

CREATE INDEX IF NOT EXISTS idx_policy_acknowledgements_user
  ON policy_acknowledgements (tenant_id, user_id);

-- 3. RLS + grants (0037/0061 loop).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_policies', 'policy_acknowledgements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t, t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$rls$;
