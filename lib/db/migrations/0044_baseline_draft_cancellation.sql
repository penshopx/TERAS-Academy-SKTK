BEGIN;

ALTER TABLE teras_learning_baseline_versions
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text;

ALTER TABLE teras_learning_baseline_versions
  DROP CONSTRAINT IF EXISTS teras_learning_baseline_versions_status_check;
ALTER TABLE teras_learning_baseline_versions
  ADD CONSTRAINT teras_learning_baseline_versions_status_check
  CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED'));

CREATE OR REPLACE FUNCTION teras_reject_baseline_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'PUBLISHED' THEN
      RAISE EXCEPTION 'published baseline versions must be promoted from a draft';
    END IF;
    IF NEW.status = 'DRAFT' AND (NEW.published_at IS NOT NULL OR NEW.published_by IS NOT NULL) THEN
      RAISE EXCEPTION 'draft baseline versions cannot have publication metadata';
    END IF;
    IF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL THEN
      RAISE EXCEPTION 'baseline cancellation metadata must be set by cancelling a draft';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('PUBLISHED', 'CANCELLED') THEN
      RAISE EXCEPTION 'terminal baseline snapshots are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.baseline_id IS DISTINCT FROM NEW.baseline_id
    OR OLD.version IS DISTINCT FROM NEW.version THEN
    RAISE EXCEPTION 'baseline version identity is immutable';
  END IF;
  IF OLD.status IN ('PUBLISHED', 'CANCELLED') THEN
    RAISE EXCEPTION 'terminal baseline snapshots are immutable';
  END IF;
  IF NEW.status = 'DRAFT' AND (NEW.published_at IS NOT NULL OR NEW.published_by IS NOT NULL) THEN
    RAISE EXCEPTION 'draft baseline versions cannot have publication metadata';
  END IF;
  IF NEW.status = 'DRAFT' AND (NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL) THEN
    RAISE EXCEPTION 'draft baseline versions cannot have cancellation metadata';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED'
    AND OLD.snapshot IS DISTINCT FROM NEW.snapshot THEN
    RAISE EXCEPTION 'baseline publication cannot mutate the draft snapshot';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'CANCELLED' THEN
    IF OLD.snapshot IS DISTINCT FROM NEW.snapshot
      OR NEW.published_at IS NOT NULL OR NEW.published_by IS NOT NULL
      OR NEW.cancelled_at IS NULL OR NEW.cancelled_by IS NULL THEN
      RAISE EXCEPTION 'baseline cancellation must preserve the draft and include cancellation metadata';
    END IF;
  ELSIF NEW.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'only drafts can be cancelled';
  END IF;
  IF NEW.status = 'PUBLISHED' AND (NEW.published_at IS NULL OR NEW.published_by IS NULL) THEN
    RAISE EXCEPTION 'published baseline versions require publication metadata';
  END IF;
  RETURN NEW;
END $$;

COMMIT;