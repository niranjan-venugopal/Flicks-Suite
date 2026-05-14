-- In-app notifications. User-scoped (cross-tenant possible when a user
-- belongs to multiple workspaces); tenant_id is recorded for filtering
-- the notification surface to a single workspace when relevant.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "user_id"   uuid NOT NULL REFERENCES "users"   ("id") ON DELETE CASCADE,
  "type"      text NOT NULL,
  "message"   text NOT NULL,
  "link_url"  text,
  "read_at"   timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notifications_user_read_idx"
  ON "notifications" ("user_id", "read_at");
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx"
  ON "notifications" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "notifications_tenant_id_idx"
  ON "notifications" ("tenant_id");
