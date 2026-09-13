import { spawn } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const { Client } = pg;

type IsolatedIntegrationOptions = {
  schemaPrefix: string;
  testFile: string;
  setupCommand?: readonly string[];
  setupTimeoutMs?: number;
  testTimeoutMs?: number;
  setupEnvironment?: Readonly<Record<string, string>>;
  testEnvironment?: Readonly<Record<string, string>>;
  useEmptyDatabase?: boolean;
  excludeTables?: readonly string[];
  staleSchemaAgeMs?: number;
};

const DEFAULT_STALE_SCHEMA_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000;
const SCHEMA_METADATA_KIND = "teras-integration-test";
const SCHEMA_METADATA_VERSION = 1;
const ADVISORY_LOCK_SEED = 847_201;

type IntegrationSchemaMetadata = {
  kind: typeof SCHEMA_METADATA_KIND;
  version: typeof SCHEMA_METADATA_VERSION;
  schemaPrefix: string;
  createdAt: string;
};

function assertTestEnvironment() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Integration schema isolation is only available when NODE_ENV=test");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set for isolated integration tests");
  }
}

function safeSchemaPrefix(prefix: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`Invalid integration schema prefix: ${prefix}`);
  }
  return prefix;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function schemaMetadata(schemaPrefix: string, createdAt = new Date()) {
  return JSON.stringify({
    kind: SCHEMA_METADATA_KIND,
    version: SCHEMA_METADATA_VERSION,
    schemaPrefix,
    createdAt: createdAt.toISOString(),
  } satisfies IntegrationSchemaMetadata);
}

export function isStaleOwnedIntegrationSchema({
  schemaName,
  schemaPrefix,
  comment,
  now,
  staleSchemaAgeMs,
}: {
  schemaName: string;
  schemaPrefix: string;
  comment: string | null;
  now: Date;
  staleSchemaAgeMs: number;
}) {
  if (!schemaName.startsWith(`${schemaPrefix}_`) || !comment) {
    return false;
  }
  try {
    const metadata = JSON.parse(comment) as Partial<IntegrationSchemaMetadata>;
    if (
      metadata.kind !== SCHEMA_METADATA_KIND ||
      metadata.version !== SCHEMA_METADATA_VERSION ||
      metadata.schemaPrefix !== schemaPrefix ||
      typeof metadata.createdAt !== "string"
    ) {
      return false;
    }
    const createdAt = Date.parse(metadata.createdAt);
    return Number.isFinite(createdAt) && now.getTime() - createdAt >= staleSchemaAgeMs;
  } catch {
    return false;
  }
}

export function canDropStaleIntegrationSchema(
  schema: Parameters<typeof isStaleOwnedIntegrationSchema>[0] & {
    advisoryLockAcquired: boolean;
  },
) {
  return schema.advisoryLockAcquired && isStaleOwnedIntegrationSchema(schema);
}

export async function cleanupStaleIntegrationSchemas(
  admin: InstanceType<typeof Client>,
  schemaPrefix: string,
  staleSchemaAgeMs: number,
) {
  const schemas = await admin.query<{ schema_name: string; comment: string | null }>(
    `
      SELECT n.nspname AS schema_name, obj_description(n.oid, 'pg_namespace') AS comment
      FROM pg_namespace n
      WHERE n.nspname LIKE $1 ESCAPE '\\'
    `,
    [`${schemaPrefix.replaceAll("_", "\\_")}_%`],
  );
  const now = new Date();
  for (const { schema_name: schemaName, comment } of schemas.rows) {
    if (!isStaleOwnedIntegrationSchema({
      schemaName,
      schemaPrefix,
      comment,
      now,
      staleSchemaAgeMs,
    })) {
      continue;
    }
    const lock = await admin.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired",
      [schemaName, ADVISORY_LOCK_SEED],
    );
    if (!canDropStaleIntegrationSchema({
      schemaName,
      schemaPrefix,
      comment,
      now,
      staleSchemaAgeMs,
      advisoryLockAcquired: lock.rows[0]?.acquired ?? false,
    })) {
      continue;
    }
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    } finally {
      await admin.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
        [schemaName, ADVISORY_LOCK_SEED],
      );
    }
  }
}

