import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  cleanupStaleIntegrationSchemas,
  initializeIntegrationSchema,
  runIsolatedIntegrationTest,
} from "./integration-schema-runner";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
const schemaPrefix = "schema_runner_test";
const staleSchemaAgeMs = 60 * 60 * 1000;

function schemaName(label: string) {
  return `${schemaPrefix}_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function schemaExists(client: InstanceType<typeof Client>, name: string) {
  const result = await client.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
    [name],
  );
  return result.rows[0]?.exists ?? false;
}

test("initialization interruption cannot leave an unowned schema", {
  skip: !databaseUrl,
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const name = schemaName("interrupted");
  await client.connect();
  try {
    await assert.rejects(
      initializeIntegrationSchema(client, name, schemaPrefix, () => {
        throw new Error("simulated forced interruption before metadata");
      }),
      /simulated forced interruption/,
    );
    assert.equal(await schemaExists(client, name), false);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await client.end();
  }
});

test("cleanup keeps an active old schema, drops it once inactive, and ignores unknown schemas", {
  skip: !databaseUrl,
}, async () => {
  const owner = new Client({ connectionString: databaseUrl });
  const cleaner = new Client({ connectionString: databaseUrl });
  const activeName = schemaName("active");
  const unknownName = schemaName("unknown");
  let ownerEnded = false;
  await owner.connect();
  await cleaner.connect();
  try {
    await initializeIntegrationSchema(owner, activeName, schemaPrefix);
    await owner.query(
      `COMMENT ON SCHEMA "${activeName}" IS '${JSON.stringify({
        kind: "teras-integration-test",
        version: 1,
        schemaPrefix,
        createdAt: "2000-01-01T00:00:00.000Z",
      })}'`,
    );
    await cleaner.query(`CREATE SCHEMA "${unknownName}"`);

    await cleanupStaleIntegrationSchemas(cleaner, schemaPrefix, staleSchemaAgeMs);
    assert.equal(await schemaExists(cleaner, activeName), true);
    assert.equal(await schemaExists(cleaner, unknownName), true);

    await owner.end();
    ownerEnded = true;
    await cleanupStaleIntegrationSchemas(cleaner, schemaPrefix, staleSchemaAgeMs);
    assert.equal(await schemaExists(cleaner, activeName), false);
    assert.equal(await schemaExists(cleaner, unknownName), true);
  } finally {
    if (!ownerEnded) {
      await owner.end();
    }
    await cleaner.query(`DROP SCHEMA IF EXISTS "${activeName}" CASCADE`);
    await cleaner.query(`DROP SCHEMA IF EXISTS "${unknownName}" CASCADE`);
    await cleaner.end();
  }
});

test("a normally failing child command still removes its empty disposable schema", {
  skip: !databaseUrl,
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const contractPrefix = "schema_runner_failure";
  const publicTable = "teras_schema_runner_failure_contract";
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.${publicTable} (
        id integer PRIMARY KEY
      )
    `);
    await client.query(`TRUNCATE public.${publicTable}`);
    await client.query(`INSERT INTO public.${publicTable} (id) VALUES (1)`);

    await assert.rejects(
      runIsolatedIntegrationTest({
        schemaPrefix: contractPrefix,
        testFile: "./src/fixtures/integration-schema-runner-failure.fixture.ts",
      }),
      /failed with exit code 1/,
    );

    const remainingSchemas = await client.query<{ schema_name: string }>(
      `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name LIKE $1 ESCAPE '\\'
      `,
      [`${contractPrefix.replaceAll("_", "\\_")}_%`],
    );
    assert.deepEqual(remainingSchemas.rows, []);
  } finally {
    await client.query(`DROP TABLE IF EXISTS public.${publicTable}`);
    await client.end();
  }
});