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
const hangFixture = "./src/fixtures/integration-schema-runner-hang.fixture.ts";
const successFixture = "./src/fixtures/integration-schema-runner-success.fixture.ts";

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function withNoCreateDbRole(
  admin: InstanceType<typeof Client>,
  run: (roleDatabaseUrl: string, roleName: string) => Promise<void>,
) {
  const roleName = `schema_runner_ci_${crypto.randomUUID().replaceAll("-", "")}`;
  const password = crypto.randomUUID().replaceAll("-", "");
  const roleIdentifier = quoteIdentifier(roleName);
  const databaseName = new URL(databaseUrl!).pathname.slice(1);
  const databaseIdentifier = quoteIdentifier(decodeURIComponent(databaseName));
  await admin.query(
    `CREATE ROLE ${roleIdentifier} LOGIN PASSWORD '${password}' NOCREATEDB`,
  );
  try {
    await admin.query(
      `GRANT CONNECT, CREATE ON DATABASE ${databaseIdentifier} TO ${roleIdentifier}`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`);
    await admin.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roleIdentifier}`,
    );
    const roleUrl = new URL(databaseUrl!);
    roleUrl.username = roleName;
    roleUrl.password = password;
    await run(roleUrl.toString(), roleName);
  } finally {
    await admin.query(`DROP OWNED BY ${roleIdentifier}`);
    await admin.query(`DROP ROLE ${roleIdentifier}`);
  }
}

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

async function databasesWithPrefix(
  client: InstanceType<typeof Client>,
  prefix: string,
) {
  const result = await client.query<{ database_name: string }>(
    `
      SELECT datname AS database_name
      FROM pg_database
      WHERE datname LIKE $1 ESCAPE '\\'
      ORDER BY datname
    `,
    [`${prefix.replaceAll("_", "\\_")}_%`],
  );
  return result.rows.map(({ database_name: databaseName }) => databaseName);
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

test("cleanup reports one failed schema after checking the others and releases every acquired lock", {
  skip: !databaseUrl,
}, async () => {
  const cleaner = new Client({ connectionString: databaseUrl });
  const inspector = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `schema_cleanup_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const failedName = `${contractPrefix}_failure`;
  const reapedName = `${contractPrefix}_success`;
  await cleaner.connect();
  await inspector.connect();
  try {
    for (const name of [failedName, reapedName]) {
      await cleaner.query(`CREATE SCHEMA "${name}"`);
      await cleaner.query(
        `COMMENT ON SCHEMA "${name}" IS '${JSON.stringify({
          kind: "teras-integration-test",
          version: 1,
          schemaPrefix: contractPrefix,
          createdAt: "2000-01-01T00:00:00.000Z",
        })}'`,
      );
    }

    const originalQuery = cleaner.query.bind(cleaner);
    let simulatedFailurePending = true;
    let actualFailedName = "";
    const failingCleaner = Object.create(cleaner) as InstanceType<typeof Client>;
    failingCleaner.query = (async (query: unknown, values?: unknown[]) => {
      if (
        simulatedFailurePending &&
        typeof query === "string" &&
        query.startsWith("DROP SCHEMA")
      ) {
        simulatedFailurePending = false;
        actualFailedName = query.match(/"([^"]+)"/)?.[1] ?? "";
        throw new Error("simulated stale schema drop failure");
      }
      return originalQuery(query as never, values as never);
    }) as InstanceType<typeof Client>["query"];

    let reportedError: unknown;
    const originalConsoleError = console.error;
    await withMarkerFile(async (markerFile) => {
      console.error = (message: unknown, error: unknown) => {
        assert.match(String(message), new RegExp(contractPrefix));
        reportedError = error;
      };
      try {
        await runIsolatedIntegrationTest({
          schemaPrefix: contractPrefix,
          testFile: successFixture,
          cleanupStaleSchemas: async () => {
            await cleanupStaleIntegrationSchemas(
              failingCleaner,
              contractPrefix,
              staleSchemaAgeMs,
            );
          },
        });
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(await readFile(markerFile, "utf8"), "test\n");
    });

    assert.ok(actualFailedName);
    assert.ok(reportedError instanceof AggregateError);
    assert.match(
      reportedError.message,
      /Failed to clean up 1 stale integration schema operation/,
    );
    assert.equal(reportedError.errors.length, 1);
    assert.match(reportedError.errors[0].message, new RegExp(actualFailedName));
    assert.match(
      String(reportedError.errors[0].cause),
      /simulated stale schema drop failure/,
    );
    const actualReapedName = actualFailedName === failedName ? reapedName : failedName;
    assert.equal(await schemaExists(inspector, actualFailedName), true);
    assert.equal(await schemaExists(inspector, actualReapedName), false);
    const lock = await inspector.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired",
      [actualFailedName, 847_201],
    );
    assert.equal(lock.rows[0]?.acquired, true);
    await inspector.query(
      "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
      [actualFailedName, 847_201],
    );
  } finally {
    await cleaner.query(`DROP SCHEMA IF EXISTS "${failedName}" CASCADE`);
    await cleaner.query(`DROP SCHEMA IF EXISTS "${reapedName}" CASCADE`);
    await cleaner.end();
    await inspector.end();
  }
});

