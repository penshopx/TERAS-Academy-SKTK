import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, readinessAuditExportAggregatesTable } from "@workspace/db";
import { createIntegrationTestApp } from "./integration-test-app";
import {
  pruneReadinessExportTrendAggregates,
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
const retentionCutoffDay = readinessExportTrendRetentionCutoff(retentionNow);
const olderThanRetention = new Date(`${retentionCutoffDay}T00:00:00.000Z`);
olderThanRetention.setUTCDate(olderThanRetention.getUTCDate() - 1);
const expiredRetentionDay = olderThanRetention.toISOString().slice(0, 10);
const activePeriodDay = new Date(`${today}T00:00:00.000Z`);
activePeriodDay.setUTCDate(activePeriodDay.getUTCDate() - 6);
const activeFixtureDay = activePeriodDay.toISOString().slice(0, 10);

const app = createIntegrationTestApp(request => {
  const role = request.get("x-test-role");
  return {
    userId: role ? `${role}-readiness-export-trends-${suffix}` : null,
    role: role === "admin" ? "admin" : role === "learner" ? "learner" : null,
  };
});

async function run() {
  const fixtureDays = [fixturePastDay, fixtureFutureDay, expiredRetentionDay, retentionCutoffDay, activeFixtureDay];
  const baselineRows = await db.select()
    .from(readinessAuditExportAggregatesTable)
    .where(inArray(readinessAuditExportAggregatesTable.day, [today, ...fixtureDays]));
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
    body: JSON.stringify(body),
  });

  try {
    // Isolate this test's current UTC day, then restore it in finally.
    await db.delete(readinessAuditExportAggregatesTable)
      .where(inArray(readinessAuditExportAggregatesTable.day, [today, ...fixtureDays]));
    await db.insert(readinessAuditExportAggregatesTable).values([
      { day: fixturePastDay, recordGroup: "1.000–4.999 record", outcome: "failed", count: 99 },
      { day: fixtureFutureDay, recordGroup: "1.000–4.999 record", outcome: "succeeded", count: 99 },
      { day: expiredRetentionDay, recordGroup: "5.000–9.999 record", outcome: "succeeded", count: 7 },
      { day: retentionCutoffDay, recordGroup: "5.000–9.999 record", outcome: "succeeded", count: 8 },
      { day: activeFixtureDay, recordGroup: "10.000+ record", outcome: "succeeded", count: 9 },
    ]);

    assert(READINESS_EXPORT_TREND_RETENTION_DAYS > 7, "Retention must exceed the active reporting period");
    const cleanup = await pruneReadinessExportTrendAggregates(retentionNow);
    assert(cleanup.cutoffDay === retentionCutoffDay && cleanup.deletedRows >= 2,
      "Cleanup must report at least the fixture rows strictly older than the retention cutoff");
    const retainedFixtures = await db.select().from(readinessAuditExportAggregatesTable)
      .where(inArray(readinessAuditExportAggregatesTable.day, [expiredRetentionDay, retentionCutoffDay, activeFixtureDay]));
    assert(!retainedFixtures.some(row => row.day === expiredRetentionDay), "Expired retention rows must be deleted");
    assert(retainedFixtures.some(row => row.day === retentionCutoffDay), "The retention boundary day must remain");
    assert(retainedFixtures.some(row => row.day === activeFixtureDay), "The active seven-day period must remain");

    assert((await request(null)).status === 401, "Unauthenticated GET must be rejected");
    assert((await post(null, { outcome: "failed", recordCount: 1_000 })).status === 401, "Unauthenticated POST must be rejected");
    assert((await request("learner")).status === 403, "Non-admin GET must be rejected");
    assert((await post("learner", { outcome: "failed", recordCount: 1_000 })).status === 403, "Non-admin POST must be rejected");
    assert((await post("admin", {
      outcome: "failed",
      recordCount: 1_000,
      actorId: "must-not-be-accepted",
    })).status === 400, "Identifying POST fields must be rejected");

    assert((await post("admin", { outcome: "failed", recordCount: 999 })).status === 204, "Small samples must be accepted and ignored");
    assert((await post("admin", { outcome: "started", recordCount: 1_000 })).status === 204, "Started outcomes must be accepted and ignored");
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
    assert.deepEqual(Object.keys(summary).sort(), ["aggregates", "alerts", "periodEnd", "periodStart", "thresholds"], "Summary must expose only its contract fields");
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
    const forbiddenKey = JSON.stringify(summary).match(/actor|identity|learner|pathway|filter|audit|content/i);
    assert(!forbiddenKey, `Summary must not expose identity, filter, audit, or raw content (matched ${forbiddenKey?.[0]})`);

    const aggregate = (recordGroup: string, outcome: string) => summary.aggregates.find((item: any) =>
      item.recordGroup === recordGroup && item.outcome === outcome && item.periodStart === expectedEnd);
    assert(aggregate("1.000–4.999 record", "succeeded")?.count === 10, "1.000–4.999 writes must increment atomically");
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
    if (baselineRows.length) await db.insert(readinessAuditExportAggregatesTable).values(baselineRows);
  }
}

await run();