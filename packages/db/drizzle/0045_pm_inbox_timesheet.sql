-- 0045: PM Inbox lifecycle on notifications + timesheet ↔ PM linkage (PRD v6 §11, §15.3)
-- Idempotent: safe to re-run.

-- ─── notifications: inbox lifecycle columns ──────────────────────────────────
-- archived_at: row leaves the inbox but stays queryable under the Archived filter.
-- snoozed_until: row hides from the inbox until due (server filters on read).
-- group_key: collapses repeats of the same subject (e.g. 'pm.issue:<id>') —
-- new activity on the same subject bumps the one row instead of stacking.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_key text;
-- group_count: how many events collapsed into this row ("+N more" in the UI).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_count integer NOT NULL DEFAULT 1;
-- emailed_at: exactly-once marker for the delayed-email sweeps (urgent + digest).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at timestamptz;

-- Per-user email digest cadence for inbox-style notifications (P10 segmented
-- control): 'urgent' = only the 5-min unread-mention/assignment emails,
-- 'hourly'/'daily' = fold everything else on that cadence.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email_digest text NOT NULL DEFAULT 'daily';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_notification_email_digest_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_notification_email_digest_check
      CHECK (notification_email_digest IN ('urgent', 'hourly', 'daily'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notifications_user_group_idx
  ON notifications (user_id, group_key);

-- Partial index for the hot inbox query: unarchived rows per user, newest first.
CREATE INDEX IF NOT EXISTS notifications_inbox_idx
  ON notifications (user_id, created_at DESC)
  WHERE archived_at IS NULL;

-- ─── timesheet_entries: real FKs to the PM tables (§15.3) ────────────────────
-- project_id/task_id predate the PM module as bare uuids. Null out any dangling
-- references first (pre-PM garbage), then attach FKs NOT VALID → VALIDATE so
-- the ALTER never rewrites the table under load.
UPDATE timesheet_entries te SET project_id = NULL
  WHERE te.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pm_projects p WHERE p.id = te.project_id);
UPDATE timesheet_entries te SET task_id = NULL
  WHERE te.task_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pm_issues i WHERE i.id = te.task_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'timesheet_entries_project_id_fkey'
  ) THEN
    ALTER TABLE timesheet_entries
      ADD CONSTRAINT timesheet_entries_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES pm_projects(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'timesheet_entries_task_id_fkey'
  ) THEN
    ALTER TABLE timesheet_entries
      ADD CONSTRAINT timesheet_entries_task_id_fkey
      FOREIGN KEY (task_id) REFERENCES pm_issues(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

ALTER TABLE timesheet_entries VALIDATE CONSTRAINT timesheet_entries_project_id_fkey;
ALTER TABLE timesheet_entries VALIDATE CONSTRAINT timesheet_entries_task_id_fkey;
