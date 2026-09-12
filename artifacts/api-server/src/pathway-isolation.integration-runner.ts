import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "pathway_isolation",
  testFile: "./src/pathway-isolation.integration.ts",
  setupCommand: [
    "bash",
    "-c",
    "pnpm --filter @workspace/scripts exec tsx ./src/seed.ts --demo && psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f ../../lib/db/migrations/0039_baseline_versioned_publishing.sql",
  ],
  setupEnvironment: {
    TERAS_ENABLE_DEMO_FIXTURES: "1",
  },
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});