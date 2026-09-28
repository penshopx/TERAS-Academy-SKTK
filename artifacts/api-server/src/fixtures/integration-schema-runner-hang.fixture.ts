import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const markerFile = process.env.SCHEMA_RUNNER_MARKER_FILE;

assert.ok(databaseUrl, "hanging fixture requires DATABASE_URL");
assert.ok(markerFile, "hanging fixture requires SCHEMA_RUNNER_MARKER_FILE");

if (process.env.SCHEMA_RUNNER_EXPECTED_ROLE) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const result = await client.query<{
    role_name: string;
    can_create_database: boolean;
    schema_name: string;
    backend_pid: number;
  }>(`
    SELECT current_user AS role_name,
           (rolcreatedb OR rolsuper) AS can_create_database,
           current_schema() AS schema_name,
           pg_backend_pid() AS backend_pid
    FROM pg_roles WHERE rolname = current_user
  `);
  const session = result.rows[0];
  assert.equal(session?.role_name, process.env.SCHEMA_RUNNER_EXPECTED_ROLE);
  assert.equal(session.can_create_database, false);
  assert.match(session.schema_name, /^schema_runner_ci_timeout_/);
  if (process.env.SCHEMA_RUNNER_HANG_IN_TRANSACTION === "true") {
    await client.query("CREATE TABLE schema_runner_timeout_lock (id integer)");
    await client.query("BEGIN");
    await client.query("LOCK TABLE schema_runner_timeout_lock IN ACCESS EXCLUSIVE MODE");
    await appendFile(markerFile, `schema:${session.schema_name}\n`);
  }
  await appendFile(markerFile, `backend:${session.backend_pid}\n`);
  // Keep the database session open until the runner kills this process group.
}
await appendFile(
  markerFile,
  process.env.SCHEMA_RUNNER_HANG_IN_TRANSACTION === "true" ? "test\n" : "setup\n",
);
await new Promise(() => {
  setInterval(() => {}, 60_000);
});