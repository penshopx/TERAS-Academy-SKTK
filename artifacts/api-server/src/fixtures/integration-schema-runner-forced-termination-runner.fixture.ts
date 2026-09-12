import { runIsolatedIntegrationTest } from "../integration-schema-runner";

const schemaPrefix = process.env.SCHEMA_RUNNER_FORCED_PREFIX;

if (!schemaPrefix) {
  throw new Error("SCHEMA_RUNNER_FORCED_PREFIX is required");
}

await runIsolatedIntegrationTest({
  schemaPrefix,
  testFile: "./src/fixtures/integration-schema-runner-forced-termination.fixture.ts",
});