-- apply-0061.sql — Round J (2026-09-09): the Teams-style calendar.
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Identical to packages/db/drizzle/0061_calendar_events.sql.

-- 0061 — Round J: the Teams-style calendar (events, meetings, team availability).
--
-- calendar_events (0001) was designed as a projection cache and was never
-- written by any code path. It becomes the first-class record for
-- user-authored events and meetings. Attendees live in a child table so an
-- RSVP is a row update, not a JSON rewrite. meeting_provider / meeting_url are
-- the door for auto-generated Teams / Google Meet links once a user connects
-- their Microsoft 365 / Google account (MeetingLinksService) — today the link
-- is pasted by the organizer.
--
-- The 0001 enum calendar_event_type is left untouched: user-authored rows use
-- event_type = 'company_event' and the real kind ('event' | 'meeting') lives
-- in the new text column, so no ALTER TYPE is needed.
--
-- calendar_events had RLS + the tenant policy from 0001 but NO grant to
-- flicks_app; the DO-loop below (0037 pattern) adds it for both tables.
--
-- Idempotent and additive; mirrored in packages/db/src/schema/calendar.ts.

-- 1. Columns on the existing table.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'event';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS organizer_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS meeting_provider text NOT NULL DEFAULT 'none';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS meeting_url text;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_events_kind_chk') THEN
    ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_kind_chk
      CHECK (kind IN ('event', 'meeting'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_events_provider_chk') THEN
    ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_provider_chk
      CHECK (meeting_provider IN ('none', 'teams', 'google_meet', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_events_range_chk') THEN
    ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_range_chk
      CHECK (end_at > start_at);
  END IF;
END
$chk$;

-- 2. Range scans for the week/day/month views; organizer lists.
CREATE INDEX IF NOT EXISTS idx_calendar_events_tenant_range
  ON calendar_events (tenant_id, start_at, end_at) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_organizer
  ON calendar_events (tenant_id, organizer_user_id, start_at) WHERE cancelled_at IS NULL;

-- 3. Attendees (internal workspace members only this round).
CREATE TABLE IF NOT EXISTS calendar_event_attendees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id      uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_optional   boolean NOT NULL DEFAULT false,
  response      text NOT NULL DEFAULT 'pending'
                  CHECK (response IN ('pending', 'accepted', 'declined', 'tentative')),
  responded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_event_attendees_event_id_user_id_key UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_attendees_user
  ON calendar_event_attendees (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_attendees_event
  ON calendar_event_attendees (tenant_id, event_id);

-- 4. The week/day views range-scan leave on every navigation; only the two
--    single-column date indexes exist today.
CREATE INDEX IF NOT EXISTS idx_leave_requests_tenant_range
  ON leave_requests (tenant_id, start_date, end_date);

-- 5. RLS + grants (0037 loop). calendar_events had a policy but no grant.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendar_events', 'calendar_event_attendees'] LOOP
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
