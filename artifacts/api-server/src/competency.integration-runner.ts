import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "competency_integration",
  testFile: "./src/competency.integration.ts",
  excludeTables: [
    "teras_competency_frameworks",
    "teras_competency_units",
    "teras_pathway_competency_units",
    "teras_competency_unit_outcomes",
    "teras_competency_unit_practice_tasks",
    "teras_competency_unit_evidence_requirements",
    "teras_competency_unit_simulations",
    "teras_competency_unit_safety_rules",
  ],
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});