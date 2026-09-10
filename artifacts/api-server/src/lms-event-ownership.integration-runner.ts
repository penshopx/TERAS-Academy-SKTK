import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "lms_event_ownership",
  testFile: "./src/lms-event-ownership.integration.ts",
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});