import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminReadinessExport } from "@workspace/api-client-react";
import { customFetch } from "../../../../lib/api-client-react/src/custom-fetch";
import {
  cancelReadinessExportOnUnmount,
  downloadReadinessAuditExport,
  ReadinessExportProgress,
  ReadinessExportFeedback,
  ReadinessExportAlerts,
  readinessExportTrendInput,
  runReadinessAuditExport,
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
    signature: {
      algorithm: "Ed25519",
      keyId: "teras-audit-2026-09",
      keyVersion: 2,
      value: "test-signature",
      publicKeyUrl: "/api/readiness-audit/public-keys",
    },
    verificationCommand: "node verify-readiness-audit.mjs readiness-audit.json public-keys.json",
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
      + "Verifikasi: node verify-readiness-audit.mjs readiness-audit.json public-keys.json\n",
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

test("server-owned export warning remains visible across an invalid and corrected device clock", () => {
  const RealDate = Date;
  let deviceTime = Number.NaN;
  globalThis.Date = class extends RealDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? deviceTime : value);
    }

    static now() {
      return deviceTime;
    }
  } as DateConstructor;
  const alert = {
    periodStart: "2026-09-10",
    periodEnd: "2026-09-16",
    recordGroup: "5.000–9.999 record",
    sampleSize: 5,
    explanation: "3 dari 5 ekspor gagal atau dibatalkan (60%), melewati ambang 40%.",
  };

  try {
    const invalidClockMarkup = renderToStaticMarkup(
      <ReadinessExportAlerts alerts={[alert]} periodDays={7} minimumSampleSize={5} />,
    );
    deviceTime = RealDate.parse("1999-01-01T00:00:00.000Z");
    const rolledBackMarkup = renderToStaticMarkup(
      <ReadinessExportAlerts alerts={[alert]} periodDays={7} minimumSampleSize={5} />,
    );
    deviceTime = RealDate.parse("2026-09-16T12:00:00.000Z");
    const correctedMarkup = renderToStaticMarkup(
      <ReadinessExportAlerts alerts={[alert]} periodDays={7} minimumSampleSize={5} />,
    );

    for (const markup of [invalidClockMarkup, rolledBackMarkup, correctedMarkup]) {
      assert.match(markup, /Peringatan kegagalan ekspor besar/);
      assert.match(markup, /5\.000–9\.999 record/);
      assert.match(markup, /3 dari 5 ekspor gagal/);
    }
  } finally {
    globalThis.Date = RealDate;
  }
});

test("export trend mutation cannot send device time to the server", () => {
  const attemptKey = "8581da20-938a-4f90-96f6-5cc20456134b";
  assert.deepEqual(readinessExportTrendInput(attemptKey, "failed", 5_000), {
    data: { attemptKey, outcome: "failed", recordCount: 5_000 },
  });
});

test("readiness export shows the filtered record count and advancing streamed bytes", async () => {
  const counts: number[] = [];
  const loaded: number[] = [];
  const result = await runReadinessAuditExport({
    controller: new AbortController(),
    request: async (_signal, callbacks) => {
      callbacks.onResponse(new Response(null, { headers: { "x-export-record-count": "7" } }));
      callbacks.onDownloadProgress({ loadedBytes: 1_200, totalBytes: 3_000 });
      callbacks.onDownloadProgress({ loadedBytes: 2_400, totalBytes: 3_000 });
      return { ...payload, recordCount: 7 };
    },
    download: exported => ({ checksum: exported.integrity.checksum }),
    onRecordCount: count => counts.push(count),
    onLoadedBytes: bytes => loaded.push(bytes),
  });

  assert.deepEqual(counts, [7, 7]);
  assert.deepEqual(loaded, [1_200, 2_400]);
  assert.equal(result.status, "success");
  const markup = renderToStaticMarkup(<ReadinessExportProgress recordCount={counts[0]!} loadedBytes={loaded.at(-1)!} />);
  assert.match(markup, /7 record akan diekspor/);
  assert.match(markup, /2 KB diterima/);
});

