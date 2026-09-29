import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "evidence_triage",
  testFile: "./src/evidence-triage.integration.ts",
  setupCommand: ["bash", "-c", "pnpm --filter @workspace/scripts exec tsx ./src/seed.ts --demo && psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f ../../lib/db/migrations/0051_agent_run_ledger.sql -f ../../lib/db/migrations/0060_evidence_triage_scope_indexes.sql"],
  setupEnvironment: { TERAS_ENABLE_DEMO_FIXTURES: "1" },
}).catch(error => { console.error(error); process.exitCode = 1; });