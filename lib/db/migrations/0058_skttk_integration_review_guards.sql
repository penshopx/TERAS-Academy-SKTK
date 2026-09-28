BEGIN;

ALTER TABLE teras_competency_unit_outcomes ADD COLUMN IF NOT EXISTS kuk_id text REFERENCES teras_competency_kuks(id);
ALTER TABLE teras_competency_unit_practice_tasks ADD COLUMN IF NOT EXISTS kuk_id text REFERENCES teras_competency_kuks(id);
ALTER TABLE teras_competency_unit_evidence_requirements ADD COLUMN IF NOT EXISTS kuk_id text REFERENCES teras_competency_kuks(id);
ALTER TABLE teras_diagnostic_questions ADD COLUMN IF NOT EXISTS kuk_id text REFERENCES teras_competency_kuks(id);

-- Existing drafts remain editable, but cannot become published diagnostic content.
-- A framework identity is a versioned record: create a new row for a new version.
CREATE OR REPLACE FUNCTION teras_guard_framework_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.code, NEW.version) IS DISTINCT FROM (OLD.code, OLD.version) THEN
    RAISE EXCEPTION 'framework code and version are immutable; create a new version';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_framework_identity_guard ON teras_competency_frameworks;
CREATE TRIGGER teras_framework_identity_guard BEFORE UPDATE OF code, version
ON teras_competency_frameworks FOR EACH ROW EXECUTE FUNCTION teras_guard_framework_identity();

CREATE OR REPLACE FUNCTION teras_guard_framework_source_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM teras_competency_frameworks
             WHERE id = OLD.framework_id AND authority_status = 'AUTHORITATIVE')
     AND OLD.provenance_type = 'AUTHORITATIVE'
     AND NOT EXISTS (
       SELECT 1 FROM teras_competency_framework_sources s
       JOIN teras_regulatory_references r ON r.id = s.regulatory_reference_id
       WHERE s.framework_id = OLD.framework_id AND s.id <> OLD.id
         AND s.provenance_type = 'AUTHORITATIVE'
         AND r.authority_role = 'DOMAIN_AUTHORITY' AND r.status = 'ACTIVE'
     ) THEN
    RAISE EXCEPTION 'cannot remove the last active domain authority of an authoritative framework';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS teras_framework_source_removal_guard ON teras_competency_framework_sources;
CREATE TRIGGER teras_framework_source_removal_guard BEFORE DELETE
ON teras_competency_framework_sources FOR EACH ROW EXECUTE FUNCTION teras_guard_framework_source_removal();
CREATE OR REPLACE FUNCTION teras_guard_framework_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.framework_id, NEW.regulatory_reference_id, NEW.provenance_type)
     IS DISTINCT FROM (OLD.framework_id, OLD.regulatory_reference_id, OLD.provenance_type)
     AND EXISTS (SELECT 1 FROM teras_competency_frameworks
                 WHERE id = OLD.framework_id AND authority_status = 'AUTHORITATIVE') THEN
    RAISE EXCEPTION 'authoritative framework sources are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_framework_source_change_guard ON teras_competency_framework_sources;
CREATE TRIGGER teras_framework_source_change_guard BEFORE UPDATE
ON teras_competency_framework_sources FOR EACH ROW EXECUTE FUNCTION teras_guard_framework_source_change();

CREATE OR REPLACE FUNCTION teras_guard_unit_framework() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.framework_id IS DISTINCT FROM OLD.framework_id THEN
    RAISE EXCEPTION 'unit framework is immutable; create a new unit in the new version';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_unit_framework_guard ON teras_competency_units;
CREATE TRIGGER teras_unit_framework_guard BEFORE UPDATE OF framework_id
ON teras_competency_units FOR EACH ROW EXECUTE FUNCTION teras_guard_unit_framework();

