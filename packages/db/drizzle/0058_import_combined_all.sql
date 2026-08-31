-- Round C: the combined CRM import ("one file — everything") stamps its
-- batches with object_type = 'all'. Widen the CHECK to accept it, keeping
-- every value the CRM (0037) and PM (0044) importers already write.
-- Idempotent: DROP IF EXISTS + ADD re-runs to the same end state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches') THEN
    ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_object_type_check;
    ALTER TABLE import_batches ADD CONSTRAINT import_batches_object_type_check
      CHECK (object_type IN ('people','companies','leads','all','pm_issues','pm_projects'));
  END IF;
END $$;
