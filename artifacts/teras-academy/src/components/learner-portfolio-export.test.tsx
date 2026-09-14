import assert from "node:assert/strict";
import test from "node:test";
import type { LearnerPortfolioExport } from "@workspace/api-client-react";
import { downloadPortfolioExport } from "../pages/passport";

const exportFixture = (terminalPortfolio: LearnerPortfolioExport["portfolio"]["terminalPortfolio"]): LearnerPortfolioExport => ({
  schemaVersion: "1.0",
  documentId: "teras-portfolio-0123456789abcdef",
  exportedAt: "2026-09-12T09:00:00.000Z",
  portfolio: {
    learner: { id: "learner-1", name: "Learner", initials: "L", role: "Learner", organization: null },
    pathway: {
      id: "path-a", name: "Path A", type: "development", purpose: "capability-development",
      outcome: "Capability portfolio", moduleCount: 1, gateCount: 1, gates: [], terminalPortfolio,
    },
    headline: terminalPortfolio,
    subtitle: "Longitudinal record",
    terminalPortfolio,
    readinessDisclaimer: "Internal only; not official certification.",
    readiness: {
      pathway: {
        id: "path-a", name: "Path A", type: "development", purpose: "capability-development",
        outcome: "Capability portfolio", moduleCount: 1, gateCount: 1, gates: [], terminalPortfolio,
      },
      status: "Developing",
      score: 50,
      ruleVersion: 1,
      evaluatedAt: "2026-09-12T08:00:00.000Z",
      decisionReason: "More evidence required",
      blockers: [],
      inputEvidence: { assessments: [], evidence: [], openCriticalGaps: [], gates: [] },
      currentGate: {
        id: "gate-1", code: "G1", name: "Readiness gate", status: "Developing", requirement: "Evidence",
        score: 50, threshold: 80, hardGate: false, competencyUnitId: null, ruleVersion: 1,
      },
      nextGate: null,
      gates: [],
      outstandingGapCount: 1,
      missingEvidenceCount: 1,
    },
    achievements: [],
    timeline: [],
    timelineNextCursor: null,
  },
  integrity: {
    algorithm: "SHA-256",
    checksum: "a".repeat(64),
    canonicalization: "teras-learner-portfolio-v1-json-stringify",
    verificationNote: "Integrity only; not official certification.",
  },
});

for (const [portfolio, expectedFile] of [
  ["Capability Portfolio", "capability-portfolio-2026-09-12.json"],
  ["Certification Readiness Portfolio", "certification-readiness-portfolio-2026-09-12.json"],
] as const) {
  test(`downloads ${portfolio} with its pathway-specific filename and complete verification payload`, async () => {
    const payload = exportFixture(portfolio);
    const blobs: Blob[] = [];
    const anchors: Array<{ href: string; download: string; clicks: number; click: () => void }> = [];
    const revoked: string[] = [];

    downloadPortfolioExport(payload, {
      createObjectURL(blob) {
        blobs.push(blob);
        return "blob:portfolio";
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
      createAnchor() {
        const anchor = { href: "", download: "", clicks: 0, click() { anchor.clicks += 1; } };
        anchors.push(anchor);
        return anchor;
      },
    });

    assert.equal(anchors[0]?.download, expectedFile);
    assert.equal(anchors[0]?.clicks, 1);
    assert.deepEqual(revoked, ["blob:portfolio"]);
    assert.equal(blobs[0]?.type, "application/json");
    assert.deepEqual(JSON.parse(await blobs[0]!.text()), payload);
  });
}