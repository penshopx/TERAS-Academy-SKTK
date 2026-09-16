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
import { eq, inArray } from "drizzle-orm";
import { createIntegrationTestApp } from "./integration-test-app";

type Identity = "path-a" | "path-b";
type Passport = {
  learner: { id: string };
  pathway: unknown;
  readinessDisclaimer: string;
  readiness: unknown;
  timeline: Array<{ causalReferences: Record<string, string[]> }>;
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
    { id: enrollmentB, learnerId: learnerB, programId: "solar-pv-tech", pathwayId: "path-b", trainerId: null, assessorId: null, createdBy: learnerB },
  ]);
  await db.insert(evidenceTable).values([
    { id: evidenceA, learnerId: learnerA, pathwayId: "path-a", moduleId: "m03", taskId: "task-m03", title: "Path A private evidence", type: "Report", description: "Path A export fixture", fileName: null, createdBy: learnerA },
    { id: evidenceB, learnerId: learnerB, pathwayId: "path-b", moduleId: "m01", taskId: "task-m01", title: "Path B private evidence", type: "Report", description: "Path B export fixture", fileName: null, createdBy: learnerB },
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

async function run() {
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