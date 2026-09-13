import crypto from "node:crypto";

export const LEARNER_PORTFOLIO_CANONICALIZATION = "teras-learner-portfolio-v1-json-stringify";

export type LearnerPortfolioPayload = {
  schemaVersion: "1.0";
  documentId: string;
  exportedAt: string;
  portfolio: unknown;
};

export function createLearnerPortfolioExport(portfolio: unknown, exportedAt = new Date()) {
  const exportedAtIso = exportedAt.toISOString();
  const portfolioChecksum = crypto.createHash("sha256").update(JSON.stringify(portfolio)).digest("hex");
  const payload: LearnerPortfolioPayload = {
    schemaVersion: "1.0",
    documentId: `teras-portfolio-${portfolioChecksum.slice(0, 16)}`,
    exportedAt: exportedAtIso,
    portfolio,
  };
  const checksum = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");

  return {
    ...payload,
    integrity: {
      algorithm: "SHA-256" as const,
      checksum,
      canonicalization: LEARNER_PORTFOLIO_CANONICALIZATION,
      verificationNote: "Checksum verifies this exported payload. It does not represent official certification or an official competency decision.",
    },
  };
}