CREATE OR REPLACE FUNCTION teras_guard_framework_downgrade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.authority_status = 'AUTHORITATIVE' AND NEW.authority_status <> 'AUTHORITATIVE'
    AND EXISTS (SELECT 1 FROM teras_diagnostic_templates
                WHERE framework_id = OLD.id AND status = 'active') THEN
    RAISE EXCEPTION 'unpublish active diagnostic templates before downgrading authority';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_framework_downgrade_guard ON teras_competency_frameworks;
CREATE TRIGGER teras_framework_downgrade_guard BEFORE UPDATE OF authority_status
ON teras_competency_frameworks FOR EACH ROW EXECUTE FUNCTION teras_guard_framework_downgrade();

CREATE OR REPLACE FUNCTION teras_guard_competency_edge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_pathway text;
BEGIN
  IF NEW.kuk_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM teras_competency_kuks k
    JOIN teras_competency_elements e ON e.id = k.element_id
    WHERE k.id = NEW.kuk_id AND e.unit_id = NEW.unit_id
  ) THEN
    RAISE EXCEPTION 'mapped KUK must belong to the competency unit';
  END IF;
  IF TG_TABLE_NAME = 'teras_competency_unit_outcomes' THEN
    IF NEW.learning_outcome_id IS NOT NULL THEN
      SELECT a.pathway_id INTO target_pathway FROM teras_learning_outcomes o
        JOIN teras_learning_activities a ON a.id = o.activity_id
        WHERE o.id = NEW.learning_outcome_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'teras_competency_unit_practice_tasks' THEN
    SELECT m.pathway_id INTO target_pathway FROM teras_practice_tasks t
      JOIN teras_modules m ON m.id = t.module_id WHERE t.id = NEW.task_id;
  ELSIF TG_TABLE_NAME = 'teras_competency_unit_evidence_requirements' THEN
    SELECT m.pathway_id INTO target_pathway FROM teras_evidence_requirements e
      JOIN teras_modules m ON m.id = e.module_id WHERE e.id = NEW.requirement_id;
  END IF;
  IF target_pathway IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM teras_pathway_competency_units p
    WHERE p.unit_id = NEW.unit_id AND p.pathway_id = target_pathway
  ) THEN
    RAISE EXCEPTION 'competency mapping target must belong to the unit pathway';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_outcome_scope_guard ON teras_competency_unit_outcomes;
CREATE TRIGGER teras_outcome_scope_guard BEFORE INSERT OR UPDATE ON teras_competency_unit_outcomes
FOR EACH ROW EXECUTE FUNCTION teras_guard_competency_edge();
DROP TRIGGER IF EXISTS teras_practice_scope_guard ON teras_competency_unit_practice_tasks;
CREATE TRIGGER teras_practice_scope_guard BEFORE INSERT OR UPDATE ON teras_competency_unit_practice_tasks
FOR EACH ROW EXECUTE FUNCTION teras_guard_competency_edge();
DROP TRIGGER IF EXISTS teras_evidence_scope_guard ON teras_competency_unit_evidence_requirements;
CREATE TRIGGER teras_evidence_scope_guard BEFORE INSERT OR UPDATE ON teras_competency_unit_evidence_requirements
FOR EACH ROW EXECUTE FUNCTION teras_guard_competency_edge();

