BEGIN;

CREATE TABLE IF NOT EXISTS teras_learning_baseline_pathway_scopes (
  baseline_id text NOT NULL REFERENCES teras_learning_baselines(id),
  pathway_id text NOT NULL,
  version_count integer NOT NULL,
  CONSTRAINT teras_learning_baseline_pathway_scopes_version_count_check CHECK (version_count > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS teras_learning_baseline_pathway_scopes_unique
  ON teras_learning_baseline_pathway_scopes (baseline_id, pathway_id);

INSERT INTO teras_learning_baseline_pathway_scopes (baseline_id, pathway_id, version_count)
SELECT version_row.baseline_id, selection.pathway_id, COUNT(*)::integer
FROM teras_learning_baseline_versions AS version_row
CROSS JOIN LATERAL (
  SELECT DISTINCT COALESCE(item->>'pathwayId', item->>'pathway_id') AS pathway_id
  FROM jsonb_array_elements(COALESCE(version_row.snapshot->'selections', '[]'::jsonb)) AS item
) AS selection
WHERE selection.pathway_id IS NOT NULL AND selection.pathway_id <> ''
GROUP BY version_row.baseline_id, selection.pathway_id
ON CONFLICT (baseline_id, pathway_id) DO UPDATE
SET version_count = EXCLUDED.version_count;

CREATE OR REPLACE FUNCTION teras_adjust_baseline_pathway_scope(
  target_baseline_id text,
  target_snapshot jsonb,
  adjustment integer
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF adjustment > 0 THEN
    INSERT INTO teras_learning_baseline_pathway_scopes (baseline_id, pathway_id, version_count)
    SELECT target_baseline_id, selection.pathway_id, adjustment
    FROM (
      SELECT DISTINCT COALESCE(item->>'pathwayId', item->>'pathway_id') AS pathway_id
      FROM jsonb_array_elements(COALESCE(target_snapshot->'selections', '[]'::jsonb)) AS item
    ) AS selection
    WHERE selection.pathway_id IS NOT NULL AND selection.pathway_id <> ''
    ON CONFLICT (baseline_id, pathway_id) DO UPDATE
    SET version_count = teras_learning_baseline_pathway_scopes.version_count + EXCLUDED.version_count;
  ELSE
    DELETE FROM teras_learning_baseline_pathway_scopes AS scope
    USING (
      SELECT DISTINCT COALESCE(item->>'pathwayId', item->>'pathway_id') AS pathway_id
      FROM jsonb_array_elements(COALESCE(target_snapshot->'selections', '[]'::jsonb)) AS item
    ) AS selection
    WHERE scope.baseline_id = target_baseline_id
      AND scope.pathway_id = selection.pathway_id
      AND scope.version_count = 1;

    UPDATE teras_learning_baseline_pathway_scopes AS scope
    SET version_count = scope.version_count + adjustment
    FROM (
      SELECT DISTINCT COALESCE(item->>'pathwayId', item->>'pathway_id') AS pathway_id
      FROM jsonb_array_elements(COALESCE(target_snapshot->'selections', '[]'::jsonb)) AS item
    ) AS selection
    WHERE scope.baseline_id = target_baseline_id
      AND scope.pathway_id = selection.pathway_id
      AND scope.version_count > 1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION teras_sync_baseline_pathway_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM teras_adjust_baseline_pathway_scope(NEW.baseline_id, NEW.snapshot, 1);
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM teras_adjust_baseline_pathway_scope(OLD.baseline_id, OLD.snapshot, -1);
    RETURN OLD;
  END IF;
  PERFORM teras_adjust_baseline_pathway_scope(OLD.baseline_id, OLD.snapshot, -1);
  PERFORM teras_adjust_baseline_pathway_scope(NEW.baseline_id, NEW.snapshot, 1);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS teras_baseline_pathway_scope_sync ON teras_learning_baseline_versions;
CREATE TRIGGER teras_baseline_pathway_scope_sync
AFTER INSERT OR DELETE OR UPDATE OF snapshot, baseline_id
ON teras_learning_baseline_versions
FOR EACH ROW EXECUTE FUNCTION teras_sync_baseline_pathway_scope();

CREATE INDEX IF NOT EXISTS teras_learning_baseline_versions_draft_baseline_idx
  ON teras_learning_baseline_versions (baseline_id)
  WHERE status = 'DRAFT';

COMMIT;