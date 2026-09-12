import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "baseline_authoring",
  testFile: "./src/baseline-authoring.integration.ts",
  setupCommand: ["bash", "../../scripts/baseline-versioning.integration.setup.sh"],
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});