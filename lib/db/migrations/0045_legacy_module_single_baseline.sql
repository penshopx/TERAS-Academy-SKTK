DO $$
DECLARE
  duplicate_mappings text;
BEGIN
  IF to_regclass(current_schema() || '.teras_legacy_module_mappings') IS NULL THEN
    RETURN;
  END IF;

  SELECT string_agg(
    format('%s -> [%s]', duplicate.legacy_module_id, duplicate.baseline_module_ids),
    '; ' ORDER BY duplicate.legacy_module_id
  )
  INTO duplicate_mappings
  FROM (
    SELECT
      legacy_module_id,
      string_agg(DISTINCT baseline_module_id, ', ' ORDER BY baseline_module_id) AS baseline_module_ids
    FROM teras_legacy_module_mappings
    GROUP BY legacy_module_id
    HAVING count(DISTINCT baseline_module_id) > 1
  ) duplicate;

  IF duplicate_mappings IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one baseline target per legacy module; duplicate mappings: %',
      duplicate_mappings;
  END IF;
END $$;

DROP INDEX IF EXISTS teras_legacy_module_mappings_legacy_baseline_unique;
CREATE UNIQUE INDEX IF NOT EXISTS teras_legacy_module_mappings_legacy_unique
  ON teras_legacy_module_mappings (legacy_module_id);