import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "export_retry_cleanup_plan",
  testFile: "./src/readiness-export-retry-cleanup-query.integration.ts",
  useEmptyDatabase: true,
  setupCommand: ["pnpm", "--filter", "@workspace/db", "run", "push-force"],
}).then(
  () => process.stdout.write("readiness export retry cleanup query plan passed\n"),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);