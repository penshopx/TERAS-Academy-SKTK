import assert from "node:assert/strict";
import test from "node:test";
import {
  READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD,
  READINESS_EXPORT_TREND_MISSED_CYCLE_THRESHOLD,
  type RetentionCleanupStatus,
  retentionCleanupStatus,
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
    missedCycles: 0,
    missedCycleThreshold: READINESS_EXPORT_TREND_MISSED_CYCLE_THRESHOLD,
    scheduleDelayed: false,
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
    missedCycles: 0,
    missedCycleThreshold: READINESS_EXPORT_TREND_MISSED_CYCLE_THRESHOLD,
    scheduleDelayed: false,
  });
});

test("missed UTC cycles are distinct from failed attempts and clear after a new attempt", () => {
  const success = new Date("2026-09-26T23:59:59.000Z");
  const row = { consecutiveFailures: 0, lastSuccessAt: success, lastFailureAt: null };
  assert.equal(retentionCleanupStatus(row, new Date("2026-09-27T23:59:59.999Z")).missedCycles, 0,
    "The current UTC cycle is not overdue, even near midnight");
  const overdue = retentionCleanupStatus(row, new Date("2026-09-28T00:00:00.000Z"));
  assert.equal(overdue.missedCycles, READINESS_EXPORT_TREND_MISSED_CYCLE_THRESHOLD);
  assert.equal(overdue.scheduleDelayed, true);
  assert.equal(overdue.alertActive, false);
  assert.equal(overdue.consecutiveFailures, 0);
  assert.equal(retentionCleanupStatus(row, new Date("2026-09-29T10:00:00.000Z")).missedCycles, 2);

  const attempted = retentionCleanupStatus({
    ...row, consecutiveFailures: 1, lastFailureAt: new Date("2026-09-28T00:01:00.000Z"),
  }, new Date("2026-09-28T10:00:00.000Z"));
  assert.equal(attempted.scheduleDelayed, false, "A failure means the scheduler ran; it is not a missed cycle");
  assert.equal(attempted.consecutiveFailures, 1);
  const failedOften = retentionCleanupStatus({
    ...row, consecutiveFailures: READINESS_EXPORT_TREND_RETENTION_ALERT_THRESHOLD,
    lastFailureAt: new Date("2026-09-28T00:01:00.000Z"),
  }, new Date("2026-09-28T10:00:00.000Z"));
  assert.equal(failedOften.alertActive, true);
  assert.equal(failedOften.scheduleDelayed, false);
  const neverAttempted = {
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    monitoringStartedAt: new Date("2026-09-26T23:59:59.000Z"),
  };
  assert.equal(retentionCleanupStatus(neverAttempted, new Date("2026-09-27T23:59:59.999Z")).scheduleDelayed, false);
  const delayedFirstRun = retentionCleanupStatus(neverAttempted, new Date("2026-09-28T00:00:00.000Z"));
  assert.equal(delayedFirstRun.missedCycles, 1);
  assert.equal(delayedFirstRun.scheduleDelayed, true,
    "A persisted startup baseline detects missed cycles even without any cleanup attempt");
  assert.equal(delayedFirstRun.alertActive, false);
  assert.equal(retentionCleanupStatus({
    ...row, lastSuccessAt: new Date("2026-09-28T12:00:00.000Z"),
  }, new Date("2026-09-28T10:00:00.000Z")).missedCycles, 0,
    "Clock skew must not create negative missed cycles");
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