-- Deferred checks permit the existing PATCH replace-all mapping transaction, while
-- rejecting a committed orphan if an assignment or target's pathway changes.
CREATE OR REPLACE FUNCTION teras_check_competency_scope_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM teras_competency_unit_practice_tasks link
    JOIN teras_practice_tasks task ON task.id = link.task_id
    JOIN teras_modules module ON module.id = task.module_id
    WHERE (TG_TABLE_NAME = 'teras_pathway_competency_units' AND link.unit_id = (to_jsonb(OLD)->>'unit_id')
       OR TG_TABLE_NAME = 'teras_modules' AND module.id = OLD.id
       OR TG_TABLE_NAME = 'teras_practice_tasks' AND task.id = OLD.id)
      AND NOT EXISTS (SELECT 1 FROM teras_pathway_competency_units p
                      WHERE p.unit_id = link.unit_id AND p.pathway_id = module.pathway_id)
  ) OR EXISTS (
    SELECT 1 FROM teras_competency_unit_evidence_requirements link
    JOIN teras_evidence_requirements requirement ON requirement.id = link.requirement_id
    JOIN teras_modules module ON module.id = requirement.module_id
    WHERE (TG_TABLE_NAME = 'teras_pathway_competency_units' AND link.unit_id = (to_jsonb(OLD)->>'unit_id')
       OR TG_TABLE_NAME = 'teras_modules' AND module.id = OLD.id
       OR TG_TABLE_NAME = 'teras_evidence_requirements' AND requirement.id = OLD.id)
      AND NOT EXISTS (SELECT 1 FROM teras_pathway_competency_units p
                      WHERE p.unit_id = link.unit_id AND p.pathway_id = module.pathway_id)
  ) OR EXISTS (
    SELECT 1 FROM teras_competency_unit_outcomes link
    JOIN teras_learning_outcomes outcome ON outcome.id = link.learning_outcome_id
    JOIN teras_learning_activities activity ON activity.id = outcome.activity_id
    WHERE (TG_TABLE_NAME = 'teras_pathway_competency_units' AND link.unit_id = (to_jsonb(OLD)->>'unit_id')
       OR TG_TABLE_NAME = 'teras_learning_activities' AND activity.id = OLD.id
       OR TG_TABLE_NAME = 'teras_learning_outcomes' AND outcome.id = OLD.id)
      AND NOT EXISTS (SELECT 1 FROM teras_pathway_competency_units p
                      WHERE p.unit_id = link.unit_id AND p.pathway_id = activity.pathway_id)
  ) OR EXISTS (
    SELECT 1 FROM teras_diagnostic_questions q
    JOIN teras_diagnostic_templates t ON t.id = q.template_id
    WHERE TG_TABLE_NAME = 'teras_pathway_competency_units'
      AND q.competency_unit_id = (to_jsonb(OLD)->>'unit_id') AND NOT EXISTS (
      SELECT 1 FROM teras_pathway_competency_units p
      WHERE p.unit_id = q.competency_unit_id AND p.pathway_id = t.pathway_id
    )
  ) THEN
    RAISE EXCEPTION 'pathway change would orphan competency learning or diagnostic linkage';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS teras_competency_assignment_retention ON teras_pathway_competency_units;
CREATE CONSTRAINT TRIGGER teras_competency_assignment_retention
AFTER DELETE OR UPDATE ON teras_pathway_competency_units
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teras_check_competency_scope_after_change();
DROP TRIGGER IF EXISTS teras_competency_module_path_retention ON teras_modules;
CREATE CONSTRAINT TRIGGER teras_competency_module_path_retention
AFTER UPDATE OF pathway_id ON teras_modules
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teras_check_competency_scope_after_change();
DROP TRIGGER IF EXISTS teras_competency_activity_path_retention ON teras_learning_activities;
CREATE CONSTRAINT TRIGGER teras_competency_activity_path_retention
AFTER UPDATE OF pathway_id ON teras_learning_activities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teras_check_competency_scope_after_change();
DROP TRIGGER IF EXISTS teras_competency_practice_module_retention ON teras_practice_tasks;
CREATE CONSTRAINT TRIGGER teras_competency_practice_module_retention
AFTER UPDATE OF module_id ON teras_practice_tasks
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teras_check_competency_scope_after_change();
DROP TRIGGER IF EXISTS teras_competency_evidence_module_retention ON teras_evidence_requirements;
CREATE CONSTRAINT TRIGGER teras_competency_evidence_module_retention
AFTER UPDATE OF module_id ON teras_evidence_requirements
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teras_check_competency_scope_after_change();
DROP TRIGGER IF EXISTS teras_competency_outcome_activity_retention ON teras_learning_outcomes;
CREATE CONSTRAINT TRIGGER teras_competency_outcome_activity_retention
AFTER UPDATE OF activity_id ON teras_learning_outcomes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teras_check_competency_scope_after_change();

