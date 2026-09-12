import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
const markerFile = process.env.SCHEMA_RUNNER_MARKER_FILE;

assert.ok(databaseUrl, "test fixture requires DATABASE_URL");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const result = await client.query<{ environment_value: string }>(
    "SELECT environment_value FROM schema_runner_setup_contract",
  );
  assert.deepEqual(result.rows, [{
    environment_value: "setup-environment-value",
  }]);
} finally {
  await client.end();
}

if (markerFile) {
  await appendFile(markerFile, "test\n");
}