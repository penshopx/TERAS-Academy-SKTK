#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO teras_people (id, name, initials, email, role, status, created_by)
VALUES ('baseline-integration-person-1', 'Baseline Integration One', 'BI', 'baseline-integration-1@example.test', 'trainer', 'active', 'integration'),
       ('baseline-integration-person-2', 'Baseline Integration Two', 'BJ', 'baseline-integration-2@example.test', 'learner', 'active', 'integration'),
       ('baseline-integration-person-3', 'Baseline Integration Three', 'BK', 'baseline-integration-3@example.test', 'learner', 'active', 'integration')
ON CONFLICT (id) DO NOTHING;
INSERT INTO teras_person_roles (person_id, role, created_by)
VALUES ('baseline-integration-person-1', 'trainer', 'integration')
ON CONFLICT DO NOTHING;
INSERT INTO teras_programs (id, domain, track, name, description, status, created_by)
VALUES ('baseline-integration-program', 'Integration', 'Integration', 'Integration program', 'Integration program', 'active', 'integration')
ON CONFLICT (id) DO NOTHING;
INSERT INTO teras_pathways (id, program_id, name, type, purpose, outcome, status, created_by)
VALUES ('baseline-integration-pathway', 'baseline-integration-program', 'Integration pathway', 'Primary', 'unspecified', 'Integration outcome', 'active', 'integration')
ON CONFLICT (id) DO NOTHING;
INSERT INTO teras_pathways (id, program_id, name, type, purpose, outcome, status, created_by)
VALUES ('baseline-integration-owner-pathway', 'baseline-integration-program', 'Shared module owner', 'Secondary', 'unspecified', 'Shared ownership', 'active', 'integration')
ON CONFLICT (id) DO NOTHING;
INSERT INTO teras_modules
  (id, program_id, pathway_id, sequence, code, name, capability, evidence, learning_outcomes, theory, created_by)
VALUES ('baseline-integration-module', 'baseline-integration-program', 'baseline-integration-pathway', 1, 'INT-M01',
        'Integration module', 'Integration capability', 'Integration evidence', ARRAY['Integration outcome'], ARRAY['Integration theory'], 'integration')
ON CONFLICT (id) DO NOTHING;
INSERT INTO teras_modules
  (id, program_id, pathway_id, sequence, code, name, capability, evidence, learning_outcomes, theory, created_by)
VALUES ('baseline-integration-module-v2', 'baseline-integration-program', 'baseline-integration-owner-pathway', 2, 'INT-M02',
        'Integration module v2', 'Integration capability v2', 'Integration evidence v2', ARRAY['Integration outcome v2'], ARRAY['Integration theory v2'], 'integration')
ON CONFLICT (id) DO NOTHING;
INSERT INTO teras_assessments (id, module_id, name, gate_code, created_by)
VALUES ('baseline-integration-assessment-v2', 'baseline-integration-module-v2', 'Integration assessment v2', 'INT-G2', 'integration')
ON CONFLICT (id) DO NOTHING;
INSERT INTO teras_evidence_requirements (id, module_id, code, name, description, allowed_types, created_by)
VALUES ('baseline-integration-evidence-v2', 'baseline-integration-module-v2', 'INT-E2', 'Integration evidence v2', 'Integration evidence requirement', ARRAY['document'], 'integration')
ON CONFLICT (id) DO NOTHING;
INSERT INTO teras_learning_baselines
  (id, code, name, description, version, status, created_by)
SELECT 'baseline-integration', 'INTEGRATION', 'Integration baseline',
       'Integration baseline fixture', '1.0', 'active', 'integration'
WHERE NOT EXISTS (SELECT 1 FROM teras_learning_baselines WHERE id = 'baseline-integration');
INSERT INTO teras_baseline_modules
  (id, baseline_id, module_id, sequence, code, name, learning_outcome, evidence_id, status, created_by)
SELECT 'baseline-module-integration', 'baseline-integration', m.id, 1, 'M01',
       m.name, m.capability, 'E01', 'active', 'integration'
FROM teras_modules m
WHERE m.id = 'baseline-integration-module'
  AND NOT EXISTS (SELECT 1 FROM teras_baseline_modules WHERE id = 'baseline-module-integration');
INSERT INTO teras_baseline_modules
  (id, baseline_id, module_id, sequence, code, name, learning_outcome, evidence_id, status, created_by)
SELECT 'baseline-module-integration-v2', 'baseline-integration', m.id, 2, 'M02',
       m.name, m.capability, 'E02', 'active', 'integration'
FROM teras_modules m
WHERE m.id = 'baseline-integration-module-v2'
  AND NOT EXISTS (SELECT 1 FROM teras_baseline_modules WHERE id = 'baseline-module-integration-v2');
INSERT INTO teras_pathway_baseline_modules
  (id, pathway_id, baseline_module_id, sequence, required, status, created_by)
SELECT 'pathway-baseline-module-integration', p.id, 'baseline-module-integration', 1, true, 'active', 'integration'
FROM teras_pathways p
WHERE NOT EXISTS (SELECT 1 FROM teras_pathway_baseline_modules WHERE id = 'pathway-baseline-module-integration')
  AND p.id = 'baseline-integration-pathway';
SQL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$repo_root/lib/db/migrations/0039_baseline_versioned_publishing.sql" >/dev/null