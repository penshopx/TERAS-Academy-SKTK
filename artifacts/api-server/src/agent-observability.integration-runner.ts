import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "agent_health",
  testFile: "./src/agent-observability.integration.ts",
  setupCommand: ["bash", "-c", "psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f ../../lib/db/migrations/0051_agent_run_ledger.sql -f ../../lib/db/migrations/0056_agent_run_observability_cursor.sql -f ../../lib/db/migrations/0061_agent_health_days.sql"],
}).catch(error => { console.error(error); process.exitCode = 1; });