export async function initializeIntegrationSchema(
  admin: InstanceType<typeof Client>,
  schemaName: string,
  schemaPrefix: string,
  afterSchemaCreated?: () => void | Promise<void>,
) {
  await admin.query(
    "SELECT pg_advisory_lock(hashtextextended($1, $2))",
    [schemaName, ADVISORY_LOCK_SEED],
  );
  try {
    await admin.query("BEGIN");
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await afterSchemaCreated?.();
      await admin.query(
        `COMMENT ON SCHEMA ${quoteIdentifier(schemaName)} IS ${quoteLiteral(schemaMetadata(schemaPrefix))}`,
      );
      await admin.query("COMMIT");
    } catch (error) {
      try {
        await admin.query("ROLLBACK");
      } catch {
        // A terminated database session rolls its transaction back automatically.
      }
      throw error;
    }
  } catch (error) {
    try {
      await admin.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
        [schemaName, ADVISORY_LOCK_SEED],
      );
    } catch {
      // A terminated database session also releases its advisory locks.
    }
    throw error;
  }
}

function isolatedDatabaseUrl(databaseUrl: string, schemaName: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function disposableDatabaseUrl(databaseUrl: string, databaseName: string) {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete("options");
  return url.toString();
}

async function runCommand(
  command: readonly string[],
  databaseUrl: string,
  timeoutMs: number,
  extraEnvironment: Readonly<Record<string, string>> = {},
) {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Isolated integration command cannot be empty");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Integration command timeout must be a positive number, received ${timeoutMs}`);
  }
  const child = spawn(
    executable,
    args,
    {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        ...extraEnvironment,
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
      },
      stdio: "inherit",
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Fall back to killing the direct child if its process group already exited.
      }
    }
    child.kill("SIGKILL");
  }, timeoutMs);
  timeout.unref();

  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    [code, signal] = await once(child, "exit") as [
      number | null,
      NodeJS.Signals | null,
    ];
  } finally {
    clearTimeout(timeout);
  }
  if (timedOut) {
    throw new Error(
      `Integration command ${command.join(" ")} timed out after ${timeoutMs}ms`,
    );
  }
  if (code !== 0) {
    throw new Error(
      `Integration command ${command.join(" ")} failed with ${signal ?? `exit code ${code}`}`,
    );
  }
}

async function runTestFile(
  testFile: string,
  databaseUrl: string,
  timeoutMs: number,
  testEnvironment: Readonly<Record<string, string>> = {},
) {
  await runCommand(
    ["pnpm", "--filter", "@workspace/api-server", "exec", "tsx", testFile],
    databaseUrl,
    timeoutMs,
    testEnvironment,
  );
}

export async function runIsolatedIntegrationTest({
  schemaPrefix,
  testFile,
  setupCommand,
  setupTimeoutMs = DEFAULT_SETUP_TIMEOUT_MS,
  testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS,
  setupEnvironment,
  testEnvironment,
  useEmptyDatabase = false,
  excludeTables = [],
  staleSchemaAgeMs = DEFAULT_STALE_SCHEMA_AGE_MS,
}: IsolatedIntegrationOptions) {
  assertTestEnvironment();
  const prefix = safeSchemaPrefix(schemaPrefix);
  const schemaName = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  let connected = false;

  try {
    await admin.connect();
    connected = true;
    if (useEmptyDatabase) {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(schemaName)} TEMPLATE template0`);
      const databaseUrl = disposableDatabaseUrl(process.env.DATABASE_URL!, schemaName);
      if (setupCommand) {
        await runCommand(setupCommand, databaseUrl, setupTimeoutMs, setupEnvironment);
      }
      await runTestFile(testFile, databaseUrl, testTimeoutMs, testEnvironment);
      return;
    }

    await cleanupStaleIntegrationSchemas(admin, prefix, staleSchemaAgeMs);
    await initializeIntegrationSchema(admin, schemaName, prefix);
    const sourceTables = await admin.query<{ tablename: string }>(
      `
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename LIKE 'teras_%'
          AND NOT (tablename = ANY($1::text[]))
        ORDER BY tablename
      `,
      [excludeTables],
    );
    for (const { tablename } of sourceTables.rows) {
      await admin.query(
        `CREATE TABLE ${quoteIdentifier(schemaName)}.${quoteIdentifier(tablename)} ` +
        `(LIKE public.${quoteIdentifier(tablename)} INCLUDING ALL)`,
      );
    }

    const databaseUrl = isolatedDatabaseUrl(process.env.DATABASE_URL!, schemaName);
    if (setupCommand) {
      await runCommand(setupCommand, databaseUrl, setupTimeoutMs, setupEnvironment);
    }
    await runTestFile(
      testFile,
      databaseUrl,
      testTimeoutMs,
      testEnvironment,
    );
  } finally {
    if (connected) {
      if (useEmptyDatabase) {
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(schemaName)} WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      } else {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
        } finally {
          try {
            await admin.query(
              "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
              [schemaName, ADVISORY_LOCK_SEED],
            );
          } finally {
            await admin.end();
          }
        }
      }
    }
  }
}