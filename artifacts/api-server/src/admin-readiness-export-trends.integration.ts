import assert from "node:assert/strict";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  readinessAuditExportAggregatesTable,
  readinessAuditExportAttemptsTable,
  readinessAuditExportRetentionCyclesTable,
  readinessAuditExportRetentionHealthTable,
} from "@workspace/db";
import { createIntegrationTestApp } from "./integration-test-app";
import {
  pruneReadinessExportTrendAggregates,
  getReadinessExportTrendRetentionStatus,
  recordReadinessExportTrendRetentionFailure,
  recordReadinessExportTrendRetentionSuccess,
  READINESS_EXPORT_TREND_RETENTION_DAYS,
  readinessExportTrendRetentionCutoff,
} from "./lib/readiness-export-trend-retention";

const suffix = crypto.randomUUID();
const seed = Number.parseInt(suffix.replaceAll("-", "").slice(0, 6), 16);
const datePart = (offset: number) => ({
  year: 1900 + ((seed + offset) % 100),
  month: 1 + ((seed + offset) % 12),
  day: 1 + ((seed + offset) % 28),
});
const formatDate = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const past = datePart(0);
const future = datePart(1);
const fixturePastDay = formatDate(past.year, past.month, past.day);
const fixtureFutureDay = formatDate(2100 + (future.year - 1900), future.month, future.day);
const today = new Date().toISOString().slice(0, 10);
const retentionNow = new Date(`${today}T12:00:00.000Z`);
const nextRetentionCycle = new Date(retentionNow);
nextRetentionCycle.setUTCDate(nextRetentionCycle.getUTCDate() + 1);
const nextRetentionCycleDay = nextRetentionCycle.toISOString().slice(0, 10);
const retentionCutoffDay = readinessExportTrendRetentionCutoff(retentionNow);
const olderThanRetention = new Date(`${retentionCutoffDay}T00:00:00.000Z`);
olderThanRetention.setUTCDate(olderThanRetention.getUTCDate() - 1);
const expiredRetentionDay = olderThanRetention.toISOString().slice(0, 10);
const newerThanRetention = new Date(`${retentionCutoffDay}T00:00:00.000Z`);
newerThanRetention.setUTCDate(newerThanRetention.getUTCDate() + 1);
const retainedAfterCutoffDay = newerThanRetention.toISOString().slice(0, 10);
const activePeriodDay = new Date(`${today}T00:00:00.000Z`);
activePeriodDay.setUTCDate(activePeriodDay.getUTCDate() - 6);
const activeFixtureDay = activePeriodDay.toISOString().slice(0, 10);
const expiredAttemptKey = `retention-rollback-${suffix}`;
const boundaryAttemptKey = crypto.randomUUID();
const afterBoundaryAttemptKey = crypto.randomUUID();
const activeRetryAttemptKey = crypto.randomUUID();
const rejectExpiredAttemptDelete = sql.identifier(`reject_retention_attempt_${suffix.replaceAll("-", "")}`);

const app = createIntegrationTestApp(request => {
  const role = request.get("x-test-role");
  return {
    userId: role ? `${role}-readiness-export-trends-${suffix}` : null,
    role: role === "admin" ? "admin" : role === "learner" ? "learner" : null,
  };
});

