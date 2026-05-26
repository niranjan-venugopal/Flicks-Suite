-- 0008_notification_preferences.sql
-- Per-user, per-event, per-channel notification toggles (PRD §9.3).
-- Absence of a row = default on (resolved in NotificationsService).

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "channel"    text NOT NULL,
  "enabled"    boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_user_event_channel_unique"
  ON "notification_preferences" ("user_id", "event_type", "channel");
CREATE INDEX IF NOT EXISTS "notification_preferences_user_idx"
  ON "notification_preferences" ("user_id");
