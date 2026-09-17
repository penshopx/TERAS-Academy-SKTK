import assert from "node:assert/strict";
import test from "node:test";
import {
  READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD,
  type RetentionCleanupStatus,
  runReadinessExportTrendRetentionCleanup,
} from "./readiness-export-trend-retention";

function sharedHealthFixture() {
  let consecutiveFailures = 0;
  let lastFailureCycle: string | null = null;
  let lastFailureAt: string | null = null;
  let lastSuccessAt: string | null = null;
  const read = (): RetentionCleanupStatus => ({
    alertActive: consecutiveFailures >= READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD,
    consecutiveFailures,
    failureThreshold: READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD,
    lastFailureAt,
    lastSuccessAt,
  });
  return {
    read,
    recordFailure: async (now: Date) => {
      const cycle = now.toISOString().slice(0, 10);
      if (cycle !== lastFailureCycle) consecutiveFailures += 1;
      lastFailureCycle = cycle;
      lastFailureAt = now.toISOString();
      return read();
    },
    successfulCleanup: async (now: Date) => {
      const recovered = read().alertActive;
      consecutiveFailures = 0;
      lastSuccessAt = now.toISOString();
      return {
        cutoffDay: "2026-06-19",
        cycleDay: now.toISOString().slice(0, 10),
        executed: true as const,
        deletedRows: 0,
        deletedAttemptKeys: 0,
        recovered,
      };
    },
  };
}

test("shared retention health warns across instances and one success recovers every reader", async () => {
  const shared = sharedHealthFixture();
  const failingCleanup = async () => {
    throw new Error("database unavailable");
  };

  for (let attempt = 1; attempt <= READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD; attempt += 1) {
    const at = new Date(`2026-09-${String(attempt).padStart(2, "0")}T01:00:00.000Z`);
    const instanceFailureWriter = shared.recordFailure;
    assert.equal(await runReadinessExportTrendRetentionCleanup(at, failingCleanup, instanceFailureWriter), null);
    const status = shared.read();
    assert.equal(status.consecutiveFailures, attempt);
    assert.equal(status.alertActive, attempt >= READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD);
    assert.equal(status.lastFailureAt, at.toISOString());
    assert.equal(status.lastSuccessAt, null);
  }

  const recoveredAt = new Date("2026-09-04T01:00:00.000Z");
  await runReadinessExportTrendRetentionCleanup(recoveredAt, shared.successfulCleanup, shared.recordFailure);
  const independentReaderAfterRecovery = shared.read;
  assert.deepEqual(independentReaderAfterRecovery(), {
    alertActive: false,
    consecutiveFailures: 0,
    failureThreshold: READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD,
    lastFailureAt: "2026-09-03T01:00:00.000Z",
    lastSuccessAt: recoveredAt.toISOString(),
  });
});

test("a skipped claimed cycle does not hide an active warning", async () => {
  const shared = sharedHealthFixture();
  const failingCleanup = async () => {
    throw new Error("database unavailable");
  };
  for (let attempt = 0; attempt < READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD; attempt += 1) {
    const day = String(attempt + 5).padStart(2, "0");
    await runReadinessExportTrendRetentionCleanup(new Date(`2026-09-${day}T01:00:00.000Z`), failingCleanup, shared.recordFailure);
  }
  await runReadinessExportTrendRetentionCleanup(new Date("2026-09-05T02:00:00.000Z"), async now => ({
    cutoffDay: "2026-06-07",
    cycleDay: now.toISOString().slice(0, 10),
    executed: false as const,
    deletedRows: 0,
    deletedAttemptKeys: 0,
  }), shared.recordFailure);
  assert.equal(shared.read().alertActive, true);
});
