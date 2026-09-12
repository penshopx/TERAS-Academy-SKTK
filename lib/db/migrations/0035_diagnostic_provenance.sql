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