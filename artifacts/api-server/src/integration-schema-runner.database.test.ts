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

test("cleanup combines a failed lock check with other failures and continues cleaning later schemas", {
  skip: !databaseUrl,
}, async () => {
  const cleaner = new Client({ connectionString: databaseUrl });
  const inspector = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `schema_lock_check_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const schemaNames = [
    `${contractPrefix}_first`,
    `${contractPrefix}_second`,
    `${contractPrefix}_third`,
  ];
  let failedLockName = "";
  let failedDropName = "";
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

    let lockFailurePending = true;
    let dropFailurePending = true;
    const failingCleaner = Object.create(cleaner) as InstanceType<typeof Client>;
    failingCleaner.query = (async (query: unknown, values?: unknown[]) => {
      if (
        lockFailurePending &&
        typeof query === "string" &&
        query.includes("pg_try_advisory_lock")
      ) {
        lockFailurePending = false;
        failedLockName = String(values?.[0] ?? "");
        throw new Error("simulated cleanup advisory lock check failure");
      }
      if (
        dropFailurePending &&
        typeof query === "string" &&
        query.startsWith("DROP SCHEMA")
      ) {
        dropFailurePending = false;
        failedDropName = query.match(/"([^"]+)"/)?.[1] ?? "";
        throw new Error("simulated stale schema drop failure after lock check");
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

    assert.ok(failedLockName);
    assert.ok(failedDropName);
    assert.notEqual(failedLockName, failedDropName);
    assert.ok(reportedError instanceof AggregateError);
    assert.match(
      reportedError.message,
      /Failed to clean up 2 stale integration schema operation/,
    );
    assert.equal(reportedError.errors.length, 2);
    assert.match(
      reportedError.errors[0].message,
      new RegExp(`Failed to check cleanup advisory lock.*${failedLockName}`),
    );
    assert.match(
      String(reportedError.errors[0].cause),
      /simulated cleanup advisory lock check failure/,
    );
    assert.match(reportedError.errors[1].message, new RegExp(failedDropName));
    assert.match(
      String(reportedError.errors[1].cause),
      /simulated stale schema drop failure after lock check/,
    );

    const cleanedName = schemaNames.find(
      (name) => name !== failedLockName && name !== failedDropName,
    );
    assert.ok(cleanedName);
    assert.equal(await schemaExists(inspector, failedLockName), true);
    assert.equal(await schemaExists(inspector, failedDropName), true);
    assert.equal(await schemaExists(inspector, cleanedName), false);

    for (const name of schemaNames) {
      const lock = await inspector.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired",
        [name, 847_201],
      );
      assert.equal(lock.rows[0]?.acquired, true);
      await inspector.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
        [name, 847_201],
      );
    }
  } finally {
    for (const name of schemaNames) {
      await cleaner.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await originalQuery(
        "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
        [name, 847_201],
      );
      await inspector.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
        [name, 847_201],
      );
    }
    await cleaner.end();
    await inspector.end();
  }
});

test("cleanup times out one stale schema, releases its lock, and continues with later schemas", {
  skip: !databaseUrl,
}, async () => {
  const cleaner = new Client({ connectionString: databaseUrl });
  const inspector = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `schema_timeout_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const schemaNames = [
    `${contractPrefix}_first`,
    `${contractPrefix}_second`,
  ];
  let timedOutName = "";
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

    let hangPending = true;
    const hangingCleaner = Object.create(cleaner) as InstanceType<typeof Client>;
    hangingCleaner.query = (async (query: unknown, values?: unknown[]) => {
      if (
        hangPending &&
        typeof query === "string" &&
        query.startsWith("DROP SCHEMA")
      ) {
        hangPending = false;
        timedOutName = query.match(/"([^"]+)"/)?.[1] ?? "";
        return originalQuery("SELECT pg_sleep(1)") as never;
      }
      return originalQuery(query as never, values as never);
    }) as InstanceType<typeof Client>["query"];

    let reportedError: unknown;
    try {
      await cleanupStaleIntegrationSchemas(
        hangingCleaner,
        contractPrefix,
        staleSchemaAgeMs,
        50,
      );
    } catch (error) {
      reportedError = error;
    }

    assert.ok(timedOutName);
    assert.ok(reportedError instanceof AggregateError);
    assert.equal(reportedError.errors.length, 1);
    assert.match(reportedError.errors[0].message, new RegExp(timedOutName));
    assert.match(
      String(reportedError.errors[0].cause),
      /statement timeout|timed out/i,
    );
    const cleanedName = schemaNames.find((name) => name !== timedOutName);
    assert.ok(cleanedName);
    assert.equal(await schemaExists(inspector, timedOutName), true);
    assert.equal(await schemaExists(inspector, cleanedName), false);

    const lock = await inspector.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired",
      [timedOutName, 847_201],
    );
    assert.equal(lock.rows[0]?.acquired, true);
    await inspector.query(
      "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
      [timedOutName, 847_201],
    );
  } finally {
    await originalQuery("SET statement_timeout = 0");
    for (const name of schemaNames) {
      await originalQuery(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await originalQuery(
        "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
        [name, 847_201],
      );
    }
    await cleaner.end();
    await inspector.end();
  }
});

