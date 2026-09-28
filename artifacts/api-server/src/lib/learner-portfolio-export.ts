import crypto from "node:crypto";

export const LEARNER_PORTFOLIO_CANONICALIZATION = "teras-learner-portfolio-v1-json-stringify";
// The raw database rows are checked before loading the full timeline. Keep
// enough headroom for relation indexes, projection, Zod parsing and JSON output.
export const MAX_PORTFOLIO_SOURCE_ROWS = 2_000;
export const MAX_PORTFOLIO_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_PORTFOLIO_JSON_BYTES = 8 * 1024 * 1024;

export class PortfolioExportTooLarge extends Error {
  constructor() {
    super("Passport history is too large to download as one file. Use the paginated Passport history instead.");
  }
}

export function assertPortfolioExportBudget(rows: number, bytes: number) {
  if (rows > MAX_PORTFOLIO_SOURCE_ROWS || bytes > MAX_PORTFOLIO_SOURCE_BYTES) {
    throw new PortfolioExportTooLarge();
  }
}

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
  const portfolioJson = JSON.stringify(portfolio);
  if (Buffer.byteLength(portfolioJson, "utf8") > MAX_PORTFOLIO_JSON_BYTES) throw new PortfolioExportTooLarge();
  const portfolioChecksum = crypto.createHash("sha256").update(portfolioJson).digest("hex");
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