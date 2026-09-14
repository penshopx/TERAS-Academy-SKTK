import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../lib/db/migrations/0035_diagnostic_provenance.sql", import.meta.url),
  "utf8",
);
const schemaCheck = readFileSync(
  new URL("../schema-check.sql", import.meta.url),
  "utf8",
);

test("legacy diagnostic provenance is rebuilt from valid response chains", () => {
  assert.match(migration, /JOIN teras_diagnostic_responses r ON r\.session_id = s\.id/);
  assert.match(migration, /o\.question_id = q\.id/g);
  assert.match(migration, /q\.competency_unit_id = i\.competency_unit_id/);
  assert.match(migration, /q\.competency_unit_id = g\.competency_unit_id/);
  assert.match(migration, /jsonb_agg\(r\.id ORDER BY q\.sequence, r\.id\)/g);
  assert.equal(
    [...migration.matchAll(/AND NOT EXISTS \(/g)].length,
    3,
  );
  assert.match(migration, /candidate_option\.question_id <> candidate_question\.id/g);
});

test("unresolved records remain reviewable and constraints are validated", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "teras_diagnostic_provenance_exceptions"/);
  assert.match(migration, /'NO_VALID_RESPONSE_CHAIN'/);
  assert.match(migration, /'NO_VALID_UNIT_RESPONSE_CHAIN'/);
  assert.equal(
    [...migration.matchAll(/VALIDATE CONSTRAINT "teras_diagnostic_.+?_provenance_check"/g)].length,
    3,
  );
});

test("operational checks can retain aggregate exception baselines safely", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "teras_diagnostic_provenance_check_runs"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "teras_diagnostic_provenance_check_counts"/);
  assert.match(migration, /"exception_count" integer NOT NULL/);
  assert.match(
    migration,
    /CHECK \("reason" IN \('NO_VALID_RESPONSE_CHAIN', 'NO_VALID_UNIT_RESPONSE_CHAIN'\)\)/,
  );
});

test("schema check reports aggregate counts and warns only on increases", () => {
  assert.match(schemaCheck, /pg_advisory_xact_lock/);
  assert.match(schemaCheck, /TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS entity_type=% reason=% count=% delta=%/);
  assert.match(schemaCheck, /IF previous_run_id IS NOT NULL AND exception_group\.delta > 0 THEN/);
  assert.match(schemaCheck, /TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS_INCREASE/);
  assert.doesNotMatch(
    schemaCheck,
    /entity_id|profile_id|session_id|competency_unit_id|details/,
  );
});