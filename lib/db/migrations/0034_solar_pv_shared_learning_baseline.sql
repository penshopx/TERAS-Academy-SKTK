BEGIN;

-- A shared baseline activity is physically owned by Path A but may emit
-- pathway-scoped learner events for an explicitly selected Path B. The
-- learner/event pathway is therefore an authorization scope, not an LMS-row
-- ownership key.
ALTER TABLE IF EXISTS teras_learning_transition_events
  DROP CONSTRAINT IF EXISTS teras_learning_transition_activity_context_fk;
ALTER TABLE IF EXISTS teras_activity_completion_events
  DROP CONSTRAINT IF EXISTS teras_activity_completion_activity_pathway_fk;
ALTER TABLE IF EXISTS teras_outcome_verification_events
  DROP CONSTRAINT IF EXISTS teras_outcome_verification_activity_pathway_fk;

-- Task 49: establish the Solar PV M01-M10 catalogue as one shared baseline.
-- The legacy teras_modules rows and all learner event foreign keys remain
-- addressable; these tables add the canonical definition and pathway contracts.
CREATE TABLE IF NOT EXISTS teras_learning_baselines (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  version text NOT NULL DEFAULT '1.0',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system'
);
CREATE UNIQUE INDEX IF NOT EXISTS teras_learning_baselines_code_version_unique
  ON teras_learning_baselines (code, version);

