import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  db,
  enrollmentsTable,
  evidenceReviewsTable,
  evidenceTable,
  peopleTable,
  readinessEventsTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { createIntegrationTestApp } from "./integration-test-app";
import { collectTimelineSnapshotPages } from "./lib/learner-portfolio-export";
import { groupTimelineRows, indexTimelineLearningLinks, timelineRowsById, unionTimelineGroups } from "./lib/timeline-relations";
import { decodeTimelineCursor, timelinePage } from "./routes/learner";

type Identity = "path-a" | "path-b";
type Passport = {
  learner: { id: string };
  pathway: unknown;
  readinessDisclaimer: string;
  readiness: unknown;
  timeline: Array<{ id: string; date: string; causalReferences: Record<string, string[]> }>;
};
type ExportPayload = { portfolio: Passport };

const suffix = crypto.randomUUID();
const learnerA = `passport-path-a-${suffix}`;
const learnerB = `passport-path-b-${suffix}`;
const enrollmentA = `passport-enrollment-a-${suffix}`;
const enrollmentB = `passport-enrollment-b-${suffix}`;
const evidenceA = `passport-evidence-a-${suffix}`;
const evidenceB = `passport-evidence-b-${suffix}`;
const longHistoryEvidence = Array.from({ length: 55 }, (_, index) => `passport-history-${String(index).padStart(2, "0")}-${suffix}`);
const longHistoryReviews = longHistoryEvidence.map((_, index) => `passport-history-review-${String(index).padStart(2, "0")}-${suffix}`);

async function cleanup() {
  await db.delete(readinessEventsTable).where(inArray(readinessEventsTable.enrollmentId, [enrollmentA, enrollmentB]));
  await db.delete(evidenceReviewsTable).where(inArray(evidenceReviewsTable.evidenceId, [evidenceA, evidenceB, ...longHistoryEvidence]));
  await db.delete(evidenceTable).where(inArray(evidenceTable.id, [evidenceA, evidenceB, ...longHistoryEvidence]));
  await db.delete(enrollmentsTable).where(inArray(enrollmentsTable.id, [enrollmentA, enrollmentB]));
  await db.delete(peopleTable).where(inArray(peopleTable.id, [learnerA, learnerB]));
}

async function seed() {
  await cleanup();
  await db.insert(peopleTable).values([
    { id: learnerA, name: "Passport Path A", initials: "PA", email: `${learnerA}@example.test`, role: "learner", organization: null, createdBy: learnerA },
    { id: learnerB, name: "Passport Path B", initials: "PB", email: `${learnerB}@example.test`, role: "learner", organization: null, createdBy: learnerB },
  ]);
  await db.insert(enrollmentsTable).values([
    { id: enrollmentA, learnerId: learnerA, programId: "solar-pv-tech", pathwayId: "path-a", trainerId: null, assessorId: null, createdBy: learnerA },
    { id: enrollmentB, learnerId: learnerB, programId: "solar-pv-tech", pathwayId: "path-a", trainerId: null, assessorId: null, createdBy: learnerB },
  ]);
  await db.insert(evidenceTable).values([
    { id: evidenceA, learnerId: learnerA, pathwayId: "path-a", moduleId: "m03", taskId: "task-m03", title: "Path A private evidence", type: "Report", description: "Path A export fixture", fileName: null, createdBy: learnerA },
    { id: evidenceB, learnerId: learnerB, pathwayId: "path-a", moduleId: "m01", taskId: "task-m01", title: "Second learner private evidence", type: "Report", description: "Same-pathway isolation fixture", fileName: null, createdBy: learnerB },
  ]);
  await db.insert(evidenceReviewsTable).values([
    { id: `passport-review-a-${suffix}`, evidenceId: evidenceA, status: "Under review", quality: { valid: false, relevant: true, sufficient: false, traceable: true }, createdBy: learnerA },
    { id: `passport-review-b-${suffix}`, evidenceId: evidenceB, status: "Under review", quality: { valid: false, relevant: true, sufficient: false, traceable: true }, createdBy: learnerB },
  ]);
  await db.insert(evidenceTable).values(longHistoryEvidence.map((id, index) => ({
    id,
    learnerId: learnerA,
    pathwayId: "path-a",
    moduleId: "m03",
    taskId: "task-m03",
    title: `Long Passport history ${index}`,
    type: "Report",
    description: `Multi-page export fixture ${index}`,
    fileName: null,
    createdBy: learnerA,
  })));
  await db.insert(evidenceReviewsTable).values(longHistoryEvidence.map((evidenceId, index) => ({
    id: longHistoryReviews[index]!,
    evidenceId,
    status: "Under review",
    quality: { valid: false, relevant: true, sufficient: false, traceable: true },
    createdBy: learnerA,
  })));
}

