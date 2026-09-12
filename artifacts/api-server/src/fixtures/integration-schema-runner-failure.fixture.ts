import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

assert.ok(databaseUrl, "fixture requires DATABASE_URL");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM teras_schema_runner_failure_contract",
  );
  assert.equal(
    result.rows[0]?.count,
    "0",
    "isolated schema bootstrap must copy table structure without public rows",
  );
  throw new Error("intentional integration fixture failure");
} finally {
  await client.end();
}