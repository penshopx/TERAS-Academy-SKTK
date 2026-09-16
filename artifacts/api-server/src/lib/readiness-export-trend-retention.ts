import { lt } from "drizzle-orm";
import { db, readinessAuditExportAggregatesTable, readinessAuditExportAttemptsTable } from "@workspace/db";
import { logger } from "./logger";

/** Daily aggregates are kept for 90 complete UTC days; the current day is additional. */
export const READINESS_EXPORT_TREND_RETENTION_DAYS = 90;

export function readinessExportTrendRetentionCutoff(now = new Date()) {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCDate(cutoff.getUTCDate() - READINESS_EXPORT_TREND_RETENTION_DAYS);
  return cutoff.toISOString().slice(0, 10);
}

export async function pruneReadinessExportTrendAggregates(now = new Date()) {
  const cutoffDay = readinessExportTrendRetentionCutoff(now);
  const { deletedAggregates, deletedAttempts } = await db.transaction(async tx => {
    const deletedAggregates = await tx.delete(readinessAuditExportAggregatesTable)
      .where(lt(readinessAuditExportAggregatesTable.day, cutoffDay))
      .returning({ day: readinessAuditExportAggregatesTable.day });
    const deletedAttempts = await tx.delete(readinessAuditExportAttemptsTable)
      .where(lt(readinessAuditExportAttemptsTable.day, cutoffDay))
      .returning({ day: readinessAuditExportAttemptsTable.day });
    return { deletedAggregates, deletedAttempts };
  });
  return {
    cutoffDay,
    deletedRows: deletedAggregates.length,
    deletedAttemptKeys: deletedAttempts.length,
  };
}

export function startReadinessExportTrendRetentionScheduler() {
  if (process.env.NODE_ENV === "test") return;
  const run = () => pruneReadinessExportTrendAggregates().then(
    result => logger.info(result, "Readiness export trend retention cleanup completed"),
    error => logger.error({ err: error }, "Readiness export trend retention cleanup failed"),
  );
  const initial = setTimeout(run, 30_000);
  const interval = setInterval(run, 24 * 60 * 60_000);
  initial.unref();
  interval.unref();
}