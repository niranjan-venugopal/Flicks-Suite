-- Migration 0036 — CRM Automation & Capture (PRD v5 §5/§8, Sprint 30)
--
-- Leads inbox (C6), web forms + hosted capture (C13), workflows engine (C12)
-- with a run audit. Idempotent + additive per house convention; every tenant
-- table gets FORCE RLS + isolation policy + flicks_app grants and joins the
-- isolation suite.

-- Leads (§5.1): a lightweight triage row — converting creates/links directory
-- records + a deal and never leaves a duplicate lead object behind.
CREATE TABLE IF NOT EXISTS leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name    text NOT NULL,
  last_name     text,
  company_name  text,
  email         text,
  phone         text,
  note          text,
  source        text NOT NULL DEFAULT 'manual',       -- manual|api|import|email_in|form:<tag>
  score         integer NOT NULL DEFAULT 0,           -- rule-based (§5.3), recomputed on write
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','working','converted','discarded')),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  form_id       uuid,                                  -- set when captured via a web form
  utm           jsonb NOT NULL DEFAULT '{}',
  extra         jsonb NOT NULL DEFAULT '{}',           -- non-standard form fields
  converted_person_id  uuid REFERENCES directory_people(id) ON DELETE SET NULL,
  converted_company_id uuid REFERENCES directory_companies(id) ON DELETE SET NULL,
  converted_deal_id    uuid REFERENCES deals(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_inbox ON leads (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (tenant_id, lower(email));

-- Web forms (C13, §5.2): hosted at /f/:token + embeddable; submissions become
-- leads. Spam defense is honeypot + min-fill-time + per-IP throttle — no
-- third-party CAPTCHAs.
CREATE TABLE IF NOT EXISTS web_forms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  token           text NOT NULL UNIQUE,                -- public URL part, hex
  title           text NOT NULL DEFAULT 'Talk to sales',
  intro           text,
  fields          jsonb NOT NULL DEFAULT '[]',         -- [{key,label,type,required}]
  source_tag      text NOT NULL DEFAULT 'form',        -- lead.source becomes form:<tag>
  assignment      text NOT NULL DEFAULT 'round_robin' CHECK (assignment IN ('none','round_robin')),
  success_message text NOT NULL DEFAULT E'Thanks — we''ll be in touch',
  redirect_url    text,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_web_form_name ON web_forms (tenant_id, lower(name));

-- Submission audit (C13 Submissions tab) — payload snapshot + the lead it made.
CREATE TABLE IF NOT EXISTS form_submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  form_id    uuid NOT NULL REFERENCES web_forms(id) ON DELETE CASCADE,
  lead_id    uuid REFERENCES leads(id) ON DELETE SET NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  utm        jsonb NOT NULL DEFAULT '{}',
  ip_hash    text,                                     -- sha256(ip), throttle key — never the raw IP
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_submissions ON form_submissions (tenant_id, form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_throttle ON form_submissions (ip_hash, created_at);

-- Workflows (C12, §8): trigger → conditions → actions, stored as validated
-- JSON. Beta limits (20 active / 2,000 runs/day / chain depth ≤ 2) are
-- enforced in the service, not the schema.
CREATE TABLE IF NOT EXISTS workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  trigger     text NOT NULL,                           -- domain event name (crm.*)
  conditions  jsonb NOT NULL DEFAULT '[]',             -- [{field,op,value}] AND-combined
  actions     jsonb NOT NULL DEFAULT '[]',             -- [{type,...config}] in order
  active      boolean NOT NULL DEFAULT true,
  runs_count  integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows (tenant_id, trigger) WHERE active = true;

-- Run audit (C12 run history): one row per workflow x trigger event —
-- the unique pair makes runs idempotent under outbox redelivery.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id  uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  event_id     text NOT NULL,                          -- domain_events.id that fired it
  subject_type text,                                   -- deal|lead|activity|email
  subject_id   uuid,
  status       text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','skipped')),
  steps        jsonb NOT NULL DEFAULT '[]',            -- [{label,status,error?}]
  depth        smallint NOT NULL DEFAULT 0,            -- workflow-caused chain depth (loop guard)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_run ON workflow_runs (workflow_id, event_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs ON workflow_runs (tenant_id, created_at DESC);

DO $auto$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','web_forms','form_submissions','workflows','workflow_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$auto$;
