import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
const forcedTerminationRunnerFixture =
  "./src/fixtures/integration-schema-runner-forced-termination-runner.fixture.ts";
const successFixture = "./src/fixtures/integration-schema-runner-success.fixture.ts";

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

async function waitForFile(file: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return (await readFile(file, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for fixture marker ${file}`);
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

test("the next harness run reaps a schema orphaned by forced termination without touching active or unknown schemas", {
  skip: !databaseUrl,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "schema-runner-forced-termination-"));
  const markerFile = join(directory, "orphan-schema.txt");
  const contractPrefix = "schema_runner_forced";
  const activeName = `${contractPrefix}_active_${crypto.randomUUID().replaceAll("-", "")}`;
  const unknownName = `${contractPrefix}_unknown_${crypto.randomUUID().replaceAll("-", "")}`;
  const owner = new Client({ connectionString: databaseUrl });
  const inspector = new Client({ connectionString: databaseUrl });
  let orphanName = "";
  let harness: ReturnType<typeof spawn> | undefined;
  await owner.connect();
  await inspector.connect();
  try {
    await initializeIntegrationSchema(owner, activeName, contractPrefix);
    await owner.query(`CREATE SCHEMA "${unknownName}"`);

    harness = spawn(
      "pnpm",
      [
        "--filter",
        "@workspace/api-server",
        "exec",
        "tsx",
        forcedTerminationRunnerFixture,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        env: {
          ...process.env,
          NODE_ENV: "test",
          SCHEMA_RUNNER_FORCED_PREFIX: contractPrefix,
          SCHEMA_RUNNER_MARKER_FILE: markerFile,
        },
        stdio: "ignore",
      },
    );
    assert.ok(harness.pid);
    orphanName = await waitForFile(markerFile);
    assert.equal(await schemaExists(inspector, orphanName), true);

    process.kill(-harness.pid, "SIGKILL");
    await once(harness, "exit");

    await runIsolatedIntegrationTest({
      schemaPrefix: contractPrefix,
      testFile: successFixture,
      staleSchemaAgeMs: 0,
    });

    assert.equal(await schemaExists(inspector, orphanName), false);
    assert.equal(await schemaExists(inspector, activeName), true);
    assert.equal(await schemaExists(inspector, unknownName), true);
  } finally {
    if (harness?.pid && harness.exitCode === null && harness.signalCode === null) {
      try {
        process.kill(-harness.pid, "SIGKILL");
      } catch {
        // The process group may already have exited.
      }
    }
    if (orphanName) {
      await inspector.query(`DROP SCHEMA IF EXISTS "${orphanName}" CASCADE`);
    }
    await inspector.query(`DROP SCHEMA IF EXISTS "${unknownName}" CASCADE`);
    await owner.query(`DROP SCHEMA IF EXISTS "${activeName}" CASCADE`);
    await owner.end();
    await inspector.end();
    await rm(directory, { recursive: true, force: true });
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