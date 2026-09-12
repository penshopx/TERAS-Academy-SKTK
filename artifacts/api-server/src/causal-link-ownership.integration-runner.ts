import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "causal_link_ownership",
  testFile: "./src/causal-link-ownership.integration.ts",
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});