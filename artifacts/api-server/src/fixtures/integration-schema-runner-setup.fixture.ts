import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
const expectedEnvironment = process.env.SCHEMA_RUNNER_EXPECTED_ENV;
const markerFile = process.env.SCHEMA_RUNNER_MARKER_FILE;

assert.ok(databaseUrl, "setup fixture requires DATABASE_URL");
assert.equal(expectedEnvironment, "setup-environment-value");

const url = new URL(databaseUrl);
const searchPath = url.searchParams.get("options")?.match(/search_path=([a-z0-9_]+)/)?.[1];
assert.ok(searchPath, "setup fixture must receive a disposable schema search_path");
assert.match(searchPath, /^schema_runner_setup_/);

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const currentSchema = await client.query<{ current_schema: string }>(
    "SELECT current_schema()",
  );
  assert.equal(currentSchema.rows[0]?.current_schema, searchPath);
  if (process.env.SCHEMA_RUNNER_EXPECTED_ROLE) {
    const role = await client.query<{ current_role: string; rolcreatedb: boolean }>(
      "SELECT current_user AS current_role, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(role.rows[0]?.current_role, process.env.SCHEMA_RUNNER_EXPECTED_ROLE);
    assert.equal(role.rows[0]?.rolcreatedb, false);
  }
  await client.query(`
    CREATE TABLE schema_runner_setup_contract (
      environment_value text NOT NULL
    )
  `);
  await client.query(
    "INSERT INTO schema_runner_setup_contract (environment_value) VALUES ($1)",
    [expectedEnvironment],
  );
} finally {
  await client.end();
}

if (markerFile) {
  await appendFile(markerFile, "setup\n");
}

if (process.env.SCHEMA_RUNNER_SETUP_SHOULD_HANG === "true") {
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
}

if (process.env.SCHEMA_RUNNER_SETUP_SHOULD_FAIL === "true") {
  throw new Error("intentional setup fixture failure");
}