test("cancelling readiness export prevents downloads and reports cancellation", async () => {
  const controller = new AbortController();
  let downloads = 0;
  const resultPromise = runReadinessAuditExport({
    controller,
    request: signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
    download: () => {
      downloads += 1;
      return { checksum };
    },
    onRecordCount: () => {},
    onLoadedBytes: () => {},
  });

  controller.abort();
  const result = await resultPromise;
  assert.deepEqual(result, { status: "cancelled", recordCount: 0 });
  assert.equal(downloads, 0);
  const markup = renderToStaticMarkup(
    <ReadinessExportFeedback status="cancelled" recordCount={null} error={null} errorMessage={String} checksum="" />,
  );
  assert.match(markup, /Ekspor dibatalkan\. Tidak ada file yang diunduh\./);
});

test("unmount aborts an unfinished readiness export without downloading or updating state", async () => {
  const controller = new AbortController();
  const controllerRef = { current: controller as AbortController | null };
  const mounted = { current: true };
  let downloads = 0;
  const stateUpdates: string[] = [];
  let resolveStream!: (value: AdminReadinessExport) => void;
  const stream = new Promise<AdminReadinessExport>(resolve => {
    resolveStream = resolve;
  });
  const resultPromise = runReadinessAuditExport({
    controller,
    request: async (_signal, callbacks) => {
      callbacks.onResponse(new Response(null, { headers: { "x-export-record-count": "1" } }));
      callbacks.onDownloadProgress({ loadedBytes: 128, totalBytes: null });
      return stream;
    },
    download: () => {
      downloads += 1;
      return { checksum };
    },
    onRecordCount: count => {
      if (mounted.current) stateUpdates.push(`count:${count}`);
    },
    onLoadedBytes: bytes => {
      if (mounted.current) stateUpdates.push(`bytes:${bytes}`);
    },
  });

  cancelReadinessExportOnUnmount(mounted, controllerRef);
  const updatesAtUnmount = [...stateUpdates];
  resolveStream(payload);
  const result = await resultPromise;

  assert.equal(controller.signal.aborted, true);
  assert.equal(controllerRef.current, null);
  assert.deepEqual(result, { status: "cancelled", recordCount: 1 });
  assert.equal(downloads, 0);
  assert.deepEqual(stateUpdates, updatesAtUnmount);
});

test("readiness export runner keeps successful and failed outcomes explicit", async () => {
  const success = await runReadinessAuditExport({
    controller: new AbortController(),
    request: async () => payload,
    download: exported => ({ checksum: exported.integrity.checksum }),
    onRecordCount: () => {},
    onLoadedBytes: () => {},
  });
  const failure = await runReadinessAuditExport({
    controller: new AbortController(),
    request: async () => { throw new Error("Jaringan terputus"); },
    download: () => { throw new Error("download tidak boleh berjalan"); },
    onRecordCount: () => {},
    onLoadedBytes: () => {},
  });

  assert.equal(success.status, "success");
  assert.equal(failure.status, "failed");
  assert.equal(failure.recordCount, 0);
  assert.match(failure.status === "failed" ? String(failure.error) : "", /Jaringan terputus/);
});

test("readiness export runner preserves known size when failure occurs before response headers", async () => {
  const result = await runReadinessAuditExport({
    controller: new AbortController(),
    initialRecordCount: 1_500,
    request: async () => { throw new Error("network unavailable"); },
    download: () => ({ checksum: "" }),
    onRecordCount: () => undefined,
    onLoadedBytes: () => undefined,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.recordCount, 1_500);
});

test("custom fetch exposes response headers before reporting each streamed chunk", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const body = JSON.stringify(payload);
  const midpoint = Math.floor(body.length / 2);
  const responseEvents: string[] = [];
  const progress: number[] = [];

  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body.slice(0, midpoint)));
      controller.enqueue(encoder.encode(body.slice(midpoint)));
      controller.close();
    },
  }), {
    headers: {
      "content-type": "application/json",
      "content-length": String(encoder.encode(body).byteLength),
      "x-export-record-count": "1",
    },
  });

  try {
    const exported = await customFetch<AdminReadinessExport>("/api/admin/readiness-history/export", {
      responseType: "json",
      onResponse: response => responseEvents.push(response.headers.get("x-export-record-count") ?? ""),
      onDownloadProgress: event => progress.push(event.loadedBytes),
    });

    assert.deepEqual(responseEvents, ["1"]);
    assert.equal(progress.length, 2);
    assert(progress[1]! > progress[0]!);
    assert.equal(progress.at(-1), encoder.encode(body).byteLength);
    assert.equal(exported.recordCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});