#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node verify-readiness-audit.mjs <readiness-audit.json>");
  process.exit(2);
}

try {
  const exported = JSON.parse(await readFile(path, "utf8"));
  const canonicalPayload = {
    schemaVersion: exported.schemaVersion,
    exportedAt: exported.exportedAt,
    filters: exported.filters,
    recordCount: exported.recordCount,
    records: exported.records,
  };
  const actual = createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");
  const expected = exported.integrity?.checksum;

  if (exported.integrity?.algorithm !== "SHA-256" || actual !== expected) {
    console.error(`FAILED: expected ${expected ?? "(missing checksum)"}, calculated ${actual}`);
    process.exit(1);
  }

  console.log(`VERIFIED: ${actual}`);
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}