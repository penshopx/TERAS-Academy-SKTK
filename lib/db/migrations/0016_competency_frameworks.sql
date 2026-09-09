CREATE TABLE IF NOT EXISTS "teras_competency_frameworks" (
 "id" text PRIMARY KEY NOT NULL, "code" text NOT NULL, "name" text NOT NULL, "description" text NOT NULL,
 "domain" text DEFAULT 'general' NOT NULL, "version" text DEFAULT '1.0' NOT NULL, "status" text DEFAULT 'draft' NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "created_by" text DEFAULT 'system' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "teras_competency_frameworks_code_version_unique" ON "teras_competency_frameworks" ("code","version");
CREATE TABLE IF NOT EXISTS "teras_competency_units" (
 "id" text PRIMARY KEY NOT NULL, "framework_id" text NOT NULL REFERENCES "teras_competency_frameworks"("id") ON DELETE CASCADE,
 "code" text NOT NULL, "title" text NOT NULL, "description" text NOT NULL, "status" text DEFAULT 'draft' NOT NULL, "sequence" integer DEFAULT 1 NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "created_by" text DEFAULT 'system' NOT NULL,
 CONSTRAINT "teras_competency_units_sequence_check" CHECK ("sequence" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "teras_competency_units_framework_code_unique" ON "teras_competency_units" ("framework_id","code");
CREATE UNIQUE INDEX IF NOT EXISTS "teras_competency_units_framework_sequence_unique" ON "teras_competency_units" ("framework_id","sequence");
CREATE TABLE IF NOT EXISTS "teras_pathway_competency_units" (
 "id" text PRIMARY KEY NOT NULL, "pathway_id" text NOT NULL REFERENCES "teras_pathways"("id") ON DELETE CASCADE,
 "unit_id" text NOT NULL REFERENCES "teras_competency_units"("id") ON DELETE CASCADE, "required" boolean DEFAULT true NOT NULL, "sequence" integer DEFAULT 1 NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "created_by" text DEFAULT 'system' NOT NULL,
 CONSTRAINT "teras_pathway_competency_units_sequence_check" CHECK ("sequence" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "teras_pathway_competency_units_pathway_unit_unique" ON "teras_pathway_competency_units" ("pathway_id","unit_id");
CREATE TABLE IF NOT EXISTS "teras_competency_unit_outcomes" (
 "id" text PRIMARY KEY NOT NULL, "unit_id" text NOT NULL REFERENCES "teras_competency_units"("id") ON DELETE CASCADE,
 "learning_outcome_id" text REFERENCES "teras_learning_outcomes"("id"), "outcome_code" text NOT NULL, "description" text NOT NULL, "verification_method" text NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "created_by" text DEFAULT 'system' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "teras_competency_unit_outcomes_unit_code_unique" ON "teras_competency_unit_outcomes" ("unit_id","outcome_code");
CREATE TABLE IF NOT EXISTS "teras_competency_unit_practice_tasks" (
 "id" text PRIMARY KEY NOT NULL, "unit_id" text NOT NULL REFERENCES "teras_competency_units"("id") ON DELETE CASCADE,
 "task_id" text NOT NULL REFERENCES "teras_practice_tasks"("id") ON DELETE CASCADE, "required" boolean DEFAULT true NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "created_by" text DEFAULT 'system' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "teras_competency_unit_practice_unique" ON "teras_competency_unit_practice_tasks" ("unit_id","task_id");
CREATE TABLE IF NOT EXISTS "teras_competency_unit_evidence_requirements" (
 "id" text PRIMARY KEY NOT NULL, "unit_id" text NOT NULL REFERENCES "teras_competency_units"("id") ON DELETE CASCADE,
 "requirement_id" text NOT NULL REFERENCES "teras_evidence_requirements"("id") ON DELETE CASCADE, "required" boolean DEFAULT true NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "created_by" text DEFAULT 'system' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "teras_competency_unit_evidence_unique" ON "teras_competency_unit_evidence_requirements" ("unit_id","requirement_id");
CREATE TABLE IF NOT EXISTS "teras_competency_unit_simulations" (
 "id" text PRIMARY KEY NOT NULL, "unit_id" text NOT NULL REFERENCES "teras_competency_units"("id") ON DELETE CASCADE,
 "title" text NOT NULL, "instructions" text NOT NULL, "evidence_required" text NOT NULL, "duration_minutes" integer DEFAULT 0 NOT NULL,
 "disclaimer" text DEFAULT 'Internal simulation/preparation only; not an official assessment or certification.' NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "created_by" text DEFAULT 'system' NOT NULL,
 CONSTRAINT "teras_competency_unit_simulations_duration_check" CHECK ("duration_minutes" >= 0)
);
CREATE TABLE IF NOT EXISTS "teras_competency_unit_safety_rules" (
 "id" text PRIMARY KEY NOT NULL, "unit_id" text NOT NULL REFERENCES "teras_competency_units"("id") ON DELETE CASCADE,
 "code" text NOT NULL, "rule" text NOT NULL, "severity" text DEFAULT 'critical' NOT NULL, "verification_evidence" text NOT NULL, "blocking" boolean DEFAULT true NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "created_by" text DEFAULT 'system' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "teras_competency_unit_safety_code_unique" ON "teras_competency_unit_safety_rules" ("unit_id","code");