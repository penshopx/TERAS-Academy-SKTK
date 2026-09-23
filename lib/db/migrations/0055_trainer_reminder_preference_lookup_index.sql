-- psql -f migration: a cancelled concurrent build may leave an invalid index
-- with the target name. Remove only that invalid copy before rebuilding.
-- \gexec runs the generated DDL as its own statement, outside a transaction.
SELECT format('DROP INDEX CONCURRENTLY %I.%I', namespace.nspname, relation.relname)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
JOIN pg_index idx ON idx.indexrelid = relation.oid
WHERE namespace.nspname = current_schema()
  AND relation.relname = 'teras_trainer_reminder_preferences_trainer_created_id_idx'
  AND (NOT idx.indisvalid OR NOT idx.indisready)
\gexec

-- Build the replacement before removing the older prefix index. These statements
-- intentionally run outside a transaction so an existing large table stays writable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "teras_trainer_reminder_preferences_trainer_created_id_idx"
  ON "teras_trainer_reminder_preferences" ("trainer_id", "created_at", "id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_index idx ON idx.indexrelid = relation.oid
    WHERE namespace.nspname = current_schema()
      AND relation.relname = 'teras_trainer_reminder_preferences_trainer_created_id_idx'
      AND idx.indisvalid AND idx.indisready
  ) THEN
    RAISE EXCEPTION 'replacement trainer preference index is not valid; keep the old index';
  END IF;
END
$$;

DROP INDEX CONCURRENTLY IF EXISTS "teras_trainer_reminder_preferences_trainer_created_idx";