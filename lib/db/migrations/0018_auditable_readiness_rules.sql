ALTER TABLE "teras_readiness_gates"
  ADD COLUMN IF NOT EXISTS "competency_unit_id" text,
  ADD COLUMN IF NOT EXISTS "threshold" integer DEFAULT 80 NOT NULL,
  ADD COLUMN IF NOT EXISTS "hard_gate" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "rule_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;

ALTER TABLE "teras_readiness_events"
  ADD COLUMN IF NOT EXISTS "rule_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "input_evidence" jsonb DEFAULT '{"assessments":[],"evidence":[],"openCriticalGaps":[]}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "decision_reason" text DEFAULT 'Legacy readiness event' NOT NULL,
  ADD COLUMN IF NOT EXISTS "evaluated_at" timestamptz DEFAULT now() NOT NULL;

UPDATE "teras_readiness_events"
SET "status" = CASE
  WHEN "status" IN ('Blocked', 'Not Ready') OR cardinality("blockers") > 0 THEN 'Not Ready'
  WHEN "status" IN ('Passed', 'Ready for Official Assessment') THEN 'Ready for Official Assessment'
  ELSE 'Developing'
END;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_readiness_gates_threshold_check') THEN
    ALTER TABLE "teras_readiness_gates" ADD CONSTRAINT "teras_readiness_gates_threshold_check" CHECK ("threshold" BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_readiness_events_status_check') THEN
    ALTER TABLE "teras_readiness_events" ADD CONSTRAINT "teras_readiness_events_status_check" CHECK ("status" IN ('Not Ready', 'Developing', 'Ready for Official Assessment'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "teras_readiness_gates_rule_version_unique"
  ON "teras_readiness_gates" ("pathway_id", "code", "rule_version");