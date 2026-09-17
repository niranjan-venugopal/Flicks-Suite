-- 0063 — Round L item 6: PM attachments + inline media on record_files.
--
-- record_files (0033) already carries RLS (FORCE + tenant_isolation_record_files)
-- and the flicks_app grants, and 0041 whitelisted 'issue'/'project' without a
-- pipeline behind them. This migration widens the object_type CHECK so a file
-- can hang off a COMMENT or sit as an unbound DRAFT (uploaded while composing;
-- bound to the issue/comment on create, pruned after 24 h when never bound),
-- and adds the columns the PM pipeline stores: kind (attachment chip vs an
-- inline image referenced from the markdown body as flicks-file://<id>),
-- image dimensions, the 480-px WebP thumbnail key and a sha256 of the stored
-- bytes. Idempotent + additive — safe to re-run.

DO $rf$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'record_files') THEN
    ALTER TABLE record_files DROP CONSTRAINT IF EXISTS record_files_object_type_check;
    ALTER TABLE record_files ADD CONSTRAINT record_files_object_type_check
      CHECK (object_type IN ('deal','person','company','lead','issue','project','comment','draft'));
  END IF;
END
$rf$;

ALTER TABLE record_files ADD COLUMN IF NOT EXISTS kind      text NOT NULL DEFAULT 'attachment';
ALTER TABLE record_files ADD COLUMN IF NOT EXISTS width     integer;
ALTER TABLE record_files ADD COLUMN IF NOT EXISTS height    integer;
ALTER TABLE record_files ADD COLUMN IF NOT EXISTS thumb_key text;
ALTER TABLE record_files ADD COLUMN IF NOT EXISTS sha256    text;

DO $rk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'record_files_kind_check' AND conrelid = 'record_files'::regclass
  ) THEN
    ALTER TABLE record_files ADD CONSTRAINT record_files_kind_check
      CHECK (kind IN ('attachment','inline'));
  END IF;
END
$rk$;

-- Tenant quota (SUM(size_bytes) of live rows) — index-only scan.
CREATE INDEX IF NOT EXISTS idx_record_files_tenant_live
  ON record_files (tenant_id, size_bytes) WHERE deleted_at IS NULL;

-- Orphan-draft prune (daily job): drafts older than 24 h, oldest first.
CREATE INDEX IF NOT EXISTS idx_record_files_drafts
  ON record_files (created_at) WHERE object_type = 'draft' AND deleted_at IS NULL;
