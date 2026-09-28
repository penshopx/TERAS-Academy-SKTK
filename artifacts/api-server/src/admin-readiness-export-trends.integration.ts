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
import { issueReadinessExportPeriodProof } from "./lib/readiness-export-period";
import {
  pruneReadinessExportTrendAggregates,
  getReadinessExportTrendRetentionStatus,
  recordReadinessExportTrendRetentionFailure,
  recordReadinessExportTrendRetentionSuccess,
  runReadinessExportTrendRetentionCleanup,
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
const laterRetentionCycle = new Date(nextRetentionCycle);
laterRetentionCycle.setUTCDate(laterRetentionCycle.getUTCDate() + 1);
const laterRetentionCycleDay = laterRetentionCycle.toISOString().slice(0, 10);
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
const delayedPeriodDay = new Date(`${today}T12:00:00.000Z`);
delayedPeriodDay.setUTCDate(delayedPeriodDay.getUTCDate() - 8);
const delayedDay = delayedPeriodDay.toISOString().slice(0, 10);
const expiredAttemptKey = `retention-rollback-${suffix}`;
const reusableExpiredAttemptKey = crypto.randomUUID();
const boundaryAttemptKey = crypto.randomUUID();
const afterBoundaryAttemptKey = crypto.randomUUID();
const activeRetryAttemptKey = crypto.randomUUID();
const rejectExpiredAttemptDelete = sql.identifier(`reject_retention_attempt_${suffix.replaceAll("-", "")}`);
const rejectRacingAttemptDelete = sql.identifier(`reject_racing_attempt_${suffix.replaceAll("-", "")}`);
const racingFailureSequence = sql.identifier(`racing_failure_${suffix.replaceAll("-", "")}`);
const racingAttemptKey = `retention-race-${suffix}`;
const racingAggregateGroup = "1.000–4.999 record";
const racingLockNamespace = 912469;

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
    delayedDay,
  ];
  const baselineRows = await db.select()
    .from(readinessAuditExportAggregatesTable)
    .where(inArray(readinessAuditExportAggregatesTable.day, [today, ...fixtureDays]));
  const baselineAttempts = await db.select()
    .from(readinessAuditExportAttemptsTable)
    .where(inArray(readinessAuditExportAttemptsTable.day, [today, ...fixtureDays]));
  const baselineRetentionCycles = await db.select()
    .from(readinessAuditExportRetentionCyclesTable)
    .where(inArray(readinessAuditExportRetentionCyclesTable.day, [today, nextRetentionCycleDay, laterRetentionCycleDay]));
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
  const post = async (role: "admin" | "learner" | null, body: unknown) => {
    const data = body && typeof body === "object" && !("attemptKey" in body)
      ? { attemptKey: crypto.randomUUID(), ...body }
      : body;
    let proof: string | undefined;
    if (role === "admin" && data && typeof data === "object"
      && "attemptKey" in data && typeof data.attemptKey === "string"
      && /^[0-9a-f-]{36}$/i.test(data.attemptKey)) {
      const response = await fetch(`${endpoint}/period-proof`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-role": "admin" },
        body: JSON.stringify({ attemptKey: data.attemptKey }),
      });
      assert.equal(response.status, 200, "Server must issue a proof before export");
      proof = (await response.json() as { periodProof: string }).periodProof;
    }
    return request(role, {
      method: "POST",
      body: JSON.stringify(data && typeof data === "object"
        ? { periodProof: proof, ...data } : data),
    });
  };

  try {
    // Isolate this test's current UTC day, then restore it in finally.
    await db.delete(readinessAuditExportAggregatesTable)
      .where(inArray(readinessAuditExportAggregatesTable.day, [today, ...fixtureDays]));
    await db.delete(readinessAuditExportAttemptsTable)
      .where(inArray(readinessAuditExportAttemptsTable.day, [today, ...fixtureDays]));
    await db.delete(readinessAuditExportRetentionCyclesTable)
      .where(inArray(readinessAuditExportRetentionCyclesTable.day, [today, nextRetentionCycleDay, laterRetentionCycleDay]));
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
      { attemptKey: reusableExpiredAttemptKey, day: expiredRetentionDay },
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
        expiredAttemptKey, reusableExpiredAttemptKey, boundaryAttemptKey, afterBoundaryAttemptKey, activeRetryAttemptKey,
      ])).orderBy(asc(readinessAuditExportAttemptsTable.attemptKey));
    // Two prior UTC cycles put the next real scheduler failure at the alarm threshold.
    for (const daysAgo of [2, 1]) {
      const priorCycle = new Date(retentionNow);
      priorCycle.setUTCDate(priorCycle.getUTCDate() - daysAgo);
      await recordReadinessExportTrendRetentionFailure(priorCycle);
    }
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
      assert.deepEqual(await getReadinessExportTrendRetentionStatus(), healthBeforeFailure,
        "A failed transaction must not record a partial success");
      assert.equal(await runReadinessExportTrendRetentionCleanup(retentionNow), null,
        "The scheduler must catch the database deletion failure");
      const firstFailure = await getReadinessExportTrendRetentionStatus();
      assert.equal(firstFailure.consecutiveFailures, 3,
        "The first scheduler failure must count this UTC cycle once");
      assert.equal(firstFailure.alertActive, true, "The shared alarm must activate");
      assert.equal(firstFailure.lastFailureAt, retentionNow.toISOString());
      assert.equal(await runReadinessExportTrendRetentionCleanup(retentionNow), null,
        "A second same-day scheduler failure must still be caught");
      assert.deepEqual(await getReadinessExportTrendRetentionStatus(), firstFailure,
        "Repeated failures in the same UTC cycle must not increment or clear the shared alarm");
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
          expiredAttemptKey, reusableExpiredAttemptKey, boundaryAttemptKey, afterBoundaryAttemptKey, activeRetryAttemptKey,
        ])).orderBy(asc(readinessAuditExportAttemptsTable.attemptKey)),
      fixtureAttemptsBeforeFailure,
      "A failed deletion must leave retry keys unchanged",
    );
    const retriedCleanup = await runReadinessExportTrendRetentionCleanup(retentionNow);
    assert(retriedCleanup?.executed, "The same-day scheduler retry must run the real cleanup");
    assert.equal(retriedCleanup.recovered, true, "The successful cleanup must report alarm recovery");
    const sharedRecoveryAfterRetry = await getReadinessExportTrendRetentionStatus();
    assert.equal(sharedRecoveryAfterRetry.consecutiveFailures, 0, "Successful cleanup must reset the shared failure count");
    assert.equal(sharedRecoveryAfterRetry.alertActive, false, "Successful cleanup must clear the shared alarm");
    assert.equal(sharedRecoveryAfterRetry.lastSuccessAt, retentionNow.toISOString());
    assert.equal(sharedRecoveryAfterRetry.lastFailureAt, retentionNow.toISOString(),
      "Recovery must retain the last failure timestamp");
    const adminRecovery = await request("admin");
    assert.equal(adminRecovery.status, 200);
    assert.deepEqual((await adminRecovery.json() as { retentionCleanup: typeof sharedRecoveryAfterRetry }).retentionCleanup,
      sharedRecoveryAfterRetry, "Another reader must see the cleared shared alarm");
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
        reusableExpiredAttemptKey,
        boundaryAttemptKey,
        afterBoundaryAttemptKey,
        activeRetryAttemptKey,
      ]));
    assert(!retainedAttemptKeys.some(row => row.attemptKey === expiredAttemptKey),
      "Retry keys before the retention boundary must be deleted");
    assert(!retainedAttemptKeys.some(row => row.attemptKey === reusableExpiredAttemptKey),
      "The expired UUID must be deleted before it can be reused");
    assert(retainedAttemptKeys.some(row => row.attemptKey === boundaryAttemptKey),
      "A retry key exactly on the retention boundary must remain");
    assert(retainedAttemptKeys.some(row => row.attemptKey === afterBoundaryAttemptKey),
      "A retry key after the retention boundary must remain");
    assert(retainedAttemptKeys.some(row => row.attemptKey === activeRetryAttemptKey),
      "Retry protection for the active reporting period must remain");
    // Keep the first transaction open after its cycle claim, then prove the second
    // is waiting for that uncommitted claim rather than starting after rollback.
    await db.insert(readinessAuditExportAggregatesTable).values({
      day: expiredRetentionDay, recordGroup: racingAggregateGroup, outcome: "failed", count: 1,
    });
    await db.insert(readinessAuditExportAttemptsTable).values({
      attemptKey: racingAttemptKey, day: expiredRetentionDay,
    });
    await db.execute(sql`CREATE SEQUENCE ${racingFailureSequence}`);
    await db.execute(sql`
      CREATE FUNCTION ${rejectRacingAttemptDelete}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('${sql.raw(`racing_failure_${suffix.replaceAll("-", "")}`)}') = 1 THEN
          PERFORM pg_advisory_xact_lock(${sql.raw(String(racingLockNamespace))}, ${sql.raw(String(seed))});
          RAISE EXCEPTION 'forced racing retention deletion failure';
        END IF;
        RETURN OLD;
      END
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER ${rejectRacingAttemptDelete}
      BEFORE DELETE ON teras_readiness_audit_export_attempts
      FOR EACH ROW WHEN (OLD.attempt_key LIKE 'retention-race-%')
      EXECUTE FUNCTION ${rejectRacingAttemptDelete}()
    `);
    let releaseRacingLock!: () => void;
    let racingLockHeld!: () => void;
    const releaseLock = new Promise<void>(resolve => { releaseRacingLock = resolve; });
    const lockHeld = new Promise<void>(resolve => { racingLockHeld = resolve; });
    let holderPid: number | undefined;
    const holder = db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${racingLockNamespace}, ${seed})`);
      const result = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
      holderPid = result.rows[0]?.pid;
      racingLockHeld();
      await releaseLock;
    });
    let firstCleanup: Promise<void> | undefined;
    let secondCleanup: ReturnType<typeof pruneReadinessExportTrendAggregates> | undefined;
    try {
      await lockHeld;
      assert(holderPid, "The held advisory lock must identify its database session");
      firstCleanup = assert.rejects(
        pruneReadinessExportTrendAggregates(nextRetentionCycle),
        (error: unknown) => error instanceof Error
          && (error as Error & { cause?: Error }).cause?.message === "forced racing retention deletion failure",
        "The first cleanup must fail after claiming the UTC cycle",
      );
      const waitForBlockedQuery = async (stage: string, blockerPid: number) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const result = await db.execute<{ pid: number }>(sql`
            SELECT pid::int AS pid FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND ${blockerPid} = ANY(pg_blocking_pids(pid))
            LIMIT 1
          `);
          if (result.rows[0]) return result.rows[0].pid;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail(`Cleanup did not wait for the expected ${stage} lock`);
      };
      const firstPid = await waitForBlockedQuery("first cleanup after cycle claim", holderPid);
      secondCleanup = pruneReadinessExportTrendAggregates(nextRetentionCycle);
      await waitForBlockedQuery("second cleanup on first cycle claim", firstPid);
      releaseRacingLock();
      await holder;
      await firstCleanup;
      const winner = await secondCleanup;
      assert.equal(winner.executed, true, "The waiting cleanup must run after the first claim rolls back");
      assert.equal(winner.deletedRows, 2,
        "The waiting cleanup must remove the rolled-back aggregate and newly expired boundary row once");
      assert.equal(winner.deletedAttemptKeys, 2,
        "The waiting cleanup must remove the rolled-back retry key and newly expired boundary key once");
      assert.deepEqual(await db.select().from(readinessAuditExportAggregatesTable)
        .where(inArray(readinessAuditExportAggregatesTable.day, [expiredRetentionDay, retentionCutoffDay])), []);
      assert.deepEqual(await db.select().from(readinessAuditExportAttemptsTable)
        .where(inArray(readinessAuditExportAttemptsTable.attemptKey, [racingAttemptKey, boundaryAttemptKey])), []);
      assert.equal((await db.select().from(readinessAuditExportAttemptsTable)
        .where(eq(readinessAuditExportAttemptsTable.attemptKey, afterBoundaryAttemptKey))).length, 1,
      "The retry key on the new retention boundary must remain");
      assert.equal((await db.select().from(readinessAuditExportRetentionCyclesTable)
        .where(eq(readinessAuditExportRetentionCyclesTable.day, nextRetentionCycleDay))).length, 1,
      "Only the successful cleanup must commit the cycle claim");
      assert.equal((await getReadinessExportTrendRetentionStatus()).lastSuccessAt,
        nextRetentionCycle.toISOString(), "Only the winning cleanup must record success");
      assert.equal((await pruneReadinessExportTrendAggregates(nextRetentionCycle)).executed, false,
        "The successful claim must prevent a second cleanup in the same UTC cycle");
    } finally {
      releaseRacingLock();
      await Promise.allSettled([holder, firstCleanup, secondCleanup].filter(promise => promise !== undefined));
      await db.execute(sql`DROP TRIGGER IF EXISTS ${rejectRacingAttemptDelete} ON teras_readiness_audit_export_attempts`);
      await db.execute(sql`DROP FUNCTION IF EXISTS ${rejectRacingAttemptDelete}()`);
      await db.execute(sql`DROP SEQUENCE IF EXISTS ${racingFailureSequence}`);
    }
    const concurrentCleanup = await Promise.all([
      pruneReadinessExportTrendAggregates(laterRetentionCycle),
      pruneReadinessExportTrendAggregates(laterRetentionCycle),
    ]);
    assert.equal(concurrentCleanup.filter(result => result.executed).length, 1,
      "A new UTC cycle must execute exactly one concurrent cleanup");
    assert.equal(concurrentCleanup.filter(result => !result.executed).length, 1,
      "The other concurrent cleanup must skip without error");
    assert.equal((await pruneReadinessExportTrendAggregates(laterRetentionCycle)).executed, false,
      "A later invocation in the claimed next UTC cycle must skip");

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
    assert((await fetch(`${endpoint}/period-proof`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-role": "learner" },
      body: JSON.stringify({ attemptKey: crypto.randomUUID() }),
    })).status === 403, "Non-admins cannot issue proofs");
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
    const proofKey = crypto.randomUUID();
    assert.equal((await post("admin", {
      attemptKey: proofKey, outcome: "failed", recordCount: 1_000,
      periodProof: issueReadinessExportPeriodProof(crypto.randomUUID()),
    })).status, 400, "A proof for another attempt must be rejected");
    assert.equal((await request("admin", {
      method: "POST",
      body: JSON.stringify({ attemptKey: proofKey, outcome: "failed", recordCount: 1_000 }),
    })).status, 400, "An outcome without a server-issued proof must not be assigned to the retry day");

    assert((await post("admin", { outcome: "failed", recordCount: 999 })).status === 204, "Small samples must be accepted and ignored");
    assert((await post("admin", { outcome: "started", recordCount: 1_000 })).status === 204, "Started outcomes must be accepted and ignored");
    assert((await post("admin", {
      attemptKey: activeRetryAttemptKey,
      outcome: "succeeded",
      recordCount: 10_000,
    })).status === 204, "A retry protected by an active key must succeed without recounting");
    assert((await db.select().from(readinessAuditExportAggregatesTable).where(eq(readinessAuditExportAggregatesTable.day, today))).length === 0, "Ignored inputs must not create aggregate rows");

    const reusedOutcome = {
      attemptKey: reusableExpiredAttemptKey,
      outcome: "failed",
      recordCount: 1_000,
    };
    assert.equal((await post("admin", reusedOutcome)).status, 204,
      "A new outcome may use a UUID after its expired retry key is cleaned up");
    const reusedAttempt = await db.select().from(readinessAuditExportAttemptsTable)
      .where(eq(readinessAuditExportAttemptsTable.attemptKey, reusableExpiredAttemptKey));
    assert.equal(reusedAttempt.length, 1, "Reuse must create a new retry key");
    assert.equal(reusedAttempt[0]!.day, today, "The reused key must protect the new UTC day");
    const reusedAggregateCount = async () => {
      const rows = await db.select().from(readinessAuditExportAggregatesTable)
        .where(eq(readinessAuditExportAggregatesTable.day, today));
      return rows.find(row => row.recordGroup === "1.000–4.999 record" && row.outcome === "failed")?.count;
    };
    assert.equal(await reusedAggregateCount(), 1, "A new outcome with the expired UUID must count once");
    assert.equal((await post("admin", reusedOutcome)).status, 204, "A retry with the reused UUID must succeed");
    assert.equal(await reusedAggregateCount(), 1, "The retry must not recount the new outcome");

    const delayedKey = crypto.randomUUID();
    const delayedOutcome = {
      attemptKey: delayedKey, outcome: "failed", recordCount: 5_000,
      periodProof: issueReadinessExportPeriodProof(delayedKey, delayedPeriodDay),
    };
    assert.equal((await post("admin", delayedOutcome)).status, 204, "Delayed authenticated retry must be accepted");
    assert.equal((await post("admin", delayedOutcome)).status, 204, "Repeated delayed retry must remain idempotent");
    const delayedRows = await db.select().from(readinessAuditExportAggregatesTable)
      .where(eq(readinessAuditExportAggregatesTable.day, delayedDay));
    assert.equal(delayedRows.find(row => row.recordGroup === "5.000–9.999 record" && row.outcome === "failed")?.count, 1,
      "Retry after the seven-day period rolls over must count once on its original server day");
    assert.equal(await reusedAggregateCount(), 1, "Delayed outcome must not inflate today's aggregate");
    const expiredKey = crypto.randomUUID();
    assert.equal((await post("admin", {
      attemptKey: expiredKey, outcome: "failed", recordCount: 5_000,
      periodProof: issueReadinessExportPeriodProof(expiredKey, new Date(`${expiredRetentionDay}T12:00:00.000Z`)),
    })).status, 204, "Authentic outcomes beyond retention are acknowledged without reassigning their day");
    assert.deepEqual(await db.select().from(readinessAuditExportAttemptsTable)
      .where(eq(readinessAuditExportAttemptsTable.attemptKey, expiredKey)), []);

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
    assert(aggregate("1.000–4.999 record", "failed")?.count === 1,
      "The reused expired UUID must contribute exactly one outcome to the active trend");
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
    await db.execute(sql`DROP TRIGGER IF EXISTS ${rejectExpiredAttemptDelete} ON teras_readiness_audit_export_attempts`);
    await db.execute(sql`DROP FUNCTION IF EXISTS ${rejectExpiredAttemptDelete}()`);
    await db.execute(sql`DROP TRIGGER IF EXISTS ${rejectRacingAttemptDelete} ON teras_readiness_audit_export_attempts`);
    await db.execute(sql`DROP FUNCTION IF EXISTS ${rejectRacingAttemptDelete}()`);
    await db.execute(sql`DROP SEQUENCE IF EXISTS ${racingFailureSequence}`);
    await db.delete(readinessAuditExportAttemptsTable)
      .where(eq(readinessAuditExportAttemptsTable.attemptKey, racingAttemptKey));
    await db.delete(readinessAuditExportAggregatesTable)
      .where(inArray(readinessAuditExportAggregatesTable.day, [today, ...fixtureDays]));
    await db.delete(readinessAuditExportAttemptsTable)
      .where(inArray(readinessAuditExportAttemptsTable.day, [today, ...fixtureDays]));
    await db.delete(readinessAuditExportRetentionCyclesTable)
      .where(inArray(readinessAuditExportRetentionCyclesTable.day, [today, nextRetentionCycleDay, laterRetentionCycleDay]));
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