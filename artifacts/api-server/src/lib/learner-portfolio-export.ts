import crypto from "node:crypto";

export const LEARNER_PORTFOLIO_CANONICALIZATION = "teras-learner-portfolio-v1-json-stringify";

export type LearnerPortfolioPayload = {
  schemaVersion: "1.0";
  documentId: string;
  exportedAt: string;
  portfolio: unknown;
};

export type TimelineExportPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export async function collectTimelineExportPages<T>(
  fetchPage: (cursor?: string) => Promise<TimelineExportPage<T>>,
) {
  const items: T[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Timeline pagination returned a repeated cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);

  return items;
}

export async function collectTimelineSnapshotPages<TSnapshot, T>(
  loadSnapshot: () => Promise<TSnapshot>,
  fetchPage: (snapshot: TSnapshot, cursor?: string) => TimelineExportPage<T> | Promise<TimelineExportPage<T>>,
) {
  const snapshot = await loadSnapshot();
  return {
    snapshot,
    items: await collectTimelineExportPages(async cursor => fetchPage(snapshot, cursor)),
  };
}

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