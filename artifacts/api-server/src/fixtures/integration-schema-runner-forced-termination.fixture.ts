import { writeFile } from "node:fs/promises";
import pg from "pg";

const markerFile = process.env.SCHEMA_RUNNER_MARKER_FILE;

if (!markerFile) {
  throw new Error("SCHEMA_RUNNER_MARKER_FILE is required");
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const schema = await client.query<{ name: string }>(
  "SELECT current_schema() AS name",
);
await writeFile(markerFile, schema.rows[0]!.name, "utf8");
await new Promise(() => {});