import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(new URL("../../lib/db/migrations/0034_solar_pv_shared_learning_baseline.sql", import.meta.url), "utf8");
const seed = readFileSync(new URL("./seed.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../../artifacts/api-server/src/lib/teras.ts", import.meta.url), "utf8");
const learningRoute = readFileSync(new URL("../../artifacts/api-server/src/routes/learning.ts", import.meta.url), "utf8");
const transition = readFileSync(new URL("../../artifacts/api-server/src/lib/learning-transition.ts", import.meta.url), "utf8");
const lmsSchema = readFileSync(new URL("../../lib/db/src/schema/lms.ts", import.meta.url), "utf8");
const postMerge = readFileSync(new URL("../post-merge.sh", import.meta.url), "utf8");

const modules = [
  ["M01", "Fundamentals", "E01"],
  ["M02", "Measurement & Interpretation", "E02"],
  ["M03", "Safety & Work Practice", "E03"],
  ["M04", "System Architecture", "E04"],
  ["M05", "Drawing & Work Preparation", "E05"],
  ["M06", "Mechanical Installation", "E06"],
  ["M07", "Electrical Installation", "E07"],
  ["M08", "System Configuration & Integration", "E08"],
  ["M09", "Testing & Commissioning", "E09"],
  ["M10", "O&M & Basic Troubleshooting", "E10"],
];

test("Solar PV baseline keeps one canonical M01-M10 definition", () => {
  for (const [code, name, evidenceId] of modules) {
    assert.match(migration, new RegExp(`'${code}','${name.replace(/[&]/g, "\\&")}'`));
    assert.match(migration, new RegExp(`'${evidenceId}'`));
  }
  assert.match(seed, /pathwayBaselineModulesTable/);
  assert.match(seed, /baselineModulesTable/);
  assert.match(seed, /assessmentId/);
  assert.match(seed, /evidenceRequirementId/);
  assert.match(seed, /gateCode/);
  assert.match(seed, /for \(const pathwayId of \["path-a"\]\)/);
  assert.doesNotMatch(seed, /course-module-\$\{moduleId\}-\$\{pathwayId\}/);
  assert.match(migration, /pathway_id = 'path-b' AND id LIKE 'course-module-m%-path-b'/);
});

test("pathway contracts remain explicitly differentiated", () => {
  assert.match(migration, /Observed capability assessment/);
  assert.match(migration, /Pre-certification readiness assessment/);
  assert.match(migration, /Capability Portfolio entry/);
  assert.match(migration, /Certification Readiness Portfolio entry/);
  assert.match(migration, /'capability achievement'/);
  assert.match(migration, /'readiness'/);
  for (const legacy of ["b01", "b02", "b03", "b04", "b05", "b06", "b07", "b08"]) {
    assert.match(seed, new RegExp(`${legacy}:`));
  }
  assert.match(api, /learningBaselinesTable/);
  assert.match(api, /pathwayBaselineModulesTable/);
  assert.match(api, /pathwayModuleContractsTable/);
  assert.match(api, /legacyModuleMappingsTable/);
  assert.match(api, /db\.select\(\)\.from\(learningBaselinesTable\)/);
  assert.match(api, /db\.select\(\)\.from\(baselineModulesTable\)/);
  assert.match(api, /db\.select\(\)\.from\(pathwayBaselineModulesTable\)/);
  assert.match(api, /db\.select\(\)\.from\(pathwayModuleContractsTable\)/);
  assert.match(api, /db\.select\(\)\.from\(legacyModuleMappingsTable\)/);
  assert.match(learningRoute, /pathwayBaselineModulesTable/);
  assert.match(learningRoute, /sharedCourseIds/);
  assert.match(learningRoute, /link\.status !== "ARCHIVED"/);
  assert.match(learningRoute, /course\.modules = course\.modules\.filter\(module => sharedModuleIds\.has\(module\.moduleId\)\)/);
  assert.match(api, /export async function pathwayHasModule/);
  assert.match(api, /export async function pathwayHasActivity/);
  assert.match(api, /No active pathway module contracts configured/);
  assert.match(api, /zero active pathway contract requirements/);
  assert.match(api, /assessmentId/);
  assert.match(transition, /sharedSelection/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS teras_activity_completion_activity_pathway_fk/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS teras_outcome_verification_activity_pathway_fk/);
  assert.doesNotMatch(lmsSchema, /name: "teras_activity_completion_activity_pathway_fk"/);
  assert.doesNotMatch(lmsSchema, /name: "teras_outcome_verification_activity_pathway_fk"/);
  assert.match(postMerge, /run seed\n/);
  assert.match(postMerge, /run test:solar-pv-baseline-integration/);
});