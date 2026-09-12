BEGIN;

LOCK TABLE
  teras_enrollments,
  teras_enrollment_pathway_events,
  teras_learning_activities,
  teras_content_resources,
  teras_learning_resource_progress
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  mismatch_id text;
BEGIN
  SELECT progress.id INTO mismatch_id
  FROM teras_learning_resource_progress progress
  LEFT JOIN teras_enrollments enrollment
    ON enrollment.id = progress.enrollment_id
   AND enrollment.learner_id = progress.learner_id
  LEFT JOIN teras_learning_activities activity
    ON activity.id = progress.activity_id
  LEFT JOIN teras_content_resources resource
    ON resource.id = progress.resource_id
   AND resource.activity_id = progress.activity_id
  WHERE enrollment.id IS NULL
     OR activity.id IS NULL
     OR resource.id IS NULL
  LIMIT 1;

  IF mismatch_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce learning resource progress context: invalid legacy row %',
      mismatch_id;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_content_resources_id_activity_unique'
      AND conrelid = 'teras_content_resources'::regclass
  ) THEN
    ALTER TABLE teras_content_resources
      ADD CONSTRAINT teras_content_resources_id_activity_unique UNIQUE (id, activity_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_learning_resource_progress_enrollment_learner_fk'
      AND conrelid = 'teras_learning_resource_progress'::regclass
  ) THEN
    ALTER TABLE teras_learning_resource_progress
      ADD CONSTRAINT teras_learning_resource_progress_enrollment_learner_fk
      FOREIGN KEY (enrollment_id, learner_id)
      REFERENCES teras_enrollments(id, learner_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_learning_resource_progress_resource_activity_fk'
      AND conrelid = 'teras_learning_resource_progress'::regclass
  ) THEN
    ALTER TABLE teras_learning_resource_progress
      ADD CONSTRAINT teras_learning_resource_progress_resource_activity_fk
      FOREIGN KEY (resource_id, activity_id)
      REFERENCES teras_content_resources(id, activity_id);
  END IF;
END $$;

-- Shared baseline activities are physically Path A-owned but are authorized for
-- either pathway through the pathway baseline mapping. Learner pathway is a
-- progress scope, not catalogue ownership.
ALTER TABLE teras_learning_resource_progress
  DROP CONSTRAINT IF EXISTS teras_learning_resource_progress_activity_pathway_fk;

DO $$
DECLARE
  legacy_index record;
BEGIN
  FOR legacy_index IN
    SELECT index_class.relname AS index_name
    FROM pg_index index_meta
    JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
    WHERE namespace.nspname = current_schema()
      AND table_class.relname = 'teras_learning_resource_progress'
      AND index_meta.indisunique
      AND ARRAY(
        SELECT attribute.attname::text
        FROM unnest(index_meta.indkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = table_class.oid
         AND attribute.attnum = key.attnum
        ORDER BY key.position
      ) = ARRAY['learner_id', 'enrollment_id', 'activity_id', 'resource_id']
  LOOP
    EXECUTE format('DROP INDEX %I.%I', current_schema(), legacy_index.index_name);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS teras_learning_resource_progress_scope_unique
  ON teras_learning_resource_progress
    (learner_id, enrollment_id, pathway_id, activity_id, resource_id);
DROP INDEX IF EXISTS teras_learning_resource_progress_lookup_idx;
CREATE INDEX teras_learning_resource_progress_lookup_idx
  ON teras_learning_resource_progress
    (learner_id, enrollment_id, pathway_id, activity_id, resource_id);

CREATE OR REPLACE FUNCTION teras_enforce_resource_progress_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effective_pathway_id text;
BEGIN
  SELECT COALESCE((
    SELECT selection.pathway_id
    FROM teras_enrollment_pathway_events selection
    WHERE selection.enrollment_id = NEW.enrollment_id
    ORDER BY selection.sequence DESC, selection.created_at DESC, selection.id DESC
    LIMIT 1
  ), enrollment.pathway_id)
  INTO effective_pathway_id
  FROM teras_enrollments enrollment
  WHERE enrollment.id = NEW.enrollment_id
  FOR UPDATE;

  IF effective_pathway_id IS NULL OR NEW.pathway_id <> effective_pathway_id THEN
    RAISE foreign_key_violation
      USING MESSAGE = format(
        'Resource progress context does not match active pathway for enrollment %s',
        NEW.enrollment_id
      ),
      CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS teras_learning_resource_progress_context_guard
  ON teras_learning_resource_progress;
CREATE TRIGGER teras_learning_resource_progress_context_guard
BEFORE INSERT OR UPDATE ON teras_learning_resource_progress
FOR EACH ROW EXECUTE FUNCTION teras_enforce_resource_progress_context();

COMMIT;