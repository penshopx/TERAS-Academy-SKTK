import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createLearnerPortfolioExport, LEARNER_PORTFOLIO_CANONICALIZATION } from "./learner-portfolio-export";

test("learner portfolio export has a reproducible checksum over the persisted passport payload", () => {
  const portfolio = {
    terminalPortfolio: "Capability Portfolio",
    timeline: [{ id: "event-1", causalReferences: { evidenceIds: ["evidence-1"] } }],
    readiness: { status: "Developing", evaluatedAt: "2026-09-12T08:00:00.000Z" },
    readinessDisclaimer: "Internal readiness-preparation information only.",
  };
  const exported = createLearnerPortfolioExport(portfolio, new Date("2026-09-12T09:00:00.000Z"));
  const { integrity, ...payload } = exported;

  assert.equal(exported.portfolio, portfolio);
  assert.equal(integrity.canonicalization, LEARNER_PORTFOLIO_CANONICALIZATION);
  assert.equal(integrity.checksum, crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
  assert.match(exported.documentId, /^teras-portfolio-[a-f0-9]{16}$/);
  assert.match(integrity.verificationNote, /does not represent official certification/);
});