ALTER TABLE "teras_diagnostic_profiles"
  ADD COLUMN IF NOT EXISTS "provenance" jsonb;

ALTER TABLE "teras_diagnostic_profile_items"
  ADD COLUMN IF NOT EXISTS "provenance" jsonb;

ALTER TABLE "teras_diagnostic_gaps"
  ADD COLUMN IF NOT EXISTS "provenance" jsonb;

ALTER TABLE "teras_diagnostic_profiles"
  ALTER COLUMN "provenance" DROP NOT NULL,
  ALTER COLUMN "provenance" DROP DEFAULT;
ALTER TABLE "teras_diagnostic_profile_items"
  ALTER COLUMN "provenance" DROP NOT NULL,
  ALTER COLUMN "provenance" DROP DEFAULT;
ALTER TABLE "teras_diagnostic_gaps"
  ALTER COLUMN "provenance" DROP NOT NULL,
  ALTER COLUMN "provenance" DROP DEFAULT;

UPDATE "teras_diagnostic_profiles"
SET "provenance" = NULL
WHERE "provenance"->>'sessionId' = '';
UPDATE "teras_diagnostic_profile_items"
SET "provenance" = NULL
WHERE "provenance"->>'sessionId' = '';
UPDATE "teras_diagnostic_gaps"
SET "provenance" = NULL
WHERE "provenance"->>'sessionId' = '';