CREATE TABLE IF NOT EXISTS teras_baseline_modules (
  id text PRIMARY KEY,
  baseline_id text NOT NULL REFERENCES teras_learning_baselines(id),
  module_id text NOT NULL REFERENCES teras_modules(id),
  sequence integer NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  learning_outcome text NOT NULL,
  evidence_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system'
);
CREATE UNIQUE INDEX IF NOT EXISTS teras_baseline_modules_baseline_sequence_unique
  ON teras_baseline_modules (baseline_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS teras_baseline_modules_baseline_code_unique
  ON teras_baseline_modules (baseline_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS teras_baseline_modules_module_unique
  ON teras_baseline_modules (module_id);

CREATE TABLE IF NOT EXISTS teras_pathway_baseline_modules (
  id text PRIMARY KEY,
  pathway_id text NOT NULL REFERENCES teras_pathways(id),
  baseline_module_id text NOT NULL REFERENCES teras_baseline_modules(id),
  sequence integer NOT NULL,
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system'
);
CREATE UNIQUE INDEX IF NOT EXISTS teras_pathway_baseline_modules_pathway_module_unique
  ON teras_pathway_baseline_modules (pathway_id, baseline_module_id);
CREATE UNIQUE INDEX IF NOT EXISTS teras_pathway_baseline_modules_pathway_sequence_unique
  ON teras_pathway_baseline_modules (pathway_id, sequence);

CREATE TABLE IF NOT EXISTS teras_pathway_module_contracts (
  id text PRIMARY KEY,
  pathway_id text NOT NULL REFERENCES teras_pathways(id),
  module_id text NOT NULL REFERENCES teras_modules(id),
  assessment text NOT NULL,
  evidence text NOT NULL,
  output text NOT NULL,
  kpi text NOT NULL,
  portfolio text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system'
);
CREATE UNIQUE INDEX IF NOT EXISTS teras_pathway_module_contracts_pathway_module_unique
  ON teras_pathway_module_contracts (pathway_id, module_id);

ALTER TABLE teras_pathway_module_contracts
  ADD COLUMN IF NOT EXISTS assessment_id text,
  ADD COLUMN IF NOT EXISTS evidence_requirement_id text,
  ADD COLUMN IF NOT EXISTS gate_code text;
UPDATE teras_pathway_module_contracts
SET assessment_id = 'assessment-' || module_id,
    evidence_requirement_id = 'req-' || module_id,
    gate_code = CASE
      WHEN pathway_id = 'path-a' AND module_id IN ('m01','m02','m03') THEN 'G1'
      WHEN pathway_id = 'path-a' AND module_id IN ('m04','m05','m06','m07') THEN 'G2'
      WHEN pathway_id = 'path-a' AND module_id IN ('m08','m09','m10') THEN 'G3'
      WHEN pathway_id = 'path-b' AND module_id IN ('m01','m02','m03') THEN 'B1'
      WHEN pathway_id = 'path-b' AND module_id IN ('m04','m05','m06','m07') THEN 'B2'
      WHEN pathway_id = 'path-b' AND module_id IN ('m08','m09') THEN 'B3'
      WHEN pathway_id = 'path-b' AND module_id = 'm10' THEN 'B4'
      ELSE gate_code
    END
WHERE assessment_id IS NULL OR evidence_requirement_id IS NULL OR gate_code IS NULL;
ALTER TABLE teras_pathway_module_contracts
  ALTER COLUMN assessment_id SET NOT NULL,
  ALTER COLUMN evidence_requirement_id SET NOT NULL,
  ALTER COLUMN gate_code SET NOT NULL;

CREATE TABLE IF NOT EXISTS teras_legacy_module_mappings (
  id text PRIMARY KEY,
  legacy_module_id text NOT NULL REFERENCES teras_modules(id),
  baseline_module_id text NOT NULL REFERENCES teras_baseline_modules(id),
  pathway_id text NOT NULL REFERENCES teras_pathways(id),
  status text NOT NULL DEFAULT 'retired',
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system'
);
CREATE UNIQUE INDEX IF NOT EXISTS teras_legacy_module_mappings_legacy_baseline_unique
  ON teras_legacy_module_mappings (legacy_module_id, baseline_module_id);

INSERT INTO teras_learning_baselines
  (id, code, name, description, version, status, created_by)
VALUES
  ('baseline-solar-pv-v1', 'SOLAR-PV-BASELINE', 'Solar PV Learning Baseline',
   'Shared M01-M10 Solar PV learning baseline used by Path A and Path B.', '1.0', 'active',
   'migration-0034')
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code, name = EXCLUDED.name, description = EXCLUDED.description,
  version = EXCLUDED.version, status = EXCLUDED.status, updated_at = now();

-- Canonicalise existing M rows without changing their stable IDs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'teras_modules'
      AND column_name IN ('sequence', 'code', 'name', 'capability', 'learning_outcomes', 'evidence', 'theory')
    GROUP BY table_name
      HAVING count(*) = 7
  ) THEN
    WITH canonical(sequence, code, name, outcome, evidence_id, capability) AS (
  VALUES
    (1,'M01','Fundamentals','Explain PV principles, terminology, and system purpose.','E01','PV principles and terminology'),
    (2,'M02','Measurement & Interpretation','Measure and interpret site and system data to identify relevant PV conditions.','E02','Measurement and data interpretation'),
    (3,'M03','Safety & Work Practice','Apply safe work practices, isolation, and risk controls for PV work.','E03','Safe PV work practice'),
    (4,'M04','System Architecture','Describe PV system architecture and explain component interfaces.','E04','PV system architecture'),
    (5,'M05','Drawing & Work Preparation','Produce accurate drawings and work preparation records for PV installation.','E05','Drawing and work preparation'),
    (6,'M06','Mechanical Installation','Install and secure PV mechanical components in accordance with drawings and manufacturer requirements.','E06','PV mechanical installation'),
    (7,'M07','Electrical Installation','Install PV electrical components, cabling, protection, and terminations safely.','E07','PV electrical installation'),
    (8,'M08','System Configuration & Integration','Configure and integrate inverter, monitoring, and system controls.','E08','PV system configuration and integration'),
    (9,'M09','Testing & Commissioning','Test, commission, and document PV system performance and safety.','E09','PV testing and commissioning'),
    (10,'M10','O&M & Basic Troubleshooting','Perform routine O&M and basic troubleshooting using safe diagnostic steps.','E10','PV O&M and basic troubleshooting')
    )
    UPDATE teras_modules m
    SET sequence = c.sequence, code = c.code, name = c.name, capability = c.capability,
        learning_outcomes = ARRAY[c.outcome], evidence = c.evidence_id,
        theory = ARRAY[c.name || ' guide']
    FROM canonical c
    WHERE m.id = lower(c.code);
  END IF;
END $$;

-- Evidence requirement IDs are stable contract identifiers, while the legacy
-- requirement row IDs remain unchanged for learner/history references.
DO $$
BEGIN
  IF to_regclass(current_schema() || '.teras_evidence_requirements') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'teras_evidence_requirements'
        AND column_name IN ('module_id', 'code', 'name', 'description')
      GROUP BY table_name
      HAVING count(*) = 4
    ) THEN
    UPDATE teras_evidence_requirements req
    SET code = canonical.evidence_id,
        name = canonical.evidence_id || ' — ' || canonical.name || ' evidence',
        description = 'Traceable evidence demonstrating the controlled outcome: ' || canonical.outcome
    FROM (VALUES
      ('m01','M01','Fundamentals','Explain PV principles, terminology, and system purpose.','E01'),
      ('m02','M02','Measurement & Interpretation','Measure and interpret site and system data to identify relevant PV conditions.','E02'),
      ('m03','M03','Safety & Work Practice','Apply safe work practices, isolation, and risk controls for PV work.','E03'),
      ('m04','M04','System Architecture','Describe PV system architecture and explain component interfaces.','E04'),
      ('m05','M05','Drawing & Work Preparation','Produce accurate drawings and work preparation records for PV installation.','E05'),
      ('m06','M06','Mechanical Installation','Install and secure PV mechanical components in accordance with drawings and manufacturer requirements.','E06'),
      ('m07','M07','Electrical Installation','Install PV electrical components, cabling, protection, and terminations safely.','E07'),
      ('m08','M08','System Configuration & Integration','Configure and integrate inverter, monitoring, and system controls.','E08'),
      ('m09','M09','Testing & Commissioning','Test, commission, and document PV system performance and safety.','E09'),
      ('m10','M10','O&M & Basic Troubleshooting','Perform routine O&M and basic troubleshooting using safe diagnostic steps.','E10')
    ) canonical(module_id, code, name, outcome, evidence_id)
    WHERE req.module_id = canonical.module_id;
  END IF;