function parityProjection(passport: Passport) {
  return {
    timeline: passport.timeline,
    causalEvidenceReferences: passport.timeline.map(step => step.causalReferences),
    readiness: passport.readiness,
    pathway: passport.pathway,
    disclaimer: passport.readinessDisclaimer,
  };
}

function verifyLinearRelationIndexing() {
  const build = (size: number) => {
    let sourceReads = 0;
    const raw = Array.from({ length: size }, (_, index) => ({
      id: `link-${index}`,
      evidenceId: `evidence-${index % 5}`,
      evidenceReviewId: index % 3 === 0 ? `review-${index % 7}` : null,
      practiceAttemptId: `practice-${index % 11}`,
      remediationPlanId: `plan-${index % 13}`,
      metadata: { transitionEventId: `transition-${index % 17}` },
    }));
    const links = new Proxy(raw, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) sourceReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const { byEvidence: evidenceGroups, byReview: reviewGroups, byTransition, byPractice, byPlan } = indexTimelineLearningLinks(links);
    assert.equal(byTransition.get("transition-0")?.length, Math.ceil(size / 17));
    assert.equal(byPractice.get("practice-0")?.length, Math.ceil(size / 11));
    assert.equal(byPlan.get("plan-0")?.length, Math.ceil(size / 13));
    const byId = timelineRowsById(links, link => link.id);
    const grouped = groupTimelineRows(links, link => link.evidenceId);
    assert.equal(byId.get("link-0"), raw[0]);
    assert.deepEqual(grouped.get("evidence-0")?.map(link => link.id), raw.filter(link => link.evidenceId === "evidence-0").map(link => link.id));
    for (let index = 0; index < 7; index++) {
      const reviewId = `review-${index}`;
      const evidenceId = `evidence-${index % 5}`;
      const actual = unionTimelineGroups(reviewGroups.get(reviewId) ?? [], evidenceGroups.get(evidenceId) ?? []);
      const expected = raw.filter(link => link.evidenceReviewId === reviewId || link.evidenceId === evidenceId);
      assert.deepEqual(actual, expected, "overlapping causal links must occur once, in original query order");
    }
    return sourceReads;
  };
  const small = build(1_000);
  const large = build(2_000);
  assert.equal(large, 2 * small, "doubling timeline history must double source-row indexing work, not square it");
  assert(large <= 14_000, "each of the seven relation indexes must visit the source at most once");
}

