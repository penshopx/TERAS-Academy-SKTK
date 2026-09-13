import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "database_protections_bootstrap",
  testFile: "./src/database-protections.bootstrap.integration.ts",
  useEmptyDatabase: true,
  setupCommand: [
    "bash",
    "-c",
    "cd ../.. && bash scripts/bootstrap-database-protections.sh",
  ],
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});