END $$;

WITH canonical(code, name, outcome, evidence_id) AS (
  VALUES
    ('M01','Fundamentals','Explain PV principles, terminology, and system purpose.','E01'),
    ('M02','Measurement & Interpretation','Measure and interpret site and system data to identify relevant PV conditions.','E02'),
    ('M03','Safety & Work Practice','Apply safe work practices, isolation, and risk controls for PV work.','E03'),
    ('M04','System Architecture','Describe PV system architecture and explain component interfaces.','E04'),
    ('M05','Drawing & Work Preparation','Produce accurate drawings and work preparation records for PV installation.','E05'),
    ('M06','Mechanical Installation','Install and secure PV mechanical components in accordance with drawings and manufacturer requirements.','E06'),
    ('M07','Electrical Installation','Install PV electrical components, cabling, protection, and terminations safely.','E07'),
    ('M08','System Configuration & Integration','Configure and integrate inverter, monitoring, and system controls.','E08'),
    ('M09','Testing & Commissioning','Test, commission, and document PV system performance and safety.','E09'),
    ('M10','O&M & Basic Troubleshooting','Perform routine O&M and basic troubleshooting using safe diagnostic steps.','E10')
)
INSERT INTO teras_baseline_modules
  (id, baseline_id, module_id, sequence, code, name, learning_outcome, evidence_id, status, created_by)
SELECT 'baseline-module-' || lower(c.code), 'baseline-solar-pv-v1', m.id,
       row_number() OVER (ORDER BY c.code)::integer, c.code, c.name, c.outcome, c.evidence_id,
       'active', 'migration-0034'
FROM canonical c
JOIN teras_modules m ON m.id = lower(c.code)
ON CONFLICT (id) DO UPDATE SET
  module_id = EXCLUDED.module_id, sequence = EXCLUDED.sequence, code = EXCLUDED.code,
  name = EXCLUDED.name, learning_outcome = EXCLUDED.learning_outcome,
  evidence_id = EXCLUDED.evidence_id, status = EXCLUDED.status, updated_at = now();

-- The same ten baseline records are selected by both pathways.
INSERT INTO teras_pathway_baseline_modules
  (id, pathway_id, baseline_module_id, sequence, required, status, created_by)
SELECT 'pathway-' || p.id || '-baseline-' || bm.code, p.id, bm.id, bm.sequence,
       true, 'active', 'migration-0034'
FROM (VALUES ('path-a'), ('path-b')) p(id)
JOIN teras_baseline_modules bm ON bm.baseline_id = 'baseline-solar-pv-v1'
JOIN teras_pathways path ON path.id = p.id
ON CONFLICT (id) DO UPDATE SET
  pathway_id = EXCLUDED.pathway_id, baseline_module_id = EXCLUDED.baseline_module_id,
  sequence = EXCLUDED.sequence, required = EXCLUDED.required, status = EXCLUDED.status,
  updated_at = now();

-- Pathway contract is intentionally different even though the baseline outcome
-- and evidence ID are shared.
INSERT INTO teras_pathway_module_contracts
  (id, pathway_id, module_id, assessment_id, evidence_requirement_id, gate_code, assessment, evidence, output, kpi, portfolio, created_by)
SELECT 'contract-' || p.id || '-' || bm.code, p.id, bm.module_id,
       'assessment-' || bm.module_id,
       'req-' || bm.module_id,
       CASE
         WHEN p.id = 'path-a' AND bm.code IN ('M01','M02','M03') THEN 'G1'
         WHEN p.id = 'path-a' AND bm.code IN ('M04','M05','M06','M07') THEN 'G2'
         WHEN p.id = 'path-a' THEN 'G3'
         WHEN p.id = 'path-b' AND bm.code IN ('M01','M02','M03') THEN 'B1'
         WHEN p.id = 'path-b' AND bm.code IN ('M04','M05','M06','M07') THEN 'B2'
         WHEN p.id = 'path-b' AND bm.code IN ('M08','M09') THEN 'B3'
         ELSE 'B4'
       END,
       CASE WHEN p.id = 'path-a' THEN 'Observed capability assessment'
            ELSE 'Pre-certification readiness assessment' END,
       bm.evidence_id || ' — baseline evidence requirement',
       CASE WHEN p.id = 'path-a' THEN 'Capability Portfolio entry'
            ELSE 'Certification Readiness Portfolio entry' END,
       CASE WHEN p.id = 'path-a' THEN 'capability achievement'
            ELSE 'readiness' END,
       CASE WHEN p.id = 'path-a' THEN 'Capability Portfolio'
            ELSE 'Certification Readiness Portfolio' END,
       'migration-0034'