async function run() {
  const fixtureDays = [
    fixturePastDay,
    fixtureFutureDay,
    expiredRetentionDay,
    retentionCutoffDay,
    retainedAfterCutoffDay,
    activeFixtureDay,
  ];
  const baselineRows = await db.select()
    .from(readinessAuditExportAggregatesTable)
    .where(inArray(readinessAuditExportAggregatesTable.day, [today, ...fixtureDays]));
  const baselineAttempts = await db.select()
    .from(readinessAuditExportAttemptsTable)
    .where(inArray(readinessAuditExportAttemptsTable.day, [today, ...fixtureDays]));
  const baselineRetentionCycles = await db.select()
    .from(readinessAuditExportRetentionCyclesTable)
    .where(inArray(readinessAuditExportRetentionCyclesTable.day, [today, nextRetentionCycleDay]));
  const baselineRetentionHealth = await db.select().from(readinessAuditExportRetentionHealthTable);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Test server did not bind");
  const endpoint = `http://127.0.0.1:${address.port}/api/admin/readiness-history/export-trends`;
  const request = (role: "admin" | "learner" | null, init: RequestInit = {}) => fetch(endpoint, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(role ? { "x-test-role": role } : {}),
      ...init.headers,
    },
  });
  const post = (role: "admin" | "learner" | null, body: unknown) => request(role, {
    method: "POST",
    body: JSON.stringify(body && typeof body === "object" && !("attemptKey" in body)
      ? { attemptKey: crypto.randomUUID(), ...body }
      : body),
  });

  try {
    // Isolate this test's current UTC day, then restore it in finally.
    await db.delete(readinessAuditExportAggregatesTable)
      .where(inArray(readinessAuditExportAggregatesTable.day, [today, ...fixtureDays]));
    await db.delete(readinessAuditExportAttemptsTable)
      .where(inArray(readinessAuditExportAttemptsTable.day, [today, ...fixtureDays]));
    await db.delete(readinessAuditExportRetentionCyclesTable)
      .where(inArray(readinessAuditExportRetentionCyclesTable.day, [today, nextRetentionCycleDay]));
    await db.delete(readinessAuditExportRetentionHealthTable);
    await db.insert(readinessAuditExportAggregatesTable).values([
      { day: fixturePastDay, recordGroup: "1.000–4.999 record", outcome: "failed", count: 99 },
      { day: fixtureFutureDay, recordGroup: "1.000–4.999 record", outcome: "succeeded", count: 99 },
      { day: expiredRetentionDay, recordGroup: "5.000–9.999 record", outcome: "succeeded", count: 7 },
      { day: retentionCutoffDay, recordGroup: "5.000–9.999 record", outcome: "succeeded", count: 8 },
      { day: activeFixtureDay, recordGroup: "10.000+ record", outcome: "succeeded", count: 9 },
    ]);
    await db.insert(readinessAuditExportAttemptsTable).values([
      { attemptKey: expiredAttemptKey, day: expiredRetentionDay },
      { attemptKey: boundaryAttemptKey, day: retentionCutoffDay },
      { attemptKey: afterBoundaryAttemptKey, day: retainedAfterCutoffDay },
      { attemptKey: activeRetryAttemptKey, day: activeFixtureDay },
    ]);

    assert(READINESS_EXPORT_TREND_RETENTION_DAYS > 7, "Retention must exceed the active reporting period");
    const fixtureAggregatesBeforeFailure = await db.select().from(readinessAuditExportAggregatesTable)
      .where(inArray(readinessAuditExportAggregatesTable.day, fixtureDays))
      .orderBy(asc(readinessAuditExportAggregatesTable.day), asc(readinessAuditExportAggregatesTable.recordGroup), asc(readinessAuditExportAggregatesTable.outcome));
    const fixtureAttemptsBeforeFailure = await db.select().from(readinessAuditExportAttemptsTable)
      .where(inArray(readinessAuditExportAttemptsTable.attemptKey, [
        expiredAttemptKey, boundaryAttemptKey, afterBoundaryAttemptKey, activeRetryAttemptKey,
      ])).orderBy(asc(readinessAuditExportAttemptsTable.attemptKey));
    const healthBeforeFailure = await getReadinessExportTrendRetentionStatus();
    try {
      await db.execute(sql`
        CREATE FUNCTION ${rejectExpiredAttemptDelete}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced retention attempt deletion failure';
        END
        $$
      `);
      await db.execute(sql`
        CREATE TRIGGER ${rejectExpiredAttemptDelete}
        BEFORE DELETE ON teras_readiness_audit_export_attempts
        FOR EACH ROW WHEN (OLD.attempt_key LIKE 'retention-rollback-%')
        EXECUTE FUNCTION ${rejectExpiredAttemptDelete}()
      `);
      await assert.rejects(
        pruneReadinessExportTrendAggregates(retentionNow),
        (error: unknown) => error instanceof Error
          && (error as Error & { cause?: Error }).cause?.message === "forced retention attempt deletion failure",
        "Attempt deletion must fail after the cycle claim and aggregate deletion",
      );
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS ${rejectExpiredAttemptDelete} ON teras_readiness_audit_export_attempts`);
      await db.execute(sql`DROP FUNCTION IF EXISTS ${rejectExpiredAttemptDelete}()`);
    }
    assert.deepEqual(
      await db.select().from(readinessAuditExportRetentionCyclesTable)
        .where(eq(readinessAuditExportRetentionCyclesTable.day, today)),
      [],
      "A failed deletion must roll back the UTC cycle claim",
    );
    assert.deepEqual(
      await db.select().from(readinessAuditExportAggregatesTable)
        .where(inArray(readinessAuditExportAggregatesTable.day, fixtureDays))
        .orderBy(asc(readinessAuditExportAggregatesTable.day), asc(readinessAuditExportAggregatesTable.recordGroup), asc(readinessAuditExportAggregatesTable.outcome)),
      fixtureAggregatesBeforeFailure,
      "A failed deletion must restore all aggregate rows, including ones deleted earlier in the transaction",
    );
    assert.deepEqual(
      await db.select().from(readinessAuditExportAttemptsTable)
        .where(inArray(readinessAuditExportAttemptsTable.attemptKey, [
          expiredAttemptKey, boundaryAttemptKey, afterBoundaryAttemptKey, activeRetryAttemptKey,
        ])).orderBy(asc(readinessAuditExportAttemptsTable.attemptKey)),
      fixtureAttemptsBeforeFailure,
      "A failed deletion must leave retry keys unchanged",
    );
    assert.deepEqual(await getReadinessExportTrendRetentionStatus(), healthBeforeFailure,
      "A failed cleanup must not record a partial success");

    const concurrentCleanup = await Promise.all([
      pruneReadinessExportTrendAggregates(retentionNow),
      pruneReadinessExportTrendAggregates(retentionNow),
    ]);
    const executedCleanups = concurrentCleanup.filter(result => result.executed);
    const skippedCleanups = concurrentCleanup.filter(result => !result.executed);
    assert.equal(executedCleanups.length, 1, "A same-day retry must execute exactly one concurrent cleanup");
    assert.equal(skippedCleanups.length, 1, "The other concurrent cleanup must skip without error");
    const retriedCleanup = executedCleanups[0]!;
    const afterCommitCleanup = await pruneReadinessExportTrendAggregates(retentionNow);
    assert.equal(afterCommitCleanup.executed, false, "A later invocation in the claimed UTC cycle must skip");
    assert(retriedCleanup.cutoffDay === retentionCutoffDay && retriedCleanup.deletedRows >= 2,
      "Cleanup must report at least the fixture rows strictly older than the retention cutoff");
    assert(retriedCleanup.deletedAttemptKeys >= 1,
      "Cleanup must report deletion of retry keys strictly older than the retention cutoff");
    const retainedFixtures = await db.select().from(readinessAuditExportAggregatesTable)
      .where(inArray(readinessAuditExportAggregatesTable.day, [expiredRetentionDay, retentionCutoffDay, activeFixtureDay]));
    assert(!retainedFixtures.some(row => row.day === expiredRetentionDay), "Expired retention rows must be deleted");
    assert(retainedFixtures.some(row => row.day === retentionCutoffDay), "The retention boundary day must remain");
    assert(retainedFixtures.some(row => row.day === activeFixtureDay), "The active seven-day period must remain");
    const retainedAttemptKeys = await db.select().from(readinessAuditExportAttemptsTable)
      .where(inArray(readinessAuditExportAttemptsTable.attemptKey, [
        expiredAttemptKey,
        boundaryAttemptKey,
        afterBoundaryAttemptKey,
        activeRetryAttemptKey,
      ]));
    assert(!retainedAttemptKeys.some(row => row.attemptKey === expiredAttemptKey),
      "Retry keys before the retention boundary must be deleted");
    assert(retainedAttemptKeys.some(row => row.attemptKey === boundaryAttemptKey),
      "A retry key exactly on the retention boundary must remain");
    assert(retainedAttemptKeys.some(row => row.attemptKey === afterBoundaryAttemptKey),
      "A retry key after the retention boundary must remain");
    assert(retainedAttemptKeys.some(row => row.attemptKey === activeRetryAttemptKey),
      "Retry protection for the active reporting period must remain");
    const nextCycleCleanup = await pruneReadinessExportTrendAggregates(nextRetentionCycle);
    assert.equal(nextCycleCleanup.executed, true, "A new UTC cycle must be eligible to execute");

    const failureDays = ["2097-01-01", "2097-01-02", "2097-01-03"];
    for (const day of failureDays) {
      await Promise.all([
        recordReadinessExportTrendRetentionFailure(new Date(`${day}T01:00:00.000Z`)),
        recordReadinessExportTrendRetentionFailure(new Date(`${day}T02:00:00.000Z`)),
      ]);
    }
    const sharedAlarm = await getReadinessExportTrendRetentionStatus();
    assert.equal(sharedAlarm.consecutiveFailures, 3, "Concurrent instances must count one failure per UTC cycle");
    assert.equal(sharedAlarm.alertActive, true, "The shared alarm must activate at the configured threshold");
    const recoveredAt = new Date("2097-01-04T01:00:00.000Z");
    await db.transaction(tx => recordReadinessExportTrendRetentionSuccess(recoveredAt, tx));
    const sharedRecovery = await getReadinessExportTrendRetentionStatus();
    assert.equal(sharedRecovery.alertActive, false, "One successful cleanup must clear the alarm for every reader");
    assert.equal(sharedRecovery.lastSuccessAt, recoveredAt.toISOString(), "Shared health must retain the latest success time");

    assert((await request(null)).status === 401, "Unauthenticated GET must be rejected");
    assert((await post(null, { outcome: "failed", recordCount: 1_000 })).status === 401, "Unauthenticated POST must be rejected");
    assert((await request("learner")).status === 403, "Non-admin GET must be rejected");
    assert((await post("learner", { outcome: "failed", recordCount: 1_000 })).status === 403, "Non-admin POST must be rejected");
    assert((await request("admin", {
      method: "POST",
      body: JSON.stringify({ outcome: "failed", recordCount: 1_000 }),
    })).status === 400, "Every outcome must include an attempt key");
    assert((await post("admin", {
      attemptKey: "contains-identity-or-filter-data",
      outcome: "failed",
      recordCount: 1_000,
    })).status === 400, "Attempt keys must use the anonymous UUID shape");
    assert((await post("admin", {
      outcome: "failed",
      recordCount: 1_000,
      actorId: "must-not-be-accepted",
    })).status === 400, "Identifying POST fields must be rejected");

    assert((await post("admin", { outcome: "failed", recordCount: 999 })).status === 204, "Small samples must be accepted and ignored");
    assert((await post("admin", { outcome: "started", recordCount: 1_000 })).status === 204, "Started outcomes must be accepted and ignored");
    assert((await post("admin", {
      attemptKey: activeRetryAttemptKey,
      outcome: "succeeded",
      recordCount: 10_000,
    })).status === 204, "A retry protected by an active key must succeed without recounting");
    assert((await db.select().from(readinessAuditExportAggregatesTable).where(eq(readinessAuditExportAggregatesTable.day, today))).length === 0, "Ignored inputs must not create aggregate rows");

    const boundaryWrites = [
      { outcome: "succeeded", recordCount: 1_000 },
      { outcome: "succeeded", recordCount: 4_999 },
      { outcome: "succeeded", recordCount: 5_000 },
      { outcome: "succeeded", recordCount: 9_999 },
      { outcome: "succeeded", recordCount: 10_000 },
    ];
    for (const body of boundaryWrites) {
      assert((await post("admin", body)).status === 204, "Admin boundary write must succeed");
    }

    const concurrentWrites = Array.from({ length: 8 }, () => post("admin", {
      outcome: "succeeded",
      recordCount: 1_500,
    }));
    assert((await Promise.all(concurrentWrites)).every(response => response.status === 204), "Concurrent writes must succeed");

    const lostResponseAttemptKey = crypto.randomUUID();
    await post("admin", {
      attemptKey: lostResponseAttemptKey,
      outcome: "succeeded",
      recordCount: 1_500,
    });
    assert((await post("admin", {
      attemptKey: lostResponseAttemptKey,
      outcome: "succeeded",
      recordCount: 1_500,
    })).status === 204, "Retry after a lost response must succeed");

    const concurrentRetryAttemptKey = crypto.randomUUID();
    const concurrentRetries = await Promise.all(Array.from({ length: 8 }, () => post("admin", {
      attemptKey: concurrentRetryAttemptKey,
      outcome: "succeeded",
      recordCount: 1_500,
    })));
    assert(concurrentRetries.every(response => response.status === 204), "Concurrent retries with one attempt key must succeed");

    const groupedResponses = await Promise.all([
      post("admin", { outcome: "failed", recordCount: 5_500 }),
      post("admin", { outcome: "cancelled", recordCount: 5_500 }),
      post("admin", { outcome: "cancelled", recordCount: 5_500 }),
      ...Array.from({ length: 20 }, () => post("admin", { outcome: "failed", recordCount: 10_000 })),
    ]);
    assert(groupedResponses.every(response => response.status === 204), "Grouped outcome writes must succeed");

    const response = await request("admin");
    assert(response.status === 200, "Admin GET must succeed");
    const summary = await response.json() as any;
    assert.deepEqual(Object.keys(summary).sort(), ["aggregates", "alerts", "periodEnd", "periodStart", "retentionCleanup", "thresholds"], "Summary must expose only its contract fields");
    assert.deepEqual(Object.keys(summary.retentionCleanup).sort(), ["alertActive", "consecutiveFailures", "failureThreshold", "lastFailureAt", "lastSuccessAt"], "Cleanup monitoring must expose only anonymous operational fields");
    assert.deepEqual(summary.thresholds, {
      minimumRecordCount: 1_000,
      minimumSampleSize: 5,
      failureRatio: 0.4,
      periodDays: 7,
    }, "Summary must expose the server-owned thresholds");
    const expectedEnd = new Date().toISOString().slice(0, 10);
    const expectedStartDate = new Date(`${expectedEnd}T00:00:00.000Z`);
    expectedStartDate.setUTCDate(expectedStartDate.getUTCDate() - 6);
    const expectedStart = expectedStartDate.toISOString().slice(0, 10);
    assert(summary.periodStart === expectedStart && summary.periodEnd === expectedEnd,
      `Summary must use seven inclusive UTC days: got ${summary.periodStart}..${summary.periodEnd}, expected ${expectedStart}..${expectedEnd}`);
    assert(summary.aggregates.every((aggregate: any) =>
      Object.keys(aggregate).sort().join(",") === "count,outcome,periodEnd,periodStart,recordGroup"
      && aggregate.periodStart >= expectedStart
      && aggregate.periodEnd <= expectedEnd), "Aggregate response must contain only anonymous dimensions");
    const forbiddenKey = JSON.stringify(summary).match(/attemptKey|actor|identity|learner|pathway|filter|audit|content/i);
    assert(!forbiddenKey, `Summary must not expose attempt keys, identity, filter, audit, or raw content (matched ${forbiddenKey?.[0]})`);

    const aggregate = (recordGroup: string, outcome: string) => summary.aggregates.find((item: any) =>
      item.recordGroup === recordGroup && item.outcome === outcome && item.periodStart === expectedEnd);
    assert(aggregate("1.000–4.999 record", "succeeded")?.count === 12,
      "Unique writes must increment atomically while lost-response and concurrent retries count once each");
    assert(aggregate("5.000–9.999 record", "succeeded")?.count === 2, "5.000–9.999 boundaries must map to one group");
    assert(aggregate("10.000+ record", "succeeded")?.count === 1, "10.000+ boundary must map to one group");
    assert(aggregate("5.000–9.999 record", "failed")?.count === 1, "Failed outcomes must be grouped");
    assert(aggregate("5.000–9.999 record", "cancelled")?.count === 2, "Cancelled outcomes must be grouped");
    assert(aggregate("5.000–9.999 record", "succeeded")?.count === 2, "Boundary writes must remain independent from retained active history");
    assert(summary.aggregates.some((item: any) => item.periodStart === activeFixtureDay && item.count === 9),
      "Cleanup must preserve aggregates inside the active seven-day period");
    assert(!summary.aggregates.some((item: any) => item.periodStart === fixturePastDay || item.periodStart === fixtureFutureDay), "Expired and future fixtures must be excluded");

    const alert = summary.alerts.find((item: any) => item.recordGroup === "5.000–9.999 record");
    assert(alert && alert.sampleSize === 5 && alert.failedCount === 3 && alert.failureRatio === 0.6, "Failure and cancelled outcomes must create the expected alert");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.delete(readinessAuditExportAggregatesTable)
      .where(inArray(readinessAuditExportAggregatesTable.day, [today, ...fixtureDays]));
    await db.delete(readinessAuditExportAttemptsTable)
      .where(inArray(readinessAuditExportAttemptsTable.day, [today, ...fixtureDays]));
    await db.delete(readinessAuditExportRetentionCyclesTable)
      .where(inArray(readinessAuditExportRetentionCyclesTable.day, [today, nextRetentionCycleDay]));
    await db.delete(readinessAuditExportRetentionHealthTable);
    if (baselineRows.length) await db.insert(readinessAuditExportAggregatesTable).values(baselineRows);
    if (baselineAttempts.length) await db.insert(readinessAuditExportAttemptsTable).values(baselineAttempts);
    if (baselineRetentionCycles.length) {
      await db.insert(readinessAuditExportRetentionCyclesTable).values(baselineRetentionCycles);
    }
    if (baselineRetentionHealth.length) {
      await db.insert(readinessAuditExportRetentionHealthTable).values(baselineRetentionHealth);
    }
  }
}

await run();