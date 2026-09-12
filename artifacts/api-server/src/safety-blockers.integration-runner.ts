import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "safety_blockers",
  testFile: "./src/safety-blockers.integration.ts",
  setupCommand: ["pnpm", "--filter", "@workspace/scripts", "exec", "tsx", "./src/seed.ts", "--demo"],
  setupEnvironment: {
    TERAS_ENABLE_DEMO_FIXTURES: "1",
  },
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});