FROM (VALUES ('path-a'), ('path-b')) p(id)
JOIN teras_pathways path ON path.id = p.id
JOIN teras_baseline_modules bm ON bm.baseline_id = 'baseline-solar-pv-v1'
ON CONFLICT (id) DO UPDATE SET
  assessment_id = EXCLUDED.assessment_id, evidence_requirement_id = EXCLUDED.evidence_requirement_id,
  gate_code = EXCLUDED.gate_code,
  assessment = EXCLUDED.assessment, evidence = EXCLUDED.evidence,
  output = EXCLUDED.output, kpi = EXCLUDED.kpi, portfolio = EXCLUDED.portfolio,
  updated_at = now();

-- Retain B01-B08 as retired, addressable compatibility records.
WITH mapping(legacy_code, baseline_code) AS (
  VALUES ('B01','M05'),('B02','M02'),('B03','M04'),('B04','M07'),
         ('B05','M06'),('B06','M08'),('B07','M09'),('B08','M10')
)
INSERT INTO teras_legacy_module_mappings
  (id, legacy_module_id, baseline_module_id, pathway_id, status, note, created_by)
SELECT 'legacy-map-' || lower(x.legacy_code), legacy.id, baseline.id, 'path-b',
       'retired', 'Legacy Path B catalogue record retained for historical learner references.',
       'migration-0034'
FROM mapping x
JOIN teras_modules legacy ON legacy.id = lower(x.legacy_code)
JOIN teras_baseline_modules baseline ON baseline.code = x.baseline_code
ON CONFLICT (id) DO UPDATE SET
  legacy_module_id = EXCLUDED.legacy_module_id, baseline_module_id = EXCLUDED.baseline_module_id,
  pathway_id = EXCLUDED.pathway_id, status = EXCLUDED.status, note = EXCLUDED.note,
  updated_at = now();

-- Earlier catalogue seeds briefly materialised M01-M10 below the Path B
-- course. Retain those IDs for audit/history but retire the duplicate rows;
-- Path B now reads the Path A-owned common hierarchy via its selections.
DO $$
BEGIN
  IF to_regclass(current_schema() || '.teras_course_modules') IS NOT NULL
    AND to_regclass(current_schema() || '.teras_lessons') IS NOT NULL
    AND to_regclass(current_schema() || '.teras_learning_activities') IS NOT NULL
    AND to_regclass(current_schema() || '.teras_content_resources') IS NOT NULL
    AND to_regclass(current_schema() || '.teras_learning_outcomes') IS NOT NULL THEN
    UPDATE teras_content_resources resource
    SET status = 'ARCHIVED'
    FROM teras_learning_activities activity
    JOIN teras_lessons lesson ON lesson.id = activity.lesson_id
    JOIN teras_course_modules link ON link.id = lesson.course_module_id
    WHERE resource.activity_id = activity.id
      AND link.pathway_id = 'path-b'
      AND link.id LIKE 'course-module-m%-path-b';
    UPDATE teras_learning_outcomes outcome
    SET status = 'ARCHIVED'
    FROM teras_learning_activities activity
    JOIN teras_lessons lesson ON lesson.id = activity.lesson_id
    JOIN teras_course_modules link ON link.id = lesson.course_module_id
    WHERE outcome.activity_id = activity.id
      AND link.pathway_id = 'path-b'
      AND link.id LIKE 'course-module-m%-path-b';
    UPDATE teras_learning_activities activity
    SET status = 'ARCHIVED'
    FROM teras_lessons lesson
    JOIN teras_course_modules link ON link.id = lesson.course_module_id
    WHERE activity.lesson_id = lesson.id
      AND link.pathway_id = 'path-b'
      AND link.id LIKE 'course-module-m%-path-b';
    UPDATE teras_lessons lesson
    SET status = 'ARCHIVED'
    FROM teras_course_modules link
    WHERE lesson.course_module_id = link.id
      AND link.pathway_id = 'path-b'
      AND link.id LIKE 'course-module-m%-path-b';
    UPDATE teras_course_modules
    SET status = 'ARCHIVED'
    WHERE pathway_id = 'path-b' AND id LIKE 'course-module-m%-path-b';
  END IF;
END $$;

COMMIT;