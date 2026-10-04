-- apply-0065.sql — Round O (2026-10-01): per-user light theme — users.theme (0065).
-- Run once in the Supabase SQL editor (service role). Idempotent: safe to re-run.
-- Run it BEFORE pushing the API (GET /auth/me selects the whole users row).
-- Identical to packages/db/drizzle/0065_user_theme.sql.

-- 0065 — Round O: per-user light theme (users.theme).
--
-- users.theme — the person's appearance preference ('system' | 'light' |
-- 'dark'), remembered server-side so it follows them to every device and to
-- the admin console (a different origin, so a localStorage mirror alone can't
-- carry it). Two-step default on purpose (founder decision):
--   1. ADD COLUMN … DEFAULT 'dark' — the FIRST run backfills every existing
--      row 'dark', so current users keep today's look until they switch;
--   2. ALTER COLUMN SET DEFAULT 'light' — future INSERTs (signup, invite,
--      member import — none of the four insert sites pass a theme) get 'light'.
-- Guarded CHECK (0062/0064 pattern). users is a platform table: no RLS policy
-- or grant changes — the existing table-level grants cover the new column.
-- Idempotent and additive; mirrored in packages/db/src/schema/platform.ts.
--
-- Release ordering: GET /auth/me is a bare select().from(users), so an API
-- built with the mirror 500s on every /me until this has run — apply in
-- Supabase BEFORE pushing the API.

-- 1. Column (first run backfills every existing row 'dark').
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'dark';

-- 2. New accounts default light.
ALTER TABLE users ALTER COLUMN theme SET DEFAULT 'light';

-- 3. Guarded CHECK constraint (0062 pattern).
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_theme_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_theme_check CHECK (theme IN ('system', 'light', 'dark'));
  END IF;
END
$chk$;
