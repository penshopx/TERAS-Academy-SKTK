import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";

const databaseUrl = process.env.DATABASE_URL;
const markerFile = process.env.SCHEMA_RUNNER_MARKER_FILE;

assert.ok(databaseUrl, "hanging fixture requires DATABASE_URL");
assert.ok(markerFile, "hanging fixture requires SCHEMA_RUNNER_MARKER_FILE");

await appendFile(markerFile, "setup\n");
await new Promise(() => {
  setInterval(() => {}, 60_000);
});