CREATE TABLE IF NOT EXISTS "teras_diagnostic_provenance_exceptions" (
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "profile_id" text,
  "session_id" text,
  "competency_unit_id" text,
  "reason" text NOT NULL,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "detected_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "teras_diagnostic_provenance_exceptions_pk"
    PRIMARY KEY ("entity_type", "entity_id"),
  CONSTRAINT "teras_diagnostic_provenance_exceptions_entity_type_check"
    CHECK ("entity_type" IN ('profile', 'profile_item', 'gap')),
  CONSTRAINT "teras_diagnostic_provenance_exceptions_reason_check"
    CHECK ("reason" IN ('NO_VALID_RESPONSE_CHAIN', 'NO_VALID_UNIT_RESPONSE_CHAIN'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'teras_diagnostic_provenance_exceptions'::regclass
      AND conname = 'teras_diagnostic_provenance_exceptions_reason_check'
  ) THEN
    ALTER TABLE teras_diagnostic_provenance_exceptions
      ADD CONSTRAINT teras_diagnostic_provenance_exceptions_reason_check
      CHECK (reason IN ('NO_VALID_RESPONSE_CHAIN', 'NO_VALID_UNIT_RESPONSE_CHAIN'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "teras_diagnostic_provenance_check_runs" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "checked_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "teras_diagnostic_provenance_check_counts" (
  "check_run_id" bigint NOT NULL
    REFERENCES "teras_diagnostic_provenance_check_runs" ("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "reason" text NOT NULL,
  "exception_count" integer NOT NULL,
  CONSTRAINT "teras_diagnostic_provenance_check_counts_pk"
    PRIMARY KEY ("check_run_id", "entity_type", "reason"),
  CONSTRAINT "teras_diagnostic_provenance_check_counts_entity_type_check"
    CHECK ("entity_type" IN ('profile', 'profile_item', 'gap')),
  CONSTRAINT "teras_diagnostic_provenance_check_counts_reason_check"
    CHECK ("reason" IN ('NO_VALID_RESPONSE_CHAIN', 'NO_VALID_UNIT_RESPONSE_CHAIN')),
  CONSTRAINT "teras_diagnostic_provenance_check_counts_nonnegative_check"
    CHECK ("exception_count" >= 0)
);

-- Reconstruct profile provenance only from responses whose question and option
-- form a valid chain in the profile's own diagnostic session.
WITH reconstructed AS (
  SELECT
    p.id,
    jsonb_build_object(
      'sessionId', p.session_id,
      'responseIds', jsonb_agg(r.id ORDER BY q.sequence, r.id),
      'questionIds', jsonb_agg(r.question_id ORDER BY q.sequence, r.id),
      'optionIds', jsonb_agg(r.option_id ORDER BY q.sequence, r.id)
    ) AS provenance
  FROM teras_diagnostic_profiles p
  JOIN teras_diagnostic_sessions s ON s.id = p.session_id
    AND s.learner_id = p.learner_id
  JOIN teras_diagnostic_responses r ON r.session_id = s.id
  JOIN teras_diagnostic_questions q ON q.id = r.question_id
    AND q.template_id = s.template_id
  JOIN teras_diagnostic_options o ON o.id = r.option_id
    AND o.question_id = q.id
  WHERE p.provenance IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM teras_diagnostic_responses candidate
      LEFT JOIN teras_diagnostic_questions candidate_question
        ON candidate_question.id = candidate.question_id
      LEFT JOIN teras_diagnostic_options candidate_option
        ON candidate_option.id = candidate.option_id
      WHERE candidate.session_id = s.id
        AND (
          candidate_question.id IS NULL
          OR candidate_question.template_id <> s.template_id
          OR candidate_option.id IS NULL
          OR candidate_option.question_id <> candidate_question.id
        )
    )
  GROUP BY p.id, p.session_id
)
UPDATE teras_diagnostic_profiles p
SET provenance = reconstructed.provenance
FROM reconstructed
WHERE p.id = reconstructed.id;

-- Capability items and gaps are derived from responses mapped to the same
-- competency unit. The question mapping is canonical; the denormalized
-- response unit must either agree or be absent on older rows.
WITH reconstructed AS (
  SELECT
    i.id,
    jsonb_build_object(
      'sessionId', p.session_id,
      'responseIds', jsonb_agg(r.id ORDER BY q.sequence, r.id),
      'questionIds', jsonb_agg(r.question_id ORDER BY q.sequence, r.id),
      'optionIds', jsonb_agg(r.option_id ORDER BY q.sequence, r.id)
    ) AS provenance
  FROM teras_diagnostic_profile_items i
  JOIN teras_diagnostic_profiles p ON p.id = i.profile_id
  JOIN teras_diagnostic_sessions s ON s.id = p.session_id
    AND s.learner_id = p.learner_id
  JOIN teras_diagnostic_responses r ON r.session_id = s.id
    AND (r.competency_unit_id IS NULL OR r.competency_unit_id = i.competency_unit_id)
  JOIN teras_diagnostic_questions q ON q.id = r.question_id
    AND q.template_id = s.template_id
    AND q.competency_unit_id = i.competency_unit_id
  JOIN teras_diagnostic_options o ON o.id = r.option_id
    AND o.question_id = q.id
  WHERE i.provenance IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM teras_diagnostic_responses candidate
      LEFT JOIN teras_diagnostic_questions candidate_question
        ON candidate_question.id = candidate.question_id
      LEFT JOIN teras_diagnostic_options candidate_option
        ON candidate_option.id = candidate.option_id
      WHERE candidate.session_id = s.id
        AND (
          candidate.competency_unit_id = i.competency_unit_id
          OR candidate_question.competency_unit_id = i.competency_unit_id
        )
        AND (
          candidate_question.id IS NULL
          OR candidate_question.template_id <> s.template_id
          OR candidate_question.competency_unit_id <> i.competency_unit_id
          OR candidate.competency_unit_id IS NOT NULL
            AND candidate.competency_unit_id <> i.competency_unit_id
          OR candidate_option.id IS NULL
          OR candidate_option.question_id <> candidate_question.id
        )
    )
  GROUP BY i.id, p.session_id
)
UPDATE teras_diagnostic_profile_items i
SET provenance = reconstructed.provenance
FROM reconstructed
WHERE i.id = reconstructed.id;

WITH reconstructed AS (
  SELECT
    g.id,
    jsonb_build_object(
      'sessionId', p.session_id,
      'responseIds', jsonb_agg(r.id ORDER BY q.sequence, r.id),
      'questionIds', jsonb_agg(r.question_id ORDER BY q.sequence, r.id),
      'optionIds', jsonb_agg(r.option_id ORDER BY q.sequence, r.id)
    ) AS provenance
  FROM teras_diagnostic_gaps g
  JOIN teras_diagnostic_profiles p ON p.id = g.profile_id
  JOIN teras_diagnostic_sessions s ON s.id = p.session_id
    AND s.learner_id = p.learner_id
  JOIN teras_diagnostic_responses r ON r.session_id = s.id
    AND (r.competency_unit_id IS NULL OR r.competency_unit_id = g.competency_unit_id)
  JOIN teras_diagnostic_questions q ON q.id = r.question_id
    AND q.template_id = s.template_id
    AND q.competency_unit_id = g.competency_unit_id
  JOIN teras_diagnostic_options o ON o.id = r.option_id
    AND o.question_id = q.id
  WHERE g.provenance IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM teras_diagnostic_responses candidate
      LEFT JOIN teras_diagnostic_questions candidate_question
        ON candidate_question.id = candidate.question_id
      LEFT JOIN teras_diagnostic_options candidate_option
        ON candidate_option.id = candidate.option_id
      WHERE candidate.session_id = s.id
        AND (
          candidate.competency_unit_id = g.competency_unit_id
          OR candidate_question.competency_unit_id = g.competency_unit_id
        )
        AND (
          candidate_question.id IS NULL
          OR candidate_question.template_id <> s.template_id
          OR candidate_question.competency_unit_id <> g.competency_unit_id
          OR candidate.competency_unit_id IS NOT NULL
            AND candidate.competency_unit_id <> g.competency_unit_id
          OR candidate_option.id IS NULL
          OR candidate_option.question_id <> candidate_question.id
        )
    )
  GROUP BY g.id, p.session_id
)
UPDATE teras_diagnostic_gaps g
SET provenance = reconstructed.provenance
FROM reconstructed
WHERE g.id = reconstructed.id;

-- Keep one current, reviewable exception per unresolved legacy record. Details
-- identify the expected source without inventing provenance.
INSERT INTO teras_diagnostic_provenance_exceptions
  (entity_type, entity_id, profile_id, session_id, reason, details)
SELECT
  'profile', p.id, p.id, p.session_id, 'NO_VALID_RESPONSE_CHAIN',
  jsonb_build_object('learnerId', p.learner_id)
FROM teras_diagnostic_profiles p
WHERE p.provenance IS NULL
ON CONFLICT (entity_type, entity_id) DO UPDATE SET
  profile_id = EXCLUDED.profile_id,
  session_id = EXCLUDED.session_id,
  reason = EXCLUDED.reason,
  details = EXCLUDED.details,
  updated_at = now();

INSERT INTO teras_diagnostic_provenance_exceptions
  (entity_type, entity_id, profile_id, session_id, competency_unit_id, reason, details)
SELECT
  'profile_item', i.id, p.id, p.session_id, i.competency_unit_id,
  'NO_VALID_UNIT_RESPONSE_CHAIN',
  jsonb_build_object('unitCode', i.unit_code)
FROM teras_diagnostic_profile_items i
JOIN teras_diagnostic_profiles p ON p.id = i.profile_id
WHERE i.provenance IS NULL
ON CONFLICT (entity_type, entity_id) DO UPDATE SET
  profile_id = EXCLUDED.profile_id,
  session_id = EXCLUDED.session_id,
  competency_unit_id = EXCLUDED.competency_unit_id,
  reason = EXCLUDED.reason,
  details = EXCLUDED.details,
  updated_at = now();

INSERT INTO teras_diagnostic_provenance_exceptions
  (entity_type, entity_id, profile_id, session_id, competency_unit_id, reason, details)
SELECT
  'gap', g.id, p.id, p.session_id, g.competency_unit_id,
  'NO_VALID_UNIT_RESPONSE_CHAIN',
  jsonb_build_object('unitCode', g.unit_code)
FROM teras_diagnostic_gaps g
JOIN teras_diagnostic_profiles p ON p.id = g.profile_id
WHERE g.provenance IS NULL
ON CONFLICT (entity_type, entity_id) DO UPDATE SET
  profile_id = EXCLUDED.profile_id,
  session_id = EXCLUDED.session_id,
  competency_unit_id = EXCLUDED.competency_unit_id,
  reason = EXCLUDED.reason,
  details = EXCLUDED.details,
  updated_at = now();

DELETE FROM teras_diagnostic_provenance_exceptions e
WHERE (e.entity_type = 'profile' AND EXISTS (
    SELECT 1 FROM teras_diagnostic_profiles p
    WHERE p.id = e.entity_id AND p.provenance IS NOT NULL
  ))
  OR (e.entity_type = 'profile_item' AND EXISTS (
    SELECT 1 FROM teras_diagnostic_profile_items i
    WHERE i.id = e.entity_id AND i.provenance IS NOT NULL
  ))
  OR (e.entity_type = 'gap' AND EXISTS (
    SELECT 1 FROM teras_diagnostic_gaps g
    WHERE g.id = e.entity_id AND g.provenance IS NOT NULL
  ));

ALTER TABLE "teras_diagnostic_profiles"
  DROP CONSTRAINT IF EXISTS "teras_diagnostic_profiles_provenance_check";
ALTER TABLE "teras_diagnostic_profiles"
  ADD CONSTRAINT "teras_diagnostic_profiles_provenance_check"
  CHECK (
    "provenance" IS NULL OR (
      "provenance"->>'sessionId' <> ''
      AND jsonb_array_length("provenance"->'responseIds') > 0
      AND jsonb_array_length("provenance"->'questionIds') > 0
      AND jsonb_array_length("provenance"->'optionIds') > 0
    )
  ) NOT VALID;

ALTER TABLE "teras_diagnostic_profile_items"
  DROP CONSTRAINT IF EXISTS "teras_diagnostic_profile_items_provenance_check";
ALTER TABLE "teras_diagnostic_profile_items"
  ADD CONSTRAINT "teras_diagnostic_profile_items_provenance_check"
  CHECK (
    "provenance" IS NULL OR (
      "provenance"->>'sessionId' <> ''
      AND jsonb_array_length("provenance"->'responseIds') > 0
      AND jsonb_array_length("provenance"->'questionIds') > 0
      AND jsonb_array_length("provenance"->'optionIds') > 0
    )
  ) NOT VALID;

ALTER TABLE "teras_diagnostic_gaps"
  DROP CONSTRAINT IF EXISTS "teras_diagnostic_gaps_provenance_check";
ALTER TABLE "teras_diagnostic_gaps"
  ADD CONSTRAINT "teras_diagnostic_gaps_provenance_check"
  CHECK (
    "provenance" IS NULL OR (
      "provenance"->>'sessionId' <> ''
      AND jsonb_array_length("provenance"->'responseIds') > 0
      AND jsonb_array_length("provenance"->'questionIds') > 0
      AND jsonb_array_length("provenance"->'optionIds') > 0
    )
  ) NOT VALID;

ALTER TABLE "teras_diagnostic_profiles"
  VALIDATE CONSTRAINT "teras_diagnostic_profiles_provenance_check";
ALTER TABLE "teras_diagnostic_profile_items"
  VALIDATE CONSTRAINT "teras_diagnostic_profile_items_provenance_check";
ALTER TABLE "teras_diagnostic_gaps"
  VALIDATE CONSTRAINT "teras_diagnostic_gaps_provenance_check";