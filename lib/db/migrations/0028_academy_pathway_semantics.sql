BEGIN;

ALTER TABLE teras_programs
  ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'Unspecified track';

ALTER TABLE teras_pathways
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'unspecified';

UPDATE teras_programs
SET
  domain = 'Solar PV',
  track = 'Solar PV Installation',
  name = 'Solar PV Installation',
  description = 'Capability development and pre-certification preparation for safe Solar PV installation.'
WHERE id = 'solar-pv-tech';

UPDATE teras_pathways
SET
  name = 'Path A — Capability Development',
  type = 'Capability',
  purpose = 'capability-development',
  outcome = 'Capability Achievement supported by a traceable Capability Portfolio'
WHERE id = 'path-a'
  AND program_id = 'solar-pv-tech';

UPDATE teras_pathways
SET
  name = 'Path B — Pre-Certification',
  type = 'Pre-Certification',
  purpose = 'pre-certification',
  outcome = 'Certification Readiness supported by a traceable Readiness Portfolio'
WHERE id = 'path-b'
  AND program_id = 'solar-pv-tech';

COMMIT;