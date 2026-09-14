import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "timeline_plan",
  testFile: "./src/capability-timeline-query.integration.ts",
  setupCommand: [
    "bash",
    "-c",
    "pnpm --filter @workspace/scripts exec tsx ./src/seed.ts --demo && psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f ../../lib/db/migrations/0040_capability_timeline_indexes.sql",
  ],
  setupEnvironment: {
    TERAS_ENABLE_DEMO_FIXTURES: "1",
  },
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});