test("cleanup reports a failed lock release and continues cleaning later schemas", {
  skip: !databaseUrl,
}, async () => {
  const cleaner = new Client({ connectionString: databaseUrl });
  const inspector = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `schema_unlock_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const schemaNames = [
    `${contractPrefix}_first`,
    `${contractPrefix}_second`,
  ];
  let failedUnlockName = "";
  let dropAfterFailedUnlock = false;
  await cleaner.connect();
  await inspector.connect();
  const originalQuery = cleaner.query.bind(cleaner);
  try {
    for (const name of schemaNames) {
      await cleaner.query(`CREATE SCHEMA "${name}"`);
      await cleaner.query(
        `COMMENT ON SCHEMA "${name}" IS '${JSON.stringify({
          kind: "teras-integration-test",
          version: 1,
          schemaPrefix: contractPrefix,
          createdAt: "2000-01-01T00:00:00.000Z",
        })}'`,
      );
    }

    let simulatedFailurePending = true;
    const failingCleaner = Object.create(cleaner) as InstanceType<typeof Client>;
    failingCleaner.query = (async (query: unknown, values?: unknown[]) => {
      if (
        simulatedFailurePending &&
        typeof query === "string" &&
        query.includes("pg_advisory_unlock")
      ) {
        simulatedFailurePending = false;
        failedUnlockName = String(values?.[0] ?? "");
        throw new Error("simulated cleanup advisory unlock failure");
      }
      if (
        failedUnlockName &&
        typeof query === "string" &&
        query.startsWith("DROP SCHEMA")
      ) {
        dropAfterFailedUnlock = true;
      }
      return originalQuery(query as never, values as never);
    }) as InstanceType<typeof Client>["query"];

    let reportedError: unknown;
    try {
      await cleanupStaleIntegrationSchemas(
        failingCleaner,
        contractPrefix,
        staleSchemaAgeMs,
      );
    } catch (error) {
      reportedError = error;
    }

    assert.ok(failedUnlockName);
    assert.equal(dropAfterFailedUnlock, true);
    assert.ok(reportedError instanceof AggregateError);
    assert.match(
      reportedError.message,
      /Failed to clean up 1 stale integration schema operation/,
    );
    assert.equal(reportedError.errors.length, 1);
    assert.match(
      reportedError.errors[0].message,
      /Failed to release cleanup advisory lock/,
    );
    assert.match(reportedError.errors[0].message, new RegExp(failedUnlockName));
    assert.match(
      String(reportedError.errors[0].cause),
      /simulated cleanup advisory unlock failure/,
    );
    for (const name of schemaNames) {
      assert.equal(await schemaExists(inspector, name), false);
    }

    const lock = await inspector.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired",
      [failedUnlockName, 847_201],
    );
    assert.equal(lock.rows[0]?.acquired, false);
  } finally {
    if (failedUnlockName) {
      await originalQuery(
        "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
        [failedUnlockName, 847_201],
      );
    }
    for (const name of schemaNames) {
      await cleaner.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    }
    await cleaner.end();
    await inspector.end();
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

test("schema mode succeeds while empty-database mode diagnoses CREATEDB for a real restricted role", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await withNoCreateDbRole(admin, async (roleDatabaseUrl, roleName) => {
      const previousDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = roleDatabaseUrl;
      try {
        await withMarkerFile(async (markerFile) => {
          await runIsolatedIntegrationTest({
            schemaPrefix: "schema_runner_nocreatedb",
            testFile: successFixture,
          });
          assert.equal(await readFile(markerFile, "utf8"), "test\n");
        });

        await withMarkerFile(async (markerFile) => {
          await assert.rejects(
            runIsolatedIntegrationTest({
              schemaPrefix: "database_runner_nocreatedb",
              testFile: successFixture,
              useEmptyDatabase: true,
            }),
            (error: Error) => {
              assert.match(error.message, /CREATEDB/);
              assert.match(error.message, new RegExp(`Current role: ${roleName}`));
              return true;
            },
          );
          await assert.rejects(readFile(markerFile, "utf8"), { code: "ENOENT" });
        });
      } finally {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    });
  } finally {
    await admin.end();
  }
});

