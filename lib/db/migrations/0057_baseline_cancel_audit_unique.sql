BEGIN;

-- Audit rows are append-only. Never silently discard an existing duplicate:
-- stop the upgrade so an operator can investigate the conflicting history.
DO $$
DECLARE
  duplicate_version_id text;
BEGIN
  SELECT version_id INTO duplicate_version_id
  FROM teras_learning_baseline_audit
  WHERE action = 'CANCEL_DRAFT' AND version_id IS NOT NULL
  GROUP BY version_id
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF duplicate_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate CANCEL_DRAFT audits for version_id %; resolve conflicting audit history before upgrading', duplicate_version_id;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS teras_learning_baseline_audit_cancel_version_unique
  ON teras_learning_baseline_audit (version_id)
  WHERE action = 'CANCEL_DRAFT';

COMMIT;