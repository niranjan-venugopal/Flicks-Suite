-- =============================================================================
-- 0031 — directory kernel (PRD v5 §3 · Sprint 25)
-- =============================================================================
-- Shared people/companies that CRM presents as Contacts/Companies and that
-- Invoicing links from `customers`. ONE canonical person/org per tenant — no
-- dual records. Backfills existing invoicing customers idempotently:
--   business  → directory_companies (dedupe by domain, else exact name)
--   individual→ directory_people    (dedupe by email)
-- and links customers.directory_company_id / directory_person_id.
--
-- Additive + idempotent.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ─── directory_companies ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS directory_companies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  domain         citext,
  website        text, industry text, size_band text, phone text,
  address_line1  text, address_line2 text, city text, state text,
  postal_code    text, country_code char(2),
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  source         text,                          -- manual|import|form|api|invoicing_backfill
  last_activity_at timestamptz,
  custom         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dir_company_domain
  ON directory_companies (tenant_id, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dir_company_name
  ON directory_companies USING gin (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS idx_dir_company_name_trgm
  ON directory_companies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dir_company_tenant
  ON directory_companies (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE directory_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_directory_companies ON directory_companies;
CREATE POLICY tenant_isolation_directory_companies ON directory_companies
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON directory_companies TO flicks_app;

-- ─── directory_people ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS directory_people (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name     text, last_name text,
  display_name   text GENERATED ALWAYS AS
                   (COALESCE(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),''),
                             first_name, last_name)) STORED,
  email          citext, secondary_emails citext[],
  phone          text, secondary_phones text[],
  title          text,
  company_id     uuid REFERENCES directory_companies(id) ON DELETE SET NULL,
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  source         text, last_activity_at timestamptz,
  custom         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dir_people_email
  ON directory_people (tenant_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dir_people_company
  ON directory_people (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_dir_people_name
  ON directory_people USING gin (to_tsvector('simple', coalesce(first_name,'')||' '||coalesce(last_name,'')));
CREATE INDEX IF NOT EXISTS idx_dir_people_name_trgm
  ON directory_people USING gin ((coalesce(first_name,'')||' '||coalesce(last_name,'')) gin_trgm_ops);

ALTER TABLE directory_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_people FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_directory_people ON directory_people;
CREATE POLICY tenant_isolation_directory_people ON directory_people
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON directory_people TO flicks_app;

-- ─── invoicing linkage (non-breaking) ────────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS directory_company_id uuid REFERENCES directory_companies(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS directory_person_id  uuid REFERENCES directory_people(id);

-- ─── backfill (idempotent) ───────────────────────────────────────────────────
-- Only touches customers not yet linked. Runs as service role (superuser),
-- so RLS is bypassed here; tenant_id is carried explicitly on every row.
DO $backfill$
DECLARE c RECORD;
  v_company_id uuid;
  v_person_id  uuid;
  v_domain     text;
BEGIN
  FOR c IN
    SELECT * FROM customers
    WHERE deleted_at IS NULL
      AND directory_company_id IS NULL AND directory_person_id IS NULL
  LOOP
    IF c.customer_type = 'individual' THEN
      -- Dedupe people by email within the tenant.
      v_person_id := NULL;
      IF c.email IS NOT NULL AND c.email <> '' THEN
        SELECT id INTO v_person_id FROM directory_people
          WHERE tenant_id = c.tenant_id AND email = c.email::citext AND deleted_at IS NULL
          LIMIT 1;
      END IF;
      IF v_person_id IS NULL THEN
        INSERT INTO directory_people (tenant_id, first_name, email, phone, source)
        VALUES (c.tenant_id, c.display_name, NULLIF(c.email,'')::citext, c.phone, 'invoicing_backfill')
        RETURNING id INTO v_person_id;
      END IF;
      UPDATE customers SET directory_person_id = v_person_id WHERE id = c.id;
    ELSE
      -- Business: dedupe companies by domain (from email) else exact name.
      v_domain := NULLIF(lower(split_part(COALESCE(c.email,''), '@', 2)), '');
      v_company_id := NULL;
      IF v_domain IS NOT NULL THEN
        SELECT id INTO v_company_id FROM directory_companies
          WHERE tenant_id = c.tenant_id AND domain = v_domain::citext AND deleted_at IS NULL
          LIMIT 1;
      END IF;
      IF v_company_id IS NULL THEN
        SELECT id INTO v_company_id FROM directory_companies
          WHERE tenant_id = c.tenant_id AND lower(name) = lower(c.display_name) AND deleted_at IS NULL
          LIMIT 1;
      END IF;
      IF v_company_id IS NULL THEN
        INSERT INTO directory_companies
          (tenant_id, name, domain, phone, country_code, address_line1, city, state, postal_code, source)
        VALUES
          (c.tenant_id, c.display_name, v_domain::citext, c.phone,
           NULLIF(c.country_code,'')::char(2), c.billing_address_line1, c.billing_city,
           c.billing_state, c.billing_postal_code, 'invoicing_backfill')
        RETURNING id INTO v_company_id;
      END IF;
      -- A named primary contact becomes a linked person under the company.
      v_person_id := NULL;
      IF c.primary_contact_name IS NOT NULL AND c.primary_contact_name <> '' THEN
        INSERT INTO directory_people (tenant_id, first_name, email, phone, company_id, source)
        VALUES (c.tenant_id, c.primary_contact_name, NULLIF(c.email,'')::citext, c.phone,
                v_company_id, 'invoicing_backfill')
        RETURNING id INTO v_person_id;
      END IF;
      UPDATE customers SET directory_company_id = v_company_id,
             directory_person_id = COALESCE(v_person_id, directory_person_id)
        WHERE id = c.id;
    END IF;
  END LOOP;
END
$backfill$;
