import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "diagnostic_integration",
  testFile: "./src/diagnostic.integration.ts",
  excludeTables: [
    "teras_diagnostic_templates",
    "teras_diagnostic_questions",
    "teras_diagnostic_options",
    "teras_diagnostic_sessions",
    "teras_diagnostic_responses",
    "teras_diagnostic_profiles",
    "teras_diagnostic_profile_items",
    "teras_diagnostic_gaps",
    "teras_diagnostic_recommendations",
    "teras_diagnostic_safety_flags",
    "teras_diagnostic_audit_events",
    "teras_diagnostic_recommendation_follow_ups",
  ],
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});