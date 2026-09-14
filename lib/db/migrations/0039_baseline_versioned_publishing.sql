BEGIN;

-- Version rows are additive: the original baseline/module/catalogue records and
-- all learner event references remain addressable.
ALTER TABLE teras_learning_baselines
  ADD COLUMN IF NOT EXISTS published_version_id text;
ALTER TABLE teras_enrollments
  ADD COLUMN IF NOT EXISTS baseline_version_id text;
ALTER TABLE teras_enrollment_pathway_events
  ADD COLUMN IF NOT EXISTS baseline_version_id text;

CREATE TABLE IF NOT EXISTS teras_learning_baseline_versions (
  id text PRIMARY KEY,
  baseline_id text NOT NULL REFERENCES teras_learning_baselines(id),
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system',
  published_at timestamptz,
  published_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  CONSTRAINT teras_learning_baseline_versions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED'))
);
ALTER TABLE teras_learning_baseline_versions
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text;
CREATE UNIQUE INDEX IF NOT EXISTS teras_learning_baseline_versions_baseline_version_unique
  ON teras_learning_baseline_versions (baseline_id, version);
CREATE INDEX IF NOT EXISTS teras_learning_baseline_versions_baseline_published_idx
  ON teras_learning_baseline_versions (baseline_id, published_at);
ALTER TABLE teras_learning_baseline_versions
  DROP CONSTRAINT IF EXISTS teras_learning_baseline_versions_status_check;
ALTER TABLE teras_learning_baseline_versions
  ADD CONSTRAINT teras_learning_baseline_versions_status_check
  CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED'));

CREATE TABLE IF NOT EXISTS teras_learning_baseline_audit (
  id text PRIMARY KEY,
  baseline_id text NOT NULL REFERENCES teras_learning_baselines(id),
  version_id text REFERENCES teras_learning_baseline_versions(id),
  action text NOT NULL,
  actor_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
  ,updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE teras_learning_baseline_audit
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- The migration is safely rerunnable even after guards have been installed:
-- legacy materialization below uses published v1 INSERT ... ON CONFLICT and
-- must not be mistaken for a direct post-migration publication.
DROP TRIGGER IF EXISTS teras_baseline_version_immutable ON teras_learning_baseline_versions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_learning_baselines_published_version_fk'
      AND conrelid = 'teras_learning_baselines'::regclass) THEN
    ALTER TABLE teras_learning_baselines ADD CONSTRAINT teras_learning_baselines_published_version_fk
      FOREIGN KEY (published_version_id) REFERENCES teras_learning_baseline_versions(id);
  END IF;
END $$;

-- Existing installations receive one immutable v1 snapshot. It is deliberately
-- built from the current rows rather than replacing or rewriting those rows.
INSERT INTO teras_learning_baseline_versions
  (id, baseline_id, version, status, snapshot, created_by, published_at, published_by)
SELECT
  'baseline-version-' || b.id || '-1',
  b.id,
  1,
  'PUBLISHED',
  jsonb_build_object(
    'baseline', to_jsonb(b),
    'modules', COALESCE((
      SELECT jsonb_agg(to_jsonb(m) ORDER BY m.sequence, m.id)
      FROM teras_baseline_modules m WHERE m.baseline_id = b.id
    ), '[]'::jsonb),
    'selections', COALESCE((
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.pathway_id, s.sequence, s.id)
      FROM teras_pathway_baseline_modules s
      JOIN teras_baseline_modules sm ON sm.id = s.baseline_module_id
      WHERE sm.baseline_id = b.id
    ), '[]'::jsonb)
  ),
  COALESCE(b.created_by, 'migration-0039'),
  now(),
  COALESCE(b.created_by, 'migration-0039')
FROM teras_learning_baselines b
WHERE b.status IN ('active', 'published')
  AND NOT EXISTS (
    SELECT 1
    FROM teras_learning_baseline_versions existing
    WHERE existing.baseline_id = b.id AND existing.version = 1
  )
ON CONFLICT (baseline_id, version) DO NOTHING;

INSERT INTO teras_learning_baseline_audit
  (id, baseline_id, version_id, action, actor_id, details)
SELECT 'baseline-audit-' || v.id, v.baseline_id, v.id, 'MIGRATE_PUBLISH',
       v.created_by, jsonb_build_object('version', v.version)
FROM teras_learning_baseline_versions v
WHERE v.version = 1 AND v.status = 'PUBLISHED'
ON CONFLICT (id) DO NOTHING;

UPDATE teras_learning_baselines b
SET published_version_id = v.id
FROM teras_learning_baseline_versions v
WHERE v.baseline_id = b.id AND v.status = 'PUBLISHED'
  AND b.published_version_id IS NULL
  AND v.version = (SELECT min(v2.version) FROM teras_learning_baseline_versions v2
                   WHERE v2.baseline_id = b.id AND v2.status = 'PUBLISHED');

