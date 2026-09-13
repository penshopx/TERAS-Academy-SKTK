import { appendFile } from "node:fs/promises";

const markerFile = process.env.SCHEMA_RUNNER_MARKER_FILE;

if (markerFile) {
  await appendFile(markerFile, "test\n");
}