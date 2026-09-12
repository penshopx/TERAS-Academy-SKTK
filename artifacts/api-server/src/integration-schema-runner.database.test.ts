import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const setupFixture = "./src/fixtures/integration-schema-runner-setup.fixture.ts";
const afterSetupFixture = "./src/fixtures/integration-schema-runner-after-setup.fixture.ts";

async function withMarkerFile(run: (markerFile: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "schema-runner-contract-"));
  const markerFile = join(directory, "execution-order.txt");
  const previousMarkerFile = process.env.SCHEMA_RUNNER_MARKER_FILE;
  process.env.SCHEMA_RUNNER_MARKER_FILE = markerFile;
  try {
    await run(markerFile);
  } finally {
    if (previousMarkerFile === undefined) {
      delete process.env.SCHEMA_RUNNER_MARKER_FILE;
    } else {
      process.env.SCHEMA_RUNNER_MARKER_FILE = previousMarkerFile;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

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

test("setup receives the disposable DATABASE_URL and extra environment before the test file runs", {
  skip: !databaseUrl,
}, async () => {
  await withMarkerFile(async (markerFile) => {
    await runIsolatedIntegrationTest({
      schemaPrefix: "schema_runner_setup",
      testFile: afterSetupFixture,
      setupCommand: [
        "pnpm",
        "--filter",
        "@workspace/api-server",
        "exec",
        "tsx",
        setupFixture,
      ],
      setupEnvironment: {
        SCHEMA_RUNNER_EXPECTED_ENV: "setup-environment-value",
        DATABASE_URL: "postgres://must-not-override-disposable-schema.invalid/test",
        NODE_ENV: "must-not-override-test",
      },
    });

    assert.equal(await readFile(markerFile, "utf8"), "setup\ntest\n");
  });
});

test("a failing setup command prevents the test file from running", {
  skip: !databaseUrl,
}, async () => {
  await withMarkerFile(async (markerFile) => {
    await assert.rejects(
      runIsolatedIntegrationTest({
        schemaPrefix: "schema_runner_setup",
        testFile: afterSetupFixture,
        setupCommand: [
          "pnpm",
          "--filter",
          "@workspace/api-server",
          "exec",
          "tsx",
          setupFixture,
        ],
        setupEnvironment: {
          SCHEMA_RUNNER_EXPECTED_ENV: "setup-environment-value",
          SCHEMA_RUNNER_SETUP_SHOULD_FAIL: "true",
        },
      }),
      /failed with exit code 1/,
    );

    assert.equal(await readFile(markerFile, "utf8"), "setup\n");
  });
});