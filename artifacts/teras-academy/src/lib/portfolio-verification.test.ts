import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  MAX_PORTFOLIO_FILE_SIZE_BYTES,
  PORTFOLIO_COMPLEXITY_REJECTION_MESSAGE,
  verifyPortfolioFile,
  verifyPortfolioText,
} from "./portfolio-verification";

function portfolioDocument(overrides: Record<string, unknown> = {}) {
  const payload = {
    schemaVersion: "1.0",
    documentId: "teras-portfolio-0123456789abcdef",
    exportedAt: "2026-09-14T09:00:00.000Z",
    portfolio: { learner: { name: "Learner" }, timeline: [] },
  };
  return {
    ...payload,
    integrity: {
      algorithm: "SHA-256",
      checksum: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      canonicalization: "teras-learner-portfolio-v1-json-stringify",
      verificationNote: "Integrity only.",
    },
    ...overrides,
  };
}

test("accepts a supported portfolio whose locally calculated checksum matches", async () => {
  const result = await verifyPortfolioText(JSON.stringify(portfolioDocument()));
  assert.equal(result.status, "match");
  if (result.status !== "rejected") {
    assert.equal(result.documentId, "teras-portfolio-0123456789abcdef");
    assert.equal(result.expectedChecksum, result.calculatedChecksum);
  }
});

test("reports a mismatch after the portfolio payload changes", async () => {
  const document = portfolioDocument();
  document.portfolio = { learner: { name: "Changed" }, timeline: [] };
  const result = await verifyPortfolioText(JSON.stringify(document));
  assert.equal(result.status, "mismatch");
});

test("rejects unknown schema and canonicalization versions", async () => {
  const unknownSchema = await verifyPortfolioText(JSON.stringify(portfolioDocument({ schemaVersion: "2.0" })));
  assert.deepEqual(unknownSchema, { status: "rejected", message: "Schema portfolio tidak dikenal: 2.0." });

  const document = portfolioDocument();
  document.integrity.canonicalization = "future-canonicalization";
  const unknownCanonicalization = await verifyPortfolioText(JSON.stringify(document));
  assert.deepEqual(unknownCanonicalization, { status: "rejected", message: "Canonicalization tidak dikenal: future-canonicalization." });
});

test("rejects malformed JSON and invalid document shapes", async () => {
  assert.equal((await verifyPortfolioText("{")).status, "rejected");
  assert.equal((await verifyPortfolioText(JSON.stringify({ schemaVersion: "1.0" }))).status, "rejected");
});

test("reads and verifies a portfolio file exactly at the local size limit", async () => {
  let textCalls = 0;
  const worker = localVerificationWorker();
  const result = await verifyPortfolioFile({
    size: MAX_PORTFOLIO_FILE_SIZE_BYTES,
    text: async () => {
      textCalls += 1;
      return JSON.stringify(portfolioDocument());
    },
  }, { createWorker: () => worker });

  assert.equal(textCalls, 1);
  assert.equal(result.status, "match");
});

function localVerificationWorker() {
  const listeners = new Map<string, (event?: MessageEvent) => void>();
  return {
    addEventListener(type: string, listener: (event?: MessageEvent) => void) {
      listeners.set(type, listener);
    },
    postMessage(text: string) {
      setTimeout(async () => {
        const data = await verifyPortfolioText(text);
        listeners.get("message")?.({ data } as MessageEvent);
      }, 0);
    },
    terminate() {},
  };
}

test("rejects an extreme deeply nested payload below the size limit without escaping the worker boundary", async () => {
  const depth = 20_000;
  const portfolio = `${'{"child":'.repeat(depth)}null${"}".repeat(depth)}`;
  const text = `{"schemaVersion":"1.0","documentId":"deep","exportedAt":"2026-09-22T00:00:00.000Z","portfolio":${portfolio},"integrity":{"algorithm":"SHA-256","checksum":"${"0".repeat(64)}","canonicalization":"teras-learner-portfolio-v1-json-stringify","verificationNote":"Integrity only."}}`;
  assert.ok(Buffer.byteLength(text) < MAX_PORTFOLIO_FILE_SIZE_BYTES);

  const result = await verifyPortfolioFile(
    { size: Buffer.byteLength(text), text: async () => text },
    { createWorker: localVerificationWorker },
  );

  assert.deepEqual(result, {
    status: "rejected",
    message: PORTFOLIO_COMPLEXITY_REJECTION_MESSAGE,
  });
});

test("terminates stalled verification work and reports a clear rejection", async () => {
  let terminated = false;
  const result = await verifyPortfolioFile(
    { size: 2, text: async () => "{}" },
    {
      timeoutMs: 5,
      createWorker: () => ({
        addEventListener() {},
        postMessage() {},
        terminate() {
          terminated = true;
        },
      }),
    },
  );

  assert.equal(terminated, true);
  assert.deepEqual(result, {
    status: "rejected",
    message: PORTFOLIO_COMPLEXITY_REJECTION_MESSAGE,
  });
});

test("abort terminates an active worker immediately without reporting a result or late error", async () => {
  const controller = new AbortController();
  let terminated = 0;
  let posted = false;
  const listeners = new Map<string, (event?: MessageEvent) => void>();
  const verification = verifyPortfolioFile(
    { size: 2, text: async () => "{}" },
    {
      signal: controller.signal,
      timeoutMs: 5,
      createWorker: () => ({
        addEventListener(type: string, listener: (event?: MessageEvent) => void) {
          listeners.set(type, listener);
        },
        postMessage() {
          posted = true;
        },
        terminate() {
          terminated += 1;
        },
      }),
    },
  );
  await Promise.resolve();
  assert.equal(posted, true);
  controller.abort();
  assert.equal(terminated, 1);
  await assert.rejects(verification, { name: "AbortError" });
  listeners.get("message")?.({ data: { status: "match" } } as MessageEvent);
  listeners.get("error")?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(terminated, 1);
});

test("abort before or during file reading prevents worker creation", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  await assert.rejects(
    verifyPortfolioFile({ size: 2, text: async () => { reads++; return "{}"; } }, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(reads, 0);

  const reading = new AbortController();
  let finishRead!: (text: string) => void;
  const verification = verifyPortfolioFile(
    { size: 2, text: () => new Promise(resolve => { finishRead = resolve; }) },
    { signal: reading.signal, createWorker: () => { throw new Error("Worker must not start"); } },
  );
  reading.abort();
  finishRead("{}");
  await assert.rejects(verification, { name: "AbortError" });
});

test("rejects a portfolio file above the local size limit before reading it", async () => {
  let textCalls = 0;
  const result = await verifyPortfolioFile({
    size: MAX_PORTFOLIO_FILE_SIZE_BYTES + 1,
    text: async () => {
      textCalls += 1;
      return JSON.stringify(portfolioDocument());
    },
  });

  assert.equal(textCalls, 0);
  assert.deepEqual(
    result,
    {
      status: "rejected",
      message: "Ukuran file melebihi batas 5 MiB. Pilih file portfolio yang lebih kecil.",
    },
  );
});