test("a failing setup command prevents the test file from running", {
  skip: !databaseUrl,
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `schema_runner_setup_f_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await client.connect();
  try {
    await withMarkerFile(async (markerFile) => {
      await assert.rejects(
        runIsolatedIntegrationTest({
          schemaPrefix: contractPrefix,
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
      const remainingSchemas = await client.query<{ schema_name: string }>(
        `
          SELECT schema_name
          FROM information_schema.schemata
          WHERE schema_name LIKE $1 ESCAPE '\\'
        `,
        [`${contractPrefix.replaceAll("_", "\\_")}_%`],
      );
      assert.deepEqual(remainingSchemas.rows, []);
    });
  } finally {
    const remainingSchemas = await client.query<{ schema_name: string }>(
      `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name LIKE $1 ESCAPE '\\'
      `,
      [`${contractPrefix.replaceAll("_", "\\_")}_%`],
    );
    for (const { schema_name: remainingSchema } of remainingSchemas.rows) {
      await client.query(`DROP SCHEMA IF EXISTS "${remainingSchema}" CASCADE`);
    }
    await client.end();
  }
});

test("a timed out setup is killed, prevents the test file, and cleans up its schema", {
  skip: !databaseUrl,
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `schema_runner_setup_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await client.connect();
  try {
    await withMarkerFile(async (markerFile) => {
      const command = [
        "pnpm",
        "--filter",
        "@workspace/api-server",
        "exec",
        "tsx",
        setupFixture,
      ] as const;
      await assert.rejects(
        runIsolatedIntegrationTest({
          schemaPrefix: contractPrefix,
          testFile: afterSetupFixture,
          setupCommand: command,
          setupTimeoutMs: 2_000,
          setupEnvironment: {
            SCHEMA_RUNNER_EXPECTED_ENV: "setup-environment-value",
            SCHEMA_RUNNER_SETUP_SHOULD_HANG: "true",
          },
        }),
        new RegExp(
          `Integration command ${command.join(" ")} timed out after 2000ms`,
        ),
      );

      assert.equal(await readFile(markerFile, "utf8"), "setup\n");
      const remainingSchemas = await client.query<{ schema_name: string }>(
        `
          SELECT schema_name
          FROM information_schema.schemata
          WHERE schema_name LIKE $1 ESCAPE '\\'
        `,
        [`${contractPrefix.replaceAll("_", "\\_")}_%`],
      );
      assert.deepEqual(remainingSchemas.rows, []);
    });
  } finally {
    await client.end();
  }
});

test("a timed out setup is killed and removes its empty disposable database", {
  skip: !databaseUrl,
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `database_runner_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await client.connect();
  try {
    await withMarkerFile(async (markerFile) => {
      const command = [
        "pnpm",
        "--filter",
        "@workspace/api-server",
        "exec",
        "tsx",
        hangFixture,
      ] as const;
      await assert.rejects(
        runIsolatedIntegrationTest({
          schemaPrefix: contractPrefix,
          testFile: afterSetupFixture,
          setupCommand: command,
          setupTimeoutMs: 2_000,
          useEmptyDatabase: true,
        }),
        new RegExp(
          `Integration command ${command.join(" ")} timed out after 2000ms`,
        ),
      );

      assert.equal(await readFile(markerFile, "utf8"), "setup\n");
      assert.deepEqual(await databasesWithPrefix(client, contractPrefix), []);
    });
  } finally {
    for (const remainingDatabase of await databasesWithPrefix(client, contractPrefix)) {
      await client.query(`DROP DATABASE IF EXISTS "${remainingDatabase}" WITH (FORCE)`);
    }
    await client.end();
  }
});

test("cleanup timeout stops the runner without hiding the command failure", async () => {
  let connectionDestroyed = false;
  const never = new Promise<never>(() => {});
  const fakeAdmin = {
    connection: {
      stream: {
        destroy: () => {
          connectionDestroyed = true;
        },
      },
    },
    connect: async () => undefined,
    query: async (query: string) => {
      if (query.includes("SELECT tablename")) return { rows: [] };
      if (query.startsWith("DROP SCHEMA")) return never;
      return { rows: [] };
    },
    end: async () => undefined,
  } as unknown as InstanceType<typeof Client>;

  const startedAt = Date.now();
  await assert.rejects(
    runIsolatedIntegrationTest({
      schemaPrefix: "cleanup_timeout_test",
      testFile: "./src/fixtures/integration-schema-runner-failure.fixture.ts",
      cleanupTimeoutMs: 100,
      createAdminClient: () => fakeAdmin,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /command failed and database cleanup also failed/i);
      assert.match(String(error.errors[0]), /failed with exit code 1/);
      assert.match(
        String(error.errors[1]),
        /Integration database cleanup timed out after 100ms/,
      );
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(connectionDestroyed, true);
});
