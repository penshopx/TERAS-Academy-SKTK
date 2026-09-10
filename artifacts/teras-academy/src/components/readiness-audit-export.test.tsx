import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminReadinessExport } from "@workspace/api-client-react";
import {
  downloadReadinessAuditExport,
  ReadinessExportFeedback,
} from "./admin/ReadinessAuditHistory";

const checksum = "a".repeat(64);
const payload = {
  schemaVersion: "1.0",
  exportedAt: "2026-09-10T08:00:00.000Z",
  filters: {
    learnerId: null,
    pathwayId: null,
    status: null,
    ruleVersion: null,
  },
  recordCount: 1,
  records: [],
  integrity: {
    algorithm: "SHA-256",
    checksum,
    canonicalization: "teras-readiness-export-v1-json-stringify",
    verificationCommand: "node verify-readiness-audit.mjs readiness-audit.json",
  },
} as AdminReadinessExport;

test("readiness history export downloads the JSON and canonical checksum sidecar", async () => {
  const blobs: Blob[] = [];
  const downloads: Array<{ href: string; download: string; clicks: number }> = [];
  const revoked: string[] = [];

  downloadReadinessAuditExport(payload, new Date("2026-09-10T12:30:00.000Z"), {
    createObjectURL(blob) {
      blobs.push(blob);
      return `blob:test-${blobs.length}`;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
    createAnchor() {
      const anchor = { href: "", download: "", clicks: 0, click() { anchor.clicks += 1; } };
      downloads.push(anchor);
      return anchor;
    },
  });

  assert.deepEqual(downloads.map(({ href, download, clicks }) => ({ href, download, clicks })), [
    { href: "blob:test-1", download: "readiness-audit-2026-09-10.json", clicks: 1 },
    { href: "blob:test-2", download: "readiness-audit-2026-09-10.json.canonical.sha256.txt", clicks: 1 },
  ]);
  assert.deepEqual(revoked, ["blob:test-1", "blob:test-2"]);
  assert.equal(blobs[0]?.type, "application/json");
  assert.deepEqual(JSON.parse(await blobs[0]!.text()), payload);
  assert.equal(blobs[1]?.type, "text/plain");
  assert.equal(
    await blobs[1]!.text(),
    `SHA-256 (payload canonical): ${checksum}\n`
      + "File audit: readiness-audit-2026-09-10.json\n"
      + "Verifikasi: node verify-readiness-audit.mjs readiness-audit.json\n",
  );
});

test("readiness export feedback keeps the latest checksum visible", () => {
  const markup = renderToStaticMarkup(
    <ReadinessExportFeedback
      status="success"
      recordCount={1}
      error={null}
      errorMessage={String}
      checksum={checksum}
    />,
  );

  assert.match(markup, /Ekspor berhasil\. 1 record telah diunduh\./);
  assert.match(markup, /Checksum SHA-256 ekspor terakhir/);
  assert.match(markup, new RegExp(checksum));
});

test("readiness export feedback displays export failures", () => {
  const markup = renderToStaticMarkup(
    <ReadinessExportFeedback
      status="failed"
      recordCount={null}
      error={new Error("Jaringan terputus")}
      errorMessage={error => error instanceof Error ? error.message : String(error)}
      checksum=""
    />,
  );

  assert.match(markup, /role="alert"/);
  assert.match(markup, /Ekspor gagal: Jaringan terputus/);
});