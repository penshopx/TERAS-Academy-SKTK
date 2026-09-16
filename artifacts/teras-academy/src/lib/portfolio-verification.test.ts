import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  MAX_PORTFOLIO_FILE_SIZE_BYTES,
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
  const result = await verifyPortfolioFile({
    size: MAX_PORTFOLIO_FILE_SIZE_BYTES,
    text: async () => {
      textCalls += 1;
      return JSON.stringify(portfolioDocument());
    },
  });

  assert.equal(textCalls, 1);
  assert.equal(result.status, "match");
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
