import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for resource progress context setup");
}

await promisify(execFile)(
  "pnpm",
  ["--filter", "@workspace/scripts", "exec", "tsx", "./src/seed.ts", "--demo"],
  { env: process.env },
);

const migration = await readFile(
  new URL("../../../../lib/db/migrations/0038_learning_resource_progress_context.sql", import.meta.url),
  "utf8",
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(migration);
} finally {
  await client.end();
}