async function run() {
  verifyLinearRelationIndexing();
  const syntheticTimeline = Array.from({ length: 205 }, (_, index) => ({
    id: `synthetic-${String(index).padStart(3, "0")}`,
    date: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 4))),
    causalReferences: { evidenceIds: [`synthetic-evidence-${index}`] },
  })).sort((left, right) => left.date.getTime() - right.date.getTime() || left.id.localeCompare(right.id));
  let snapshotLoads = 0;
  const syntheticCollection = await collectTimelineSnapshotPages(
    async () => {
      snapshotLoads += 1;
      return syntheticTimeline;
    },
    (snapshot, cursorValue) => {
      const cursor = cursorValue ? decodeTimelineCursor(cursorValue) : undefined;
      assert(!cursorValue || cursor, "synthetic pagination must produce valid date+ID cursors");
      const page = timelinePage(snapshot, 17, cursor ?? undefined);
      return { items: page.items, nextCursor: page.nextCursor };
    },
  );
  assert.equal(snapshotLoads, 1, "multi-page full-history traversal must build its timeline snapshot exactly once");
  assert.deepEqual(syntheticCollection.items, syntheticTimeline, "snapshot pagination must preserve date+ID order and causal references");

  await seed();
  const app = createIntegrationTestApp(req => {
    const identity = req.get("x-passport-identity") as Identity;
    return {
      userId: `clerk-${identity}`,
      learnerId: identity === "path-b" ? learnerB : learnerA,
      role: "learner",
    };
  });
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = async <T>(path: string, identity: Identity): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { "x-passport-identity": identity } });
    if (response.status !== 200) {
      throw new Error(`${path} should succeed for ${identity}: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  };

  try {
    for (const identity of ["path-a", "path-b"] as const) {
      const eventsBefore = await db.select().from(readinessEventsTable)
        .where(eq(readinessEventsTable.enrollmentId, identity === "path-a" ? enrollmentA : enrollmentB));
      const [passport, fullPassport, exported] = await Promise.all([
        request<Passport>("/passport", identity),
        request<Passport>("/passport?history=full", identity),
        request<ExportPayload>("/passport/export", identity),
      ]);
      const eventsAfterParallelRequests = await db.select().from(readinessEventsTable)
        .where(eq(readinessEventsTable.enrollmentId, identity === "path-a" ? enrollmentA : enrollmentB));
      assert.equal(
        eventsAfterParallelRequests.length,
        eventsBefore.length + 1,
        `${identity} parallel Passport requests with identical inputs must append one readiness event`,
      );
      assert.deepEqual(exported.portfolio, fullPassport, `${identity} exported portfolio must equal the full-history Passport response`);
      for (let index = 1; index < fullPassport.timeline.length; index++) {
        const previous = fullPassport.timeline[index - 1]!;
        const current = fullPassport.timeline[index]!;
        assert(
          previous.date < current.date || (previous.date === current.date && previous.id < current.id),
          "timeline must remain ordered by date then ID",
        );
      }
      const submittedEvidenceId = identity === "path-a" ? evidenceA : evidenceB;
      const evidenceStep = fullPassport.timeline.find(step => step.id === `evidence-${submittedEvidenceId}`);
      assert.deepEqual(evidenceStep?.causalReferences, {
        evidenceIds: [submittedEvidenceId],
        diagnosticProfileIds: [],
        diagnosticGapIds: [],
        diagnosticRecommendationIds: [],
      }, "evidence causal reference shape must remain unchanged");
      assert.deepEqual(
        parityProjection(exported.portfolio),
        parityProjection(fullPassport),
        `${identity} export portfolio must match the full-history Passport contract`,
      );
      assert(
        passport.timeline.some(step => Object.values(step.causalReferences).flat().includes(identity === "path-a" ? evidenceA : evidenceB)),
        `${identity} fixture must exercise causal evidence references`,
      );
      if (identity === "path-a") {
        assert.equal(passport.timeline.length, 50, "the default Passport page must retain its 50-event boundary");
        assert(fullPassport.timeline.length > 50, "the full-history Passport must include multiple timeline pages");
        assert.equal(new Set(fullPassport.timeline.map(step => JSON.stringify(step))).size, fullPassport.timeline.length, "full-history pagination must not duplicate timeline events");
        for (const evidenceId of longHistoryEvidence) {
          assert(
            fullPassport.timeline.some(step => Object.values(step.causalReferences).flat().includes(evidenceId)),
            `full-history export must retain causal reference ${evidenceId}`,
          );
        }
      }
    }

    const pathAEventsBeforeChange = await db.select().from(readinessEventsTable)
      .where(eq(readinessEventsTable.enrollmentId, enrollmentA));
    await db.update(evidenceReviewsTable)
      .set({ status: "Valid", quality: { valid: true, relevant: true, sufficient: true, traceable: true } })
      .where(eq(evidenceReviewsTable.evidenceId, evidenceA));
    await request<Passport>("/passport", "path-a");
    const pathAEventsAfterChange = await db.select().from(readinessEventsTable)
      .where(eq(readinessEventsTable.enrollmentId, enrollmentA));
    assert.equal(
      pathAEventsAfterChange.length,
      pathAEventsBeforeChange.length + 1,
      "changed readiness input must append a new immutable readiness event",
    );

    let releasePathALock!: () => void;
    let confirmPathALock!: () => void;
    const pathALockReleased = new Promise<void>(resolve => {
      releasePathALock = resolve;
    });
    const pathALockAcquired = new Promise<void>(resolve => {
      confirmPathALock = resolve;
    });
    let pathALockHolderPid: number | undefined;
    const heldPathALock = db.transaction(async tx => {
      const lockKey = `readiness-snapshot:${enrollmentA}:path-a`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const holder = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
      pathALockHolderPid = holder.rows[0]?.pid;
      confirmPathALock();
      await pathALockReleased;
    });
    await pathALockAcquired;
    assert(pathALockHolderPid, "the held readiness lock must expose its PostgreSQL backend");

    let pathASettled = false;
    const blockedPathARequest = request<Passport>("/passport", "path-a").finally(() => {
      pathASettled = true;
    });
    try {
      const waiterDeadline = Date.now() + 2_000;
      let matchingWaiter = false;
      while (!matchingWaiter && Date.now() < waiterDeadline) {
        const result = await db.execute<{ waiting: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1
            FROM pg_locks waiter
            JOIN pg_locks holder
              ON holder.locktype = waiter.locktype
              AND holder.database IS NOT DISTINCT FROM waiter.database
              AND holder.classid IS NOT DISTINCT FROM waiter.classid
              AND holder.objid IS NOT DISTINCT FROM waiter.objid
              AND holder.objsubid IS NOT DISTINCT FROM waiter.objsubid
            WHERE waiter.locktype = 'advisory'
              AND waiter.granted = false
              AND holder.granted = true
              AND holder.pid = ${pathALockHolderPid}
              AND waiter.pid <> holder.pid
          ) AS waiting
        `);
        matchingWaiter = result.rows[0]?.waiting === true;
        if (!matchingWaiter) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(matchingWaiter, "the path-a Passport request must be waiting on the exact held readiness lock");

      const independentPathBRequest = request<Passport>("/passport", "path-b");
      const independentPathB = await Promise.race([
        independentPathBRequest,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("path-b Passport request was blocked by path-a readiness lock")),
          2_000,
        )),
      ]);
      assert.equal(independentPathB.learner.id, learnerB, "the unlocked learner Passport request must complete normally");
      assert.equal(pathASettled, false, "the matching learner Passport request must remain blocked while its readiness lock is held");
    } finally {
      releasePathALock();
      await heldPathALock;
    }
    const unblockedPathA = await blockedPathARequest;
    assert.equal(unblockedPathA.learner.id, learnerA, "the matching learner Passport request must resume after its readiness lock is released");

    const eventsAfterLockIsolation = await db.select().from(readinessEventsTable)
      .where(inArray(readinessEventsTable.enrollmentId, [enrollmentA, enrollmentB]));
    assert.equal(
      eventsAfterLockIsolation.length,
      pathAEventsAfterChange.length + 1,
      "unchanged Passport requests for both enrollment/pathway pairs must remain deduplicated",
    );

    const maliciousExport = await request<ExportPayload>(`/passport/export?learnerId=${encodeURIComponent(learnerB)}`, "path-a");
    assert.equal(maliciousExport.portfolio.learner.id, learnerA, "an authenticated learner must not export another learner's portfolio");
    assert(
      maliciousExport.portfolio.timeline.every(step => !Object.values(step.causalReferences).flat().includes(evidenceB)),
      "another learner's causal evidence must not leak through export query parameters",
    );
    process.stdout.write("Passport export parity integration check passed\n");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await cleanup();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
});