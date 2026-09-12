import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "causal_link_bootstrap",
  testFile: "./src/causal-link-ownership.integration.ts",
  useEmptyDatabase: true,
  setupCommand: [
    "bash",
    "-c",
    "cd ../.. && bash scripts/bootstrap-causal-link-ownership.sh && pnpm --filter @workspace/scripts exec tsx ./src/seed.ts --demo",
  ],
  setupEnvironment: {
    TERAS_ENABLE_DEMO_FIXTURES: "1",
  },
  testEnvironment: {
    CAUSAL_LINK_BOOTSTRAP_TEST: "1",
  },
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});