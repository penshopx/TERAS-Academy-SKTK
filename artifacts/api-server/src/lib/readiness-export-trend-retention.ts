import { eq, lt, sql } from "drizzle-orm";
import {
  db,
  readinessAuditExportAggregatesTable,
  readinessAuditExportAttemptsTable,
  readinessAuditExportRetentionCyclesTable,
  readinessAuditExportRetentionHealthTable,
} from "@workspace/db";
import { logger } from "./logger";

/** Daily aggregates are kept for 90 complete UTC days; the current day is additional. */
export const READINESS_EXPORT_TREND_RETENTION_DAYS = 90;
export const READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD = 3;

export type RetentionCleanupStatus = {
  alertActive: boolean;
  consecutiveFailures: number;
  failureThreshold: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
};

const RETENTION_HEALTH_ID = "global";

function retentionCleanupStatus(row?: {
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
}): RetentionCleanupStatus {
  const consecutiveFailures = row?.consecutiveFailures ?? 0;
  return {
    alertActive: consecutiveFailures >= READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD,
    consecutiveFailures,
    failureThreshold: READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD,
    lastFailureAt: row?.lastFailureAt?.toISOString() ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
  };
}

export async function getReadinessExportTrendRetentionStatus(executor: any = db): Promise<RetentionCleanupStatus> {
  const [row] = await executor.select({
    consecutiveFailures: readinessAuditExportRetentionHealthTable.consecutiveFailures,
    lastFailureAt: readinessAuditExportRetentionHealthTable.lastFailureAt,
    lastSuccessAt: readinessAuditExportRetentionHealthTable.lastSuccessAt,
  }).from(readinessAuditExportRetentionHealthTable)
    .where(eq(readinessAuditExportRetentionHealthTable.id, RETENTION_HEALTH_ID))
    .limit(1);
  return retentionCleanupStatus(row);
}

export async function recordReadinessExportTrendRetentionFailure(now = new Date(), executor: any = db) {
  const cycleDay = now.toISOString().slice(0, 10);
  const [row] = await executor.insert(readinessAuditExportRetentionHealthTable)
    .values({
      id: RETENTION_HEALTH_ID,
      consecutiveFailures: 1,
      lastFailureCycle: cycleDay,
      lastFailureAt: now,
    })
    .onConflictDoUpdate({
      target: readinessAuditExportRetentionHealthTable.id,
      set: {
        consecutiveFailures: sql`CASE
          WHEN ${readinessAuditExportRetentionHealthTable.lastFailureCycle} IS DISTINCT FROM ${cycleDay}
          THEN ${readinessAuditExportRetentionHealthTable.consecutiveFailures} + 1
          ELSE ${readinessAuditExportRetentionHealthTable.consecutiveFailures}
        END`,
        lastFailureCycle: cycleDay,
        lastFailureAt: now,
      },
    })
    .returning({
      consecutiveFailures: readinessAuditExportRetentionHealthTable.consecutiveFailures,
      lastFailureAt: readinessAuditExportRetentionHealthTable.lastFailureAt,
      lastSuccessAt: readinessAuditExportRetentionHealthTable.lastSuccessAt,
    });
  return retentionCleanupStatus(row);
}

export async function recordReadinessExportTrendRetentionSuccess(now: Date, executor: any) {
  const [row] = await executor.insert(readinessAuditExportRetentionHealthTable)
    .values({
      id: RETENTION_HEALTH_ID,
      consecutiveFailures: 0,
      lastSuccessAt: now,
    })
    .onConflictDoUpdate({
      target: readinessAuditExportRetentionHealthTable.id,
      set: {
        consecutiveFailures: 0,
        lastSuccessAt: now,
      },
    })
    .returning({
      consecutiveFailures: readinessAuditExportRetentionHealthTable.consecutiveFailures,
      lastFailureAt: readinessAuditExportRetentionHealthTable.lastFailureAt,
      lastSuccessAt: readinessAuditExportRetentionHealthTable.lastSuccessAt,
    });
  return retentionCleanupStatus(row);
}

export function readinessExportTrendRetentionCutoff(now = new Date()) {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCDate(cutoff.getUTCDate() - READINESS_EXPORT_TREND_RETENTION_DAYS);
  return cutoff.toISOString().slice(0, 10);
}

export async function pruneReadinessExportTrendAggregates(now = new Date()) {
  const cutoffDay = readinessExportTrendRetentionCutoff(now);
  return db.transaction(async tx => {
    const cycleDay = now.toISOString().slice(0, 10);
    const claimed = await tx.insert(readinessAuditExportRetentionCyclesTable)
      .values({ day: cycleDay })
      .onConflictDoNothing()
      .returning({ day: readinessAuditExportRetentionCyclesTable.day });
    if (claimed.length === 0) {
      return {
        cutoffDay,
        cycleDay,
        executed: false as const,
        deletedRows: 0,
        deletedAttemptKeys: 0,
      };
    }
    const deletedAggregates = await tx.delete(readinessAuditExportAggregatesTable)
      .where(lt(readinessAuditExportAggregatesTable.day, cutoffDay))
      .returning({ day: readinessAuditExportAggregatesTable.day });
    const deletedAttempts = await tx.delete(readinessAuditExportAttemptsTable)
      .where(lt(readinessAuditExportAttemptsTable.day, cutoffDay))
      .returning({ day: readinessAuditExportAttemptsTable.day });
    await tx.delete(readinessAuditExportRetentionCyclesTable)
      .where(lt(readinessAuditExportRetentionCyclesTable.day, cutoffDay));
    const previousStatus = await getReadinessExportTrendRetentionStatus(tx);
    await recordReadinessExportTrendRetentionSuccess(now, tx);
    return {
      cutoffDay,
      cycleDay,
      executed: true as const,
      deletedRows: deletedAggregates.length,
      deletedAttemptKeys: deletedAttempts.length,
      recovered: previousStatus.alertActive,
    };
  });
}

export async function runReadinessExportTrendRetentionCleanup(
  now = new Date(),
  cleanup: (at: Date) => ReturnType<typeof pruneReadinessExportTrendAggregates> = pruneReadinessExportTrendAggregates,
  recordFailure: (at: Date) => Promise<RetentionCleanupStatus> = recordReadinessExportTrendRetentionFailure,
) {
  try {
    const result = await cleanup(now);
    if (!result.executed) {
      logger.info({ cutoffDay: result.cutoffDay, cycleDay: result.cycleDay }, "Readiness export trend retention cleanup skipped; this UTC cycle was already claimed");
      return result;
    }
    logger.info(result, result.recovered
      ? "Readiness export trend retention cleanup recovered; operational warning closed"
      : "Readiness export trend retention cleanup completed");
    return result;
  } catch (error) {
    logger.error({ err: error }, "Readiness export trend retention cleanup failed");
    try {
      const status = await recordFailure(now);
      if (status.alertActive) {
        logger.warn(status, "Operational warning: readiness export trend retention cleanup is repeatedly failing");
      }
    } catch (statusError) {
      logger.error({ err: statusError }, "Readiness export trend retention cleanup failure status could not be recorded");
    }
    return null;
  }
}

export function startReadinessExportTrendRetentionScheduler() {
  if (process.env.NODE_ENV === "test") return;
  const run = () => runReadinessExportTrendRetentionCleanup();
  const initial = setTimeout(run, 30_000);
  const interval = setInterval(run, 24 * 60 * 60_000);
  initial.unref();
  interval.unref();
}