CREATE OR REPLACE FUNCTION teras_guard_diagnostic_template() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.framework_id, NEW.pathway_id) IS DISTINCT FROM (OLD.framework_id, OLD.pathway_id) THEN
    RAISE EXCEPTION 'diagnostic template framework and pathway are immutable';
  END IF;
  IF NEW.status = 'active' THEN
    SELECT authority_status INTO authority FROM teras_competency_frameworks WHERE id = NEW.framework_id;
    IF authority IS DISTINCT FROM 'AUTHORITATIVE' OR NOT EXISTS (
      SELECT 1 FROM teras_competency_framework_sources s
      JOIN teras_regulatory_references r ON r.id = s.regulatory_reference_id
      WHERE s.framework_id = NEW.framework_id AND s.provenance_type = 'AUTHORITATIVE'
        AND r.authority_role = 'DOMAIN_AUTHORITY' AND r.status = 'ACTIVE'
    ) OR NOT EXISTS (
      SELECT 1 FROM teras_pathway_competency_units p
      JOIN teras_competency_units u ON u.id = p.unit_id
      WHERE p.pathway_id = NEW.pathway_id AND u.framework_id = NEW.framework_id
    ) THEN
      RAISE EXCEPTION 'active diagnostic requires an authoritative framework assigned to its pathway';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_diagnostic_template_scope_guard ON teras_diagnostic_templates;
CREATE TRIGGER teras_diagnostic_template_scope_guard BEFORE INSERT OR UPDATE ON teras_diagnostic_templates
FOR EACH ROW EXECUTE FUNCTION teras_guard_diagnostic_template();

CREATE OR REPLACE FUNCTION teras_guard_diagnostic_question() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE template_framework text; template_pathway text; unit_framework text;
BEGIN
  SELECT framework_id, pathway_id INTO template_framework, template_pathway
  FROM teras_diagnostic_templates WHERE id = NEW.template_id;
  IF NEW.competency_unit_id IS NOT NULL THEN
    SELECT framework_id INTO unit_framework FROM teras_competency_units WHERE id = NEW.competency_unit_id;
  END IF;
  IF NEW.framework_id IS DISTINCT FROM template_framework
    OR (NEW.competency_unit_id IS NOT NULL AND (
      unit_framework IS DISTINCT FROM template_framework OR NOT EXISTS (
        SELECT 1 FROM teras_pathway_competency_units p
        WHERE p.unit_id = NEW.competency_unit_id AND p.pathway_id = template_pathway
      )
    )) THEN
    RAISE EXCEPTION 'diagnostic question framework, unit and pathway must match its template';
  END IF;
  IF NEW.kuk_id IS NOT NULL AND (NEW.competency_unit_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM teras_competency_kuks k
    JOIN teras_competency_elements e ON e.id = k.element_id
    WHERE k.id = NEW.kuk_id AND e.unit_id = NEW.competency_unit_id
  )) THEN
    RAISE EXCEPTION 'diagnostic KUK must belong to the question unit';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_diagnostic_question_scope_guard ON teras_diagnostic_questions;
CREATE TRIGGER teras_diagnostic_question_scope_guard BEFORE INSERT OR UPDATE ON teras_diagnostic_questions
FOR EACH ROW EXECUTE FUNCTION teras_guard_diagnostic_question();

-- Old synthetic fixtures must not remain discoverable as published content.
UPDATE teras_diagnostic_templates t SET status = 'draft'
FROM teras_competency_frameworks f
WHERE t.framework_id = f.id AND t.status = 'active' AND f.authority_status <> 'AUTHORITATIVE';
COMMIT;