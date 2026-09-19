import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "trainer_intelligence",
  testFile: "./src/trainer-intelligence.integration.ts",
  setupCommand: [
    "bash",
    "-c",
    "pnpm --filter @workspace/scripts exec tsx ./src/seed.ts --demo && psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f ../../lib/db/migrations/0051_agent_run_ledger.sql",
  ],
  setupEnvironment: { TERAS_ENABLE_DEMO_FIXTURES: "1" },
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});