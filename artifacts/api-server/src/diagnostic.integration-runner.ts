import { spawn } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const { Client } = pg;

function assertTestEnvironment() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Diagnostic integration isolation is only available when NODE_ENV=test");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set for the diagnostic integration test");
  }
}

function isolatedDatabaseUrl(databaseUrl: string, schemaName: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schemaName}`);
  return url.toString();
}

async function run(command: string, args: string[], databaseUrl: string) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
    },
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}`);
  }
}

async function main() {
  assertTestEnvironment();
  const schemaName = `diagnostic_integration_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  let connected = false;

  try {
    await admin.connect();
    connected = true;
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`
      DO $$
      DECLARE source_table record;
      BEGIN
        FOR source_table IN
          SELECT tablename
          FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename LIKE 'teras_%'
            AND tablename NOT LIKE 'teras_diagnostic_%'
        LOOP
          EXECUTE format(
            'CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)',
            '${schemaName}',
            source_table.tablename,
            source_table.tablename
          );
        END LOOP;
      END
      $$;
    `);
    const databaseUrl = isolatedDatabaseUrl(process.env.DATABASE_URL!, schemaName);

    await run(
      "pnpm",
      ["--filter", "@workspace/api-server", "exec", "tsx", "./src/diagnostic.integration.ts"],
      databaseUrl,
    );
  } finally {
    if (connected) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});