-- Pin existing enrolments and pathway decisions to v1. New decisions are
-- pinned by the selection service; no learner events/evidence are modified.
UPDATE teras_enrollments e
SET baseline_version_id = b.published_version_id
FROM teras_learning_baselines b
WHERE e.baseline_version_id IS NULL
  AND b.published_version_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM teras_pathway_baseline_modules ps
    JOIN teras_baseline_modules bm ON bm.id = ps.baseline_module_id
    WHERE ps.pathway_id = e.pathway_id AND bm.baseline_id = b.id
  );
-- This is a one-time metadata backfill for rows that predate version pins.
-- The history guard rejects every UPDATE by design, so suspend only that
-- trigger inside this transaction and restore it immediately afterward.
-- PostgreSQL rolls the trigger state back as well if any statement fails.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'teras_enrollment_pathway_events'::regclass
      AND tgname = 'teras_enrollment_pathway_history_guard'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE teras_enrollment_pathway_events
      DISABLE TRIGGER teras_enrollment_pathway_history_guard;
  END IF;
END $$;
UPDATE teras_enrollment_pathway_events e
SET baseline_version_id = v.id
FROM teras_learning_baseline_versions v
JOIN teras_learning_baselines b ON b.published_version_id = v.id
WHERE e.baseline_version_id IS NULL
  AND v.status = 'PUBLISHED'
  AND (
    v.snapshot -> 'selections' @> jsonb_build_array(jsonb_build_object('pathway_id', e.pathway_id))
    OR v.snapshot -> 'selections' @> jsonb_build_array(jsonb_build_object('pathwayId', e.pathway_id))
  );
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'teras_enrollment_pathway_events'::regclass
      AND tgname = 'teras_enrollment_pathway_history_guard'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE teras_enrollment_pathway_events
      ENABLE TRIGGER teras_enrollment_pathway_history_guard;
  END IF;
END $$;
-- Events that do not belong to the active snapshot's pathway remain unpinned
-- rather than inheriting the enrollment's original-pathway pin. This preserves
-- the event's own pathway semantics for a later explicit backfill.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_enrollments_baseline_version_fk'
      AND conrelid = 'teras_enrollments'::regclass) THEN
    ALTER TABLE teras_enrollments ADD CONSTRAINT teras_enrollments_baseline_version_fk
      FOREIGN KEY (baseline_version_id) REFERENCES teras_learning_baseline_versions(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_pathway_events_baseline_version_fk'
      AND conrelid = 'teras_enrollment_pathway_events'::regclass) THEN
    ALTER TABLE teras_enrollment_pathway_events ADD CONSTRAINT teras_pathway_events_baseline_version_fk
      FOREIGN KEY (baseline_version_id) REFERENCES teras_learning_baseline_versions(id);
  END IF;
END $$;

-- Published snapshots and audit history are append-only at the database
-- boundary, not merely by convention in the service.
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
  -- Draft content may be edited. Promotion must carry the exact draft
  -- snapshot through the status transition; it may not smuggle in a new
  -- snapshot as part of publication.
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
DROP TRIGGER IF EXISTS teras_baseline_version_immutable ON teras_learning_baseline_versions;
CREATE TRIGGER teras_baseline_version_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON teras_learning_baseline_versions
  FOR EACH ROW EXECUTE FUNCTION teras_reject_baseline_version_mutation();

CREATE OR REPLACE FUNCTION teras_validate_baseline_published_pointer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record;
BEGIN
  IF NEW.published_version_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT baseline_id, status INTO target
  FROM teras_learning_baseline_versions
  WHERE id = NEW.published_version_id;
  IF NOT FOUND OR target.baseline_id <> NEW.id OR target.status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'published_version_id must point to a published version of this baseline';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_baseline_published_pointer_guard ON teras_learning_baselines;
CREATE TRIGGER teras_baseline_published_pointer_guard
  BEFORE INSERT OR UPDATE OF published_version_id ON teras_learning_baselines
  FOR EACH ROW EXECUTE FUNCTION teras_validate_baseline_published_pointer();

CREATE OR REPLACE FUNCTION teras_reject_baseline_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'baseline audit is append-only';
END $$;
DROP TRIGGER IF EXISTS teras_baseline_audit_append_only ON teras_learning_baseline_audit;
CREATE TRIGGER teras_baseline_audit_append_only
  BEFORE UPDATE OR DELETE ON teras_learning_baseline_audit
  FOR EACH ROW EXECUTE FUNCTION teras_reject_baseline_audit_mutation();

COMMIT;