test("discovery timeout reports its prefix, resets the session, and can be retried", {
  skip: !databaseUrl,
}, async () => {
  const cleaner = new Client({ connectionString: databaseUrl });
  const prefix = `discovery_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await cleaner.connect();
  const originalQuery = cleaner.query.bind(cleaner);
  let delayDiscovery = true;
  const slowCleaner = Object.create(cleaner) as InstanceType<typeof Client>;
  slowCleaner.query = ((query: unknown, values?: unknown[]) => {
    if (delayDiscovery && typeof query === "string" && query.includes("FROM pg_namespace n")) {
      delayDiscovery = false;
      return originalQuery("SELECT pg_sleep(1)") as never;
    }
    return originalQuery(query as never, values as never);
  }) as InstanceType<typeof Client>["query"];
  try {
    await assert.rejects(
      cleanupStaleIntegrationSchemas(slowCleaner, prefix, staleSchemaAgeMs, 200),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(prefix));
        assert.match(String(error.cause), /statement timeout|timed out/i);
        return true;
      },
    );
    const timeout = await originalQuery<{ statement_timeout: string }>("SHOW statement_timeout");
    assert.equal(timeout.rows[0]?.statement_timeout, "0");
    await cleanupStaleIntegrationSchemas(cleaner, prefix, staleSchemaAgeMs, 200);
  } finally {
    await cleaner.end();
  }
});

test("a stuck discovery query closes its connection while the runner continues on a new one", {
  skip: !databaseUrl,
}, async () => {
  const prefix = `discovery_hang_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const inspector = new Client({ connectionString: databaseUrl });
  let createdClients = 0;
  let abandonedConnectionClosed = false;
  let reportedError: unknown;
  const originalConsoleError = console.error;
  await inspector.connect();
  try {
    await withMarkerFile(async (markerFile) => {
      console.error = (message: unknown, error: unknown) => {
        assert.match(String(message), new RegExp(prefix));
        reportedError = error;
      };
      try {
        await runIsolatedIntegrationTest({
          schemaPrefix: prefix,
          testFile: successFixture,
          createAdminClient: (connectionString, connectionTimeoutMs) => {
            const client = new Client({
              connectionString,
              connectionTimeoutMillis: connectionTimeoutMs,
            });
            createdClients++;
            if (createdClients === 1) {
              const originalEnd = client.end.bind(client);
              client.end = (async () => {
                abandonedConnectionClosed = true;
                return originalEnd();
              }) as InstanceType<typeof Client>["end"];
              const originalQuery = client.query.bind(client);
              client.query = (async (query: unknown, values?: unknown[]) => {
                if (typeof query === "string" && query.includes("FROM pg_namespace n")) {
                  await originalQuery("SET statement_timeout = 0");
                  return originalQuery("SELECT pg_sleep(30)") as never;
                }
                return originalQuery(query as never, values as never);
              }) as InstanceType<typeof Client>["query"];
            }
            return client;
          },
          cleanupStaleSchemas: (client, schemaPrefix, ageMs) =>
            cleanupStaleIntegrationSchemas(client, schemaPrefix, ageMs, 100),
        });
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(await readFile(markerFile, "utf8"), "test\n");
    });
    assert.equal(createdClients, 2);
    assert.ok(reportedError instanceof Error);
    assert.match(reportedError.message, new RegExp(prefix));
    assert.match(String(reportedError.cause), /timed out after 1100ms/);
    assert.equal(abandonedConnectionClosed, true);
    const remaining = await inspector.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname LIKE $1 ESCAPE '\\'",
      [`${prefix.replaceAll("_", "\\_")}_%`],
    );
    assert.deepEqual(remaining.rows, []);
  } finally {
    console.error = originalConsoleError;
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

test("a normally failing child command under a restricted CI role still removes its disposable schema", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Client({ connectionString: databaseUrl });
  const contractPrefix = "schema_runner_failure";
  const publicTable = "teras_schema_runner_failure_contract";
  await admin.connect();
  try {
    await admin.query(`
      CREATE TABLE IF NOT EXISTS public.${publicTable} (
        id integer PRIMARY KEY
      )
    `);
    await admin.query(`TRUNCATE public.${publicTable}`);
    await admin.query(`INSERT INTO public.${publicTable} (id) VALUES (1)`);

    await withNoCreateDbRole(admin, async (roleDatabaseUrl) => {
      const previousDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = roleDatabaseUrl;
      try {
        await assert.rejects(
          runIsolatedIntegrationTest({
            schemaPrefix: contractPrefix,
            testFile: "./src/fixtures/integration-schema-runner-failure.fixture.ts",
          }),
          /failed with exit code 1/,
        );

        const remainingSchemas = await admin.query<{ schema_name: string }>(
          `
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name LIKE $1 ESCAPE '\\'
          `,
          [`${contractPrefix.replaceAll("_", "\\_")}_%`],
        );
        assert.deepEqual(remainingSchemas.rows, []);
      } finally {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    });
  } finally {
    await admin.query(`DROP TABLE IF EXISTS public.${publicTable}`);
    await admin.end();
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
  const admin = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `schema_runner_setup_f_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await admin.connect();
  try {
    await withNoCreateDbRole(admin, async (roleDatabaseUrl, roleName) => {
      const previousDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = roleDatabaseUrl;
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
                SCHEMA_RUNNER_EXPECTED_ROLE: roleName,
                SCHEMA_RUNNER_SETUP_SHOULD_FAIL: "true",
              },
            }),
            /failed with exit code 1/,
          );

          assert.equal(await readFile(markerFile, "utf8"), "setup\n");
          const remainingSchemas = await admin.query<{ schema_name: string }>(
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
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    });
  } finally {
    const remainingSchemas = await admin.query<{ schema_name: string }>(
      `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name LIKE $1 ESCAPE '\\'
      `,
      [`${contractPrefix.replaceAll("_", "\\_")}_%`],
    );
    for (const { schema_name: remainingSchema } of remainingSchemas.rows) {
      await admin.query(`DROP SCHEMA IF EXISTS "${remainingSchema}" CASCADE`);
    }
    await admin.end();
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

test("a timed out setup under a real role without CREATEDB kills its database session and removes the schema", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Client({ connectionString: databaseUrl });
  const contractPrefix = "schema_runner_ci_timeout";
  const command = [
    "pnpm",
    "--filter",
    "@workspace/api-server",
    "exec",
    "tsx",
    hangFixture,
  ] as const;
  let temporaryRoleName = "";
  await admin.connect();
  try {
    await withNoCreateDbRole(admin, async (roleDatabaseUrl, roleName) => {
      temporaryRoleName = roleName;
      const previousDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = roleDatabaseUrl;
      try {
        await withMarkerFile(async (markerFile) => {
          await assert.rejects(
            runIsolatedIntegrationTest({
              schemaPrefix: contractPrefix,
              testFile: afterSetupFixture,
              setupCommand: command,
              setupTimeoutMs: 3_000,
              setupEnvironment: { SCHEMA_RUNNER_EXPECTED_ROLE: roleName },
            }),
            new RegExp(
              `Integration command ${command.join(" ")} timed out after 3000ms`,
            ),
          );
          const marker = await readFile(markerFile, "utf8");
          const match = /^backend:(\d+)\nsetup\n$/.exec(marker);
          assert.ok(match, `Expected the restricted fixture to connect before timing out: ${marker}`);
          const backend = await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid = $1",
            [Number(match[1])],
          );
          assert.equal(backend.rowCount, 0);
          const schemas = await admin.query<{ schema_name: string }>(
            `SELECT nspname AS schema_name FROM pg_namespace WHERE nspname LIKE $1 ESCAPE '\\'`,
            [`${contractPrefix.replaceAll("_", "\\_")}_%`],
          );
          assert.deepEqual(schemas.rows, []);
        });
      } finally {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    });
    const role = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [temporaryRoleName],
    );
    assert.equal(role.rowCount, 0);
  } finally {
    await admin.end();
  }
});

test("a timed out test file under a real role without CREATEDB closes its transaction and removes the schema before dropping the role", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Client({ connectionString: databaseUrl });
  const contractPrefix = "schema_runner_ci_timeout";
  const command = [
    "pnpm",
    "--filter",
    "@workspace/api-server",
    "exec",
    "tsx",
    hangFixture,
  ] as const;
  let temporaryRoleName = "";
  await admin.connect();
  try {
    await withNoCreateDbRole(admin, async (roleDatabaseUrl, roleName) => {
      temporaryRoleName = roleName;
      const previousDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = roleDatabaseUrl;
      try {
        await withMarkerFile(async (markerFile) => {
          await assert.rejects(
            runIsolatedIntegrationTest({
              schemaPrefix: contractPrefix,
              testFile: hangFixture,
              testTimeoutMs: 3_000,
              testEnvironment: {
                SCHEMA_RUNNER_EXPECTED_ROLE: roleName,
                SCHEMA_RUNNER_HANG_IN_TRANSACTION: "true",
              },
            }),
            new RegExp(
              `Integration command ${command.join(" ")} timed out after 3000ms`,
            ),
          );
          const marker = await readFile(markerFile, "utf8");
          const match = /^schema:(schema_runner_ci_timeout_[a-z0-9]+)\nbackend:(\d+)\ntest\n$/.exec(marker);
          assert.ok(match, `Expected the restricted test fixture to connect and begin a transaction: ${marker}`);
          const backend = await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid = $1",
            [Number(match[2])],
          );
          assert.equal(backend.rowCount, 0);
          assert.equal(await schemaExists(admin, match[1]), false);
          const schemas = await admin.query<{ schema_name: string }>(
            `SELECT nspname AS schema_name FROM pg_namespace WHERE nspname LIKE $1 ESCAPE '\\'`,
            [`${contractPrefix.replaceAll("_", "\\_")}_%`],
          );
          assert.deepEqual(schemas.rows, []);
        });
      } finally {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    });
    const role = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [temporaryRoleName],
    );
    assert.equal(role.rowCount, 0);
  } finally {
    await admin.end();
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

test("a timed out test file is killed and removes its empty disposable database", {
  skip: !databaseUrl,
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `database_test_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
          testFile: hangFixture,
          testTimeoutMs: 2_000,
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

test("a timed out test file is killed and cleans up its schema", {
  skip: !databaseUrl,
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const contractPrefix =
    `schema_test_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
          testFile: hangFixture,
          testTimeoutMs: 2_000,
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

test("cleanup timeout keeps the timed out test command visible", async () => {
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
  const command = [
    "pnpm",
    "--filter",
    "@workspace/api-server",
    "exec",
    "tsx",
    hangFixture,
  ] as const;

  await withMarkerFile(async () => {
    await assert.rejects(
      runIsolatedIntegrationTest({
        schemaPrefix: "test_and_cleanup_timeout",
        testFile: hangFixture,
        testTimeoutMs: 2_000,
        cleanupTimeoutMs: 100,
        createAdminClient: () => fakeAdmin,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        const testTimeoutMessage =
          `Integration command ${command.join(" ")} timed out after 2000ms`;
        assert.match(error.message, new RegExp(testTimeoutMessage));
        assert.match(String(error.errors[0]), new RegExp(testTimeoutMessage));
        assert.match(
          String(error.errors[1]),
          /Integration database cleanup timed out after 100ms/,
        );
        assert.equal(error.cause, error.errors[0]);
        return true;
      },
    );
  });
  assert.equal(connectionDestroyed, true);
});

test("connection timeout stops the runner before the test fixture runs", async () => {
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
    connect: () => never,
  } as unknown as InstanceType<typeof Client>;

  await withMarkerFile(async (markerFile) => {
    const startedAt = Date.now();
    await assert.rejects(
      runIsolatedIntegrationTest({
        schemaPrefix: "connection_timeout_test",
        testFile: successFixture,
        connectionTimeoutMs: 100,
        createAdminClient: () => fakeAdmin,
      }),
      /Integration database connection timed out after 100ms/,
    );

    assert.ok(Date.now() - startedAt < 5_000);
    assert.equal(connectionDestroyed, true);
    await assert.rejects(readFile(markerFile, "utf8"), { code: "ENOENT" });
  });
});

test("an immediate connection rejection preserves its original cause and skips fixtures", async () => {
  const connectionError = new Error("simulated admin authentication rejection");
  const fakeAdmin = {
    connect: async () => {
      throw connectionError;
    },
  } as unknown as InstanceType<typeof Client>;

  await withMarkerFile(async (markerFile) => {
    await assert.rejects(
      runIsolatedIntegrationTest({
        schemaPrefix: "connection_rejection_test",
        testFile: afterSetupFixture,
        setupCommand: [
          "pnpm",
          "--filter",
          "@workspace/api-server",
          "exec",
          "tsx",
          setupFixture,
        ],
        connectionTimeoutMs: 100,
        createAdminClient: () => fakeAdmin,
      }),
      (error: unknown) => {
        assert.equal(error, connectionError);
        assert.doesNotMatch(String(error), /timed out/i);
        return true;
      },
    );

    await assert.rejects(readFile(markerFile, "utf8"), { code: "ENOENT" });
  });
});

function controlledAdminConnection() {
  let rejectConnection!: (reason: Error) => void;
  let destroyed = 0;
  const connection = new Promise<void>((_, reject) => {
    rejectConnection = reject;
  });
  const admin = {
    connection: {
      stream: {
        destroy: () => { destroyed += 1; },
      },
    },
    connect: () => connection,
    query: () => { throw new Error("query must not run before connection"); },
    end: () => { throw new Error("end must not run before connection"); },
  } as unknown as InstanceType<typeof Client>;
  return { admin, rejectConnection, get destroyed() { return destroyed; } };
}

test("connection rejection just before the deadline preserves the driver error", async (t) => {
  const connectionError = new Error("simulated late driver connection rejection");
  const controlled = controlledAdminConnection();
  await withMarkerFile(async (markerFile) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const run = runIsolatedIntegrationTest({
        schemaPrefix: "connection_late_rejection_test",
        testFile: afterSetupFixture,
        setupCommand: ["pnpm", "--filter", "@workspace/api-server", "exec", "tsx", setupFixture],
        connectionTimeoutMs: 100,
        createAdminClient: () => controlled.admin,
      });
      t.mock.timers.tick(99);
      assert.equal(controlled.destroyed, 0);
      controlled.rejectConnection(connectionError);
      await assert.rejects(run, (error: unknown) => {
        assert.equal(error, connectionError);
        return true;
      });
      t.mock.timers.tick(1);
      assert.equal(controlled.destroyed, 0);
      await assert.rejects(readFile(markerFile, "utf8"), { code: "ENOENT" });
    } finally {
      t.mock.timers.reset();
    }
  });
});

test("connection timeout wins over a later driver rejection and stops the connection", async (t) => {
  const controlled = controlledAdminConnection();
  await withMarkerFile(async (markerFile) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const run = runIsolatedIntegrationTest({
        schemaPrefix: "connection_late_timeout_test",
        testFile: afterSetupFixture,
        setupCommand: ["pnpm", "--filter", "@workspace/api-server", "exec", "tsx", setupFixture],
        connectionTimeoutMs: 100,
        createAdminClient: () => controlled.admin,
      });
      t.mock.timers.tick(99);
      assert.equal(controlled.destroyed, 0);
      t.mock.timers.tick(1);
      await assert.rejects(run, /Integration database connection timed out after 100ms/);
      assert.equal(controlled.destroyed, 1);
      controlled.rejectConnection(new Error("driver rejected after deadline"));
      await Promise.resolve();
      await assert.rejects(readFile(markerFile, "utf8"), { code: "ENOENT" });
    } finally {
      t.mock.timers.reset();
    }
  });
});
