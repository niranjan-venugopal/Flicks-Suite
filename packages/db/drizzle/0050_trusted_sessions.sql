-- Migration 0050 — 180-day trusted-device sessions (founder round 4).
-- A refresh token minted on (or upgraded from) a device the user explicitly
-- chose to trust carries trusted=true and a ~180-day expiry; rotation reads
-- the flag to preserve the long window. refresh_tokens is service-role-only
-- (identity lockdown, 0011) so no policy/grant changes are needed.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS trusted boolean NOT NULL DEFAULT false;
