import { spawn } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const { Client } = pg;

type IsolatedIntegrationOptions = {
  schemaPrefix: string;
  testFile: string;
  excludeTables?: readonly string[];
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

function isolatedDatabaseUrl(databaseUrl: string, schemaName: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schemaName}`);
  return url.toString();
}

async function runTestFile(testFile: string, databaseUrl: string) {
  const child = spawn(
    "pnpm",
    ["--filter", "@workspace/api-server", "exec", "tsx", testFile],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
      },
      stdio: "inherit",
    },
  );
  const [code, signal] = await once(child, "exit") as [
    number | null,
    NodeJS.Signals | null,
  ];
  if (code !== 0) {
    throw new Error(
      `Integration test ${testFile} failed with ${signal ?? `exit code ${code}`}`,
    );
  }
}

export async function runIsolatedIntegrationTest({
  schemaPrefix,
  testFile,
  excludeTables = [],
}: IsolatedIntegrationOptions) {
  assertTestEnvironment();
  const prefix = safeSchemaPrefix(schemaPrefix);
  const schemaName = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  let connected = false;

  try {
    await admin.connect();
    connected = true;
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
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

    await runTestFile(
      testFile,
      isolatedDatabaseUrl(process.env.DATABASE_URL!, schemaName),
    );
  } finally {
    if (connected) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}