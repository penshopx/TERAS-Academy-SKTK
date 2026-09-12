import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "learning_resource_progress",
  testFile: "./src/learning-resource-progress-context.integration.ts",
  setupCommand: [
    "pnpm",
    "--filter",
    "@workspace/api-server",
    "exec",
    "tsx",
    "./src/fixtures/learning-resource-progress-context-setup.fixture.ts",
  ],
  setupEnvironment: {
    TERAS_ENABLE_DEMO_FIXTURES: "1",
  },
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});