import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  db,
  enrollmentsTable,
  peopleTable,
  personRolesTable,
  practiceAttemptsTable,
  practiceReviewsTable,
  practiceTasksTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createIntegrationTestApp } from "./integration-test-app";

type QueueItem = {
  id: string;
  kind: "Evidence" | "Practice";
  status: string;
  updatedAt: string;
};

const suffix = crypto.randomUUID();
const trainerId = `trainer-queue-trainer-${suffix}`;
const learnerId = `trainer-queue-learner-${suffix}`;
const enrollmentId = `trainer-queue-enrollment-${suffix}`;
const attemptId = `trainer-queue-attempt-${suffix}`;
const reviewTimestamp = new Date("2026-09-16T08:30:00.000Z");

async function requestQueue(baseUrl: string) {
  const response = await fetch(`${baseUrl}/trainer/review-queue`);
  if (response.status !== 200) {
    throw new Error(`GET /trainer/review-queue: expected 200, got ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<QueueItem[]>;
}

function practiceItem(queue: QueueItem[]) {
  return queue.find((item) => item.kind === "Practice" && item.id === attemptId);
}

async function run() {
  const [task] = await db.select().from(practiceTasksTable)
    .where(eq(practiceTasksTable.moduleId, "m03"))
    .limit(1);
  assert(task, "Seeded Path A practice task is required");

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

    await db.insert(practiceReviewsTable).values({
      id: `trainer-queue-review-a-${suffix}`,
      attemptId,
      reviewerId: trainerId,
      status: "Needs revision",
      feedback: "Revise the practice output",
      createdAt: reviewTimestamp,
      createdBy: trainerId,
    });

    item = practiceItem(await requestQueue(baseUrl));
    assert(item, "Needs revision practice attempt must remain in the trainer queue");
    assert.equal(item.status, "Needs revision");
    assert.equal(item.updatedAt, reviewTimestamp.toISOString());

    await db.insert(practiceReviewsTable).values({
      id: `trainer-queue-review-z-${suffix}`,
      attemptId,
      reviewerId: trainerId,
      status: "Reviewed",
      feedback: "Practice output accepted",
      createdAt: reviewTimestamp,
      createdBy: trainerId,
    });

    item = practiceItem(await requestQueue(baseUrl));
    assert.equal(item, undefined, "Reviewed must win the same-timestamp ID tie and remove the practice attempt");
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