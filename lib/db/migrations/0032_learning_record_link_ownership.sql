BEGIN;

-- Ownership inventory:
-- teras_learning_record_links.learner_id must own every learner-scoped parent:
-- practice_attempt_id -> teras_practice_attempts.learner_id
-- evidence_id -> teras_evidence.learner_id
-- evidence_review_id -> teras_evidence_reviews -> teras_evidence.learner_id
-- gap_id -> teras_gaps.learner_id
-- remediation_plan_id -> teras_remediation_plans -> teras_gaps.learner_id
-- reassessment_attempt_id -> teras_assessment_attempts.learner_id
-- teras_reassessment_links applies the same rule to original_gap_id,
-- remediation_plan_id, practice_attempt_id, evidence_id,
-- reassessment_attempt_id, and previous_assessment_attempt_id.
LOCK TABLE
  teras_learning_record_links,
  teras_reassessment_links,
  teras_practice_attempts,
  teras_evidence,
  teras_evidence_reviews,
  teras_gaps,
  teras_remediation_plans,
  teras_assessment_attempts
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  mismatch_table text;
BEGIN
  SELECT source_table
  INTO mismatch_table
  FROM (
    SELECT 'teras_learning_record_links' AS source_table
    FROM teras_learning_record_links AS link
    LEFT JOIN teras_practice_attempts AS practice ON practice.id = link.practice_attempt_id
    LEFT JOIN teras_evidence AS evidence ON evidence.id = link.evidence_id
    LEFT JOIN teras_evidence_reviews AS review ON review.id = link.evidence_review_id
    LEFT JOIN teras_evidence AS reviewed_evidence ON reviewed_evidence.id = review.evidence_id
    LEFT JOIN teras_gaps AS gap ON gap.id = link.gap_id
    LEFT JOIN teras_remediation_plans AS plan ON plan.id = link.remediation_plan_id
    LEFT JOIN teras_gaps AS plan_gap ON plan_gap.id = plan.gap_id
    LEFT JOIN teras_assessment_attempts AS reassessment ON reassessment.id = link.reassessment_attempt_id
    WHERE practice.learner_id IS DISTINCT FROM link.learner_id AND link.practice_attempt_id IS NOT NULL
       OR evidence.learner_id IS DISTINCT FROM link.learner_id AND link.evidence_id IS NOT NULL
       OR reviewed_evidence.learner_id IS DISTINCT FROM link.learner_id AND link.evidence_review_id IS NOT NULL
       OR gap.learner_id IS DISTINCT FROM link.learner_id AND link.gap_id IS NOT NULL
       OR plan_gap.learner_id IS DISTINCT FROM link.learner_id AND link.remediation_plan_id IS NOT NULL
       OR reassessment.learner_id IS DISTINCT FROM link.learner_id AND link.reassessment_attempt_id IS NOT NULL
    UNION ALL
    SELECT 'teras_reassessment_links'
    FROM teras_reassessment_links AS link
    LEFT JOIN teras_gaps AS original_gap ON original_gap.id = link.original_gap_id
    LEFT JOIN teras_remediation_plans AS plan ON plan.id = link.remediation_plan_id
    LEFT JOIN teras_gaps AS plan_gap ON plan_gap.id = plan.gap_id
    LEFT JOIN teras_practice_attempts AS practice ON practice.id = link.practice_attempt_id
    LEFT JOIN teras_evidence AS evidence ON evidence.id = link.evidence_id
    LEFT JOIN teras_assessment_attempts AS reassessment ON reassessment.id = link.reassessment_attempt_id
    LEFT JOIN teras_assessment_attempts AS previous_assessment ON previous_assessment.id = link.previous_assessment_attempt_id
    WHERE original_gap.learner_id IS DISTINCT FROM link.learner_id
       OR plan_gap.learner_id IS DISTINCT FROM link.learner_id
       OR practice.learner_id IS DISTINCT FROM link.learner_id
       OR evidence.learner_id IS DISTINCT FROM link.learner_id
       OR reassessment.learner_id IS DISTINCT FROM link.learner_id
       OR previous_assessment.learner_id IS DISTINCT FROM link.learner_id
          AND link.previous_assessment_attempt_id IS NOT NULL
  ) AS mismatches
  LIMIT 1;

  IF mismatch_table IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce causal link ownership: parent learner differs from link learner in %',
      mismatch_table;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION teras_enforce_causal_link_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'teras_learning_record_links' THEN
    IF (NEW.practice_attempt_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM teras_practice_attempts WHERE id = NEW.practice_attempt_id AND learner_id = NEW.learner_id
       ))
       OR (NEW.evidence_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM teras_evidence WHERE id = NEW.evidence_id AND learner_id = NEW.learner_id
       ))
       OR (NEW.evidence_review_id IS NOT NULL AND NOT EXISTS (
         SELECT 1
         FROM teras_evidence_reviews AS review
         JOIN teras_evidence AS evidence ON evidence.id = review.evidence_id
         WHERE review.id = NEW.evidence_review_id AND evidence.learner_id = NEW.learner_id
       ))
       OR (NEW.gap_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM teras_gaps WHERE id = NEW.gap_id AND learner_id = NEW.learner_id
       ))
       OR (NEW.remediation_plan_id IS NOT NULL AND NOT EXISTS (
         SELECT 1
         FROM teras_remediation_plans AS plan
         JOIN teras_gaps AS gap ON gap.id = plan.gap_id
         WHERE plan.id = NEW.remediation_plan_id AND gap.learner_id = NEW.learner_id
       ))
       OR (NEW.reassessment_attempt_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM teras_assessment_attempts WHERE id = NEW.reassessment_attempt_id AND learner_id = NEW.learner_id
       ))
    THEN
      RAISE EXCEPTION 'Causal learning record link % mixes learner ownership', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'teras_learning_record_links_learner_ownership';
    END IF;
  ELSIF TG_TABLE_NAME = 'teras_reassessment_links' THEN
    IF NOT EXISTS (
         SELECT 1 FROM teras_gaps WHERE id = NEW.original_gap_id AND learner_id = NEW.learner_id
       )
       OR NOT EXISTS (
         SELECT 1
         FROM teras_remediation_plans AS plan
         JOIN teras_gaps AS gap ON gap.id = plan.gap_id
         WHERE plan.id = NEW.remediation_plan_id AND gap.learner_id = NEW.learner_id
       )
       OR NOT EXISTS (
         SELECT 1 FROM teras_practice_attempts WHERE id = NEW.practice_attempt_id AND learner_id = NEW.learner_id
       )
       OR NOT EXISTS (
         SELECT 1 FROM teras_evidence WHERE id = NEW.evidence_id AND learner_id = NEW.learner_id
       )
       OR NOT EXISTS (
         SELECT 1 FROM teras_assessment_attempts WHERE id = NEW.reassessment_attempt_id AND learner_id = NEW.learner_id
       )
       OR (NEW.previous_assessment_attempt_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM teras_assessment_attempts WHERE id = NEW.previous_assessment_attempt_id AND learner_id = NEW.learner_id
       ))
    THEN
      RAISE EXCEPTION 'Causal reassessment link % mixes learner ownership', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'teras_reassessment_links_learner_ownership';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION teras_preserve_causal_parent_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME IN (
    'teras_practice_attempts',
    'teras_evidence',
    'teras_gaps',
    'teras_assessment_attempts'
  ) THEN
    IF NEW.learner_id IS DISTINCT FROM OLD.learner_id THEN
      RAISE EXCEPTION 'Learner ownership of causal parent %.% is immutable', TG_TABLE_NAME, OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'teras_causal_parent_learner_ownership_immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'teras_evidence_reviews' THEN
    IF NEW.evidence_id IS DISTINCT FROM OLD.evidence_id THEN
      RAISE EXCEPTION 'Evidence parent of causal review % is immutable', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'teras_causal_review_evidence_immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'teras_remediation_plans' THEN
    IF NEW.gap_id IS DISTINCT FROM OLD.gap_id THEN
      RAISE EXCEPTION 'Gap parent of causal remediation plan % is immutable', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'teras_causal_plan_gap_immutable';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS teras_learning_record_links_learner_ownership_trigger
  ON teras_learning_record_links;
CREATE TRIGGER teras_learning_record_links_learner_ownership_trigger
BEFORE INSERT OR UPDATE ON teras_learning_record_links
FOR EACH ROW EXECUTE FUNCTION teras_enforce_causal_link_ownership();

DROP TRIGGER IF EXISTS teras_reassessment_links_learner_ownership_trigger
  ON teras_reassessment_links;
CREATE TRIGGER teras_reassessment_links_learner_ownership_trigger
BEFORE INSERT OR UPDATE ON teras_reassessment_links
FOR EACH ROW EXECUTE FUNCTION teras_enforce_causal_link_ownership();

DROP TRIGGER IF EXISTS teras_practice_attempts_learner_ownership_trigger ON teras_practice_attempts;
CREATE TRIGGER teras_practice_attempts_learner_ownership_trigger
BEFORE UPDATE OF learner_id ON teras_practice_attempts
FOR EACH ROW EXECUTE FUNCTION teras_preserve_causal_parent_ownership();

DROP TRIGGER IF EXISTS teras_evidence_learner_ownership_trigger ON teras_evidence;
CREATE TRIGGER teras_evidence_learner_ownership_trigger
BEFORE UPDATE OF learner_id ON teras_evidence
FOR EACH ROW EXECUTE FUNCTION teras_preserve_causal_parent_ownership();

DROP TRIGGER IF EXISTS teras_gaps_learner_ownership_trigger ON teras_gaps;
CREATE TRIGGER teras_gaps_learner_ownership_trigger
BEFORE UPDATE OF learner_id ON teras_gaps
FOR EACH ROW EXECUTE FUNCTION teras_preserve_causal_parent_ownership();

DROP TRIGGER IF EXISTS teras_assessment_attempts_learner_ownership_trigger ON teras_assessment_attempts;
CREATE TRIGGER teras_assessment_attempts_learner_ownership_trigger
BEFORE UPDATE OF learner_id ON teras_assessment_attempts
FOR EACH ROW EXECUTE FUNCTION teras_preserve_causal_parent_ownership();

DROP TRIGGER IF EXISTS teras_evidence_reviews_evidence_ownership_trigger ON teras_evidence_reviews;
CREATE TRIGGER teras_evidence_reviews_evidence_ownership_trigger
BEFORE UPDATE OF evidence_id ON teras_evidence_reviews
FOR EACH ROW EXECUTE FUNCTION teras_preserve_causal_parent_ownership();

DROP TRIGGER IF EXISTS teras_remediation_plans_gap_ownership_trigger ON teras_remediation_plans;
CREATE TRIGGER teras_remediation_plans_gap_ownership_trigger
BEFORE UPDATE OF gap_id ON teras_remediation_plans
FOR EACH ROW EXECUTE FUNCTION teras_preserve_causal_parent_ownership();

COMMIT;