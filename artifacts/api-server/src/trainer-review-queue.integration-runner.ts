import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "trainer_review_queue",
  testFile: "./src/trainer-review-queue.integration.ts",
  setupCommand: [
    "pnpm",
    "--filter",
    "@workspace/scripts",
    "exec",
    "tsx",
    "./src/seed.ts",
    "--demo",
  ],
  setupEnvironment: {
    TERAS_ENABLE_DEMO_FIXTURES: "1",
  },
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});