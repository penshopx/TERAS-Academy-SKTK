import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  db,
  enrollmentsTable,
  learningActivitiesTable,
  learningRecordLinksTable,
  peopleTable,
  personRolesTable,
  pool,
  practiceAttemptsTable,
  practiceReviewsTable,
  practiceTasksTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createIntegrationTestApp } from "./integration-test-app";
import { assertBoundedIndexPlan, explainQuery } from "./lib/explain-plan";
import { latestPracticeReviewQuery } from "./lib/trainer-bottlenecks";

type QueueItem = {
  id: string;
  kind: "Evidence" | "Practice";
  status: string;
  updatedAt: string;
};
type Dashboard = {
  recentActivity: QueueItem[];
  reviewHistory: Array<{ id: string; kind: "Evidence" | "Practice" }>;
};

const suffix = crypto.randomUUID();
const trainerId = `trainer-queue-trainer-${suffix}`;
const learnerId = `trainer-queue-learner-${suffix}`;
const enrollmentId = `trainer-queue-enrollment-${suffix}`;
const attemptId = `trainer-queue-attempt-${suffix}`;
const unrelatedLearnerId = `trainer-queue-unrelated-${suffix}`;
const unrelatedAttemptPrefix = `trainer-queue-unrelated-attempt-${suffix}`;
const reviewTimestamp = new Date("2026-09-16T08:30:00.000Z");
const LARGE_HISTORY_SIZE = 500;

async function assertLatestReviewLookupIsBounded() {
  await pool.query("ANALYZE teras_practice_reviews");
  await pool.query("SET enable_seqscan = off");
  const indexResult = await pool.query<{ indexname: string }>(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'teras_practice_reviews'
      AND indexdef LIKE '%(attempt_id, created_at DESC, id DESC)%'
  `);
  const latestReviewIndex = indexResult.rows[0]?.indexname;
  assert(latestReviewIndex, "Expected an attempt_id, created_at DESC, id DESC review index");
  const nodes = await explainQuery(pool, latestPracticeReviewQuery, [[attemptId]]);
  assertBoundedIndexPlan(nodes, { indexName: latestReviewIndex, maximumRowsRead: 1 });
}

async function requestQueue(baseUrl: string) {
  const response = await fetch(`${baseUrl}/trainer/review-queue`);
  if (response.status !== 200) {
    throw new Error(`GET /trainer/review-queue: expected 200, got ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<QueueItem[]>;
}

async function requestDashboard(baseUrl: string) {
  const response = await fetch(`${baseUrl}/trainer/dashboard`);
  if (response.status !== 200) {
    throw new Error(`GET /trainer/dashboard: expected 200, got ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<Dashboard>;
}

async function requestPracticeReview(
  baseUrl: string,
  body: { idempotencyKey: string; status: "Needs revision" | "Reviewed"; feedback: string },
) {
  const response = await fetch(`${baseUrl}/trainer/practice/${attemptId}/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(`POST /trainer/practice/${attemptId}/review: expected 200, got ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<{ id: string; status: string; feedback: string }>;
}

function practiceItem(queue: QueueItem[]) {
  return queue.find((item) => item.kind === "Practice" && item.id === attemptId);
}

async function run() {
  const [task] = await db.select().from(practiceTasksTable)
    .where(eq(practiceTasksTable.moduleId, "m03"))
    .limit(1);
  assert(task, "Seeded Path A practice task is required");
  const [activity] = await db.select().from(learningActivitiesTable)
    .where(eq(learningActivitiesTable.pathwayId, "path-a"))
    .limit(1);
  assert(activity, "Seeded Path A learning activity is required");

  await db.insert(peopleTable).values([
    {
      id: trainerId,
      name: "Queue Contract Trainer",
      initials: "QT",
      email: `${trainerId}@example.test`,
      role: "trainer",
      clerkUserId: `clerk-${trainerId}`,
      createdBy: "trainer-queue-integration",
    },
    {
      id: learnerId,
      name: "Queue Contract Learner",
      initials: "QL",
      email: `${learnerId}@example.test`,
      role: "learner",
      createdBy: "trainer-queue-integration",
    },
    {
      id: unrelatedLearnerId,
      name: "Unassigned Queue Learner",
      initials: "UQ",
      email: `${unrelatedLearnerId}@example.test`,
      role: "learner",
      createdBy: "trainer-queue-integration",
    },
  ]);
  await db.insert(personRolesTable).values({
    personId: trainerId,
    role: "trainer",
    createdBy: "trainer-queue-integration",
  });
  await db.insert(enrollmentsTable).values({
    id: enrollmentId,
    learnerId,
    programId: "solar-pv-tech",
    pathwayId: "path-a",
    trainerId,
    createdBy: "trainer-queue-integration",
  });
  const submittedAt = new Date("2026-09-16T08:00:00.000Z");
  await db.insert(practiceAttemptsTable).values({
    id: attemptId,
    taskId: task.id,
    learnerId,
    pathwayId: "path-a",
    reflection: "Trainer queue integration fixture",
    outputSummary: "Submitted practice output",
    status: "Submitted",
    createdAt: submittedAt,
    createdBy: learnerId,
  });
  await db.insert(learningRecordLinksTable).values({
    id: `trainer-queue-link-${suffix}`,
    learnerId,
    pathwayId: "path-a",
    activityId: activity.id,
    practiceAttemptId: attemptId,
    relation: "practice-attempt",
    createdBy: learnerId,
  });
  await db.insert(practiceAttemptsTable).values(Array.from({ length: LARGE_HISTORY_SIZE }, (_, index) => ({
    id: `${unrelatedAttemptPrefix}-${index.toString().padStart(4, "0")}`,
    taskId: task.id,
    learnerId: unrelatedLearnerId,
    pathwayId: "path-a",
    reflection: "Unassigned history fixture",
    outputSummary: `Unassigned output ${index}`,
    status: "Submitted" as const,
    createdAt: new Date(reviewTimestamp.getTime() - LARGE_HISTORY_SIZE + index),
    createdBy: unrelatedLearnerId,
  })));
  await db.insert(practiceReviewsTable).values(Array.from({ length: LARGE_HISTORY_SIZE }, (_, index) => ({
    id: `trainer-queue-unrelated-review-${suffix}-${index.toString().padStart(4, "0")}`,
    attemptId: `${unrelatedAttemptPrefix}-${index.toString().padStart(4, "0")}`,
    reviewerId: trainerId,
    status: index % 2 ? "Needs revision" as const : "Reviewed" as const,
    feedback: "Unrelated append-only review history",
    createdAt: new Date(reviewTimestamp.getTime() - LARGE_HISTORY_SIZE + index),
    createdBy: trainerId,
  })));
  const app = createIntegrationTestApp(() => ({
    userId: `clerk-${trainerId}`,
    role: "trainer",
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  try {
    let item = practiceItem(await requestQueue(baseUrl));
    assert(item, "Submitted practice attempt must appear in the trainer queue");
    assert.equal(item.status, "Submitted");
    assert.equal(item.updatedAt, submittedAt.toISOString());
    assert.equal((await requestQueue(baseUrl)).some((queueItem) => queueItem.id.startsWith(unrelatedAttemptPrefix)), false);

    const needsRevisionBody = {
      idempotencyKey: `trainer-queue-needs-revision-${suffix}`,
      status: "Needs revision" as const,
      feedback: "Revise the practice output",
    };
    const firstReviewResponse = await requestPracticeReview(baseUrl, needsRevisionBody);
    const [createdReview] = await db.select().from(practiceReviewsTable)
      .where(eq(practiceReviewsTable.idempotencyKey, needsRevisionBody.idempotencyKey));
    assert(createdReview, "Review endpoint must persist the Needs revision review");

    item = practiceItem(await requestQueue(baseUrl));
    assert(item, "Needs revision practice attempt must remain in the trainer queue");
    assert.equal(item.status, "Needs revision");
    assert.equal(item.updatedAt, createdReview.createdAt.toISOString());

    const queueAfterFirstReview = await requestQueue(baseUrl);
    const retryResponse = await requestPracticeReview(baseUrl, needsRevisionBody);
    assert.deepEqual(retryResponse, firstReviewResponse, "Idempotent retry must return the original review result");
    assert.deepEqual(await requestQueue(baseUrl), queueAfterFirstReview, "Idempotent retry must not change the queue");
    assert.equal(
      (await db.select().from(practiceReviewsTable).where(eq(practiceReviewsTable.attemptId, attemptId))).length,
      1,
      "Idempotent retry must not append another review",
    );

    await assertLatestReviewLookupIsBounded();
    const dashboard = await requestDashboard(baseUrl);
    assert.equal(
      dashboard.recentActivity.find((activity) => activity.id === attemptId)?.status,
      "Needs revision",
      "Dashboard queue uses the same latest assigned review state",
    );
    assert.ok(dashboard.reviewHistory.length <= 50, "Dashboard review history remains bounded");
    assert.equal(
      dashboard.reviewHistory.some((review) => review.id.startsWith("trainer-queue-unrelated-review")),
      false,
      "Dashboard history excludes reviews outside the trainer assignment",
    );

    await requestPracticeReview(baseUrl, {
      idempotencyKey: `trainer-queue-reviewed-${suffix}`,
      status: "Reviewed",
      feedback: "Practice output accepted",
    });

    item = practiceItem(await requestQueue(baseUrl));
    assert.equal(item, undefined, "A subsequent Reviewed review must remove the practice attempt");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

run()
  .then(() => process.stdout.write("Trainer review queue integration check passed\n"))
  .catch((error: unknown) => {
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  });