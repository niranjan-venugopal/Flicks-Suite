-- Migration 0035 — CRM Email Phase A (PRD v5 §7.1, §19.4/§19.5, Sprint 29)
--
-- Compose/track/sequence infrastructure + the BCC dropbox + do-not-contact.
-- Idempotent + additive per house convention; every tenant table gets FORCE
-- RLS + isolation policy + flicks_app grants and joins the isolation suite.

-- Per-user signature (§19.4) appended to composed email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_signature_html text;

-- Do-not-contact (§19.5): hard block on compose/sequences; auto-set on
-- bounce/complaint; surfaced as a badge on the person.
ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS email_do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS email_do_not_contact_reason text;

-- Reusable message templates (manager UI in chunk 2; API now).
CREATE TABLE IF NOT EXISTS email_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  subject     text NOT NULL,
  body_html   text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived    boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_template_name
  ON email_templates (tenant_id, lower(name)) WHERE archived = false;

-- Every CRM email, both directions. Outbound rows carry tracking counters;
-- inbound rows come from the BCC dropbox webhook.
CREATE TABLE IF NOT EXISTS email_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('out','in')),
  status        text NOT NULL DEFAULT 'sent', -- sent|delivered|bounced|complained|failed|received
  provider_id   text,                          -- Resend message id (webhook correlation)
  from_email    text,
  to_email      text NOT NULL,
  subject       text NOT NULL,
  body_html     text,
  person_id     uuid REFERENCES directory_people(id) ON DELETE SET NULL,
  deal_id       uuid REFERENCES deals(id) ON DELETE SET NULL,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  open_token    text UNIQUE,                   -- signed pixel token
  open_count    integer NOT NULL DEFAULT 0,
  click_count   integer NOT NULL DEFAULT 0,
  tracking      boolean NOT NULL DEFAULT false,
  sequence_enrollment_id uuid,                 -- set by the sequence engine (chunk 2)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_messages_deal ON email_messages (tenant_id, deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_person ON email_messages (tenant_id, person_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_provider ON email_messages (provider_id);

-- Wrapped links (one row per distinct href per message) for click tracking.
CREATE TABLE IF NOT EXISTS email_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  url         text NOT NULL,
  click_count integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_links_message ON email_links (tenant_id, message_id);

-- Delivery/engagement lifecycle (webhook + tracking endpoints append here).
CREATE TABLE IF NOT EXISTS email_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  type        text NOT NULL, -- delivered|bounced|complained|opened|clicked|unsubscribed
  meta        jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_message ON email_events (tenant_id, message_id, occurred_at);

-- Sequences (C10) — tables land now; the engine ships in the next chunk.
CREATE TABLE IF NOT EXISTS sequences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  send_window_start text NOT NULL DEFAULT '09:00',
  send_window_end   text NOT NULL DEFAULT '18:00',
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sequence_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id  uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order   smallint NOT NULL,
  wait_days    smallint NOT NULL DEFAULT 0,
  subject      text NOT NULL,
  body_html    text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sequence_steps ON sequence_steps (tenant_id, sequence_id, step_order);
CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id  uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
  deal_id      uuid REFERENCES deals(id) ON DELETE SET NULL,
  enrolled_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  current_step smallint NOT NULL DEFAULT 0,
  next_send_at timestamptz,
  status       text NOT NULL DEFAULT 'active', -- active|completed|exited
  exit_reason  text,                            -- replied|won|lost|dnc|manual
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_enrollment
  ON sequence_enrollments (sequence_id, person_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
  ON sequence_enrollments (tenant_id, next_send_at) WHERE status = 'active';

-- BCC dropbox address per tenant: {slug}-{token}@in.<domain> (§7.1).
CREATE TABLE IF NOT EXISTS tenant_inbound_addresses (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Phase-B scaffold (C21): two-way sync accounts, dark behind feature.email_sync.
-- Token columns are AES-256-GCM ciphertext; a self-visibility RLS policy keeps
-- one member's tokens invisible to everyone else in the tenant.
CREATE TABLE IF NOT EXISTS connected_email_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('google','microsoft')),
  email         text NOT NULL,
  access_token_enc  text,
  refresh_token_enc text,
  status        text NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connected_account ON connected_email_accounts (tenant_id, user_id, provider);

-- Resend webhook idempotency ledger (service-role only, like razorpay_events).
CREATE TABLE IF NOT EXISTS resend_webhook_events (
  id          text PRIMARY KEY,        -- svix message id
  received_at timestamptz NOT NULL DEFAULT now()
);

DO $mail$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_templates','email_messages','email_links','email_events','sequences','sequence_steps','sequence_enrollments','tenant_inbound_addresses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flicks_app', t);
  END LOOP;
END
$mail$;

-- connected_email_accounts: tenant isolation AND self-visibility — only the
-- OWNING user's transactions may read/write their row (tokens stay private).
ALTER TABLE connected_email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_email_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS self_connected_email_accounts ON connected_email_accounts;
CREATE POLICY self_connected_email_accounts ON connected_email_accounts
  FOR ALL USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = current_setting('app.user_id', true)::uuid
  ) WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND user_id = current_setting('app.user_id', true)::uuid
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON connected_email_accounts TO flicks_app;
-- resend_webhook_events: service-role only — NO app grants on purpose.
