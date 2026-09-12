import {
  activityCompletionEventsTable,
  db,
  evidenceReviewsTable,
  evidenceTable,
  learningActivitiesTable,
  learningTransitionEventsTable,
  outcomeVerificationEventsTable,
  practiceAttemptsTable,
  practiceReviewsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createIntegrationTestApp } from "./integration-test-app";

let baseUrl = "";

async function request<T>(
  path: string,
  options?: RequestInit,
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options?.headers,
    },
  });
  if (response.status !== expectedStatus) {
    throw new Error(
      `${options?.method ?? "GET"} ${path} returned ${response.status}, expected ${expectedStatus}: ${await response.text()}`,
    );
  }
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown, expectedStatus = 200) =>
  request<T>(
    path,
    { method: "POST", body: JSON.stringify(body) },
    expectedStatus,
  );

const postAs = <T>(path: string, body: unknown, role: "learner" | "trainer" | "assessor", expectedStatus = 200) =>
  request<T>(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "x-pathway-isolation-role": role },
    },
    expectedStatus,
  );

type AssessmentDetail = {
  criteria: Array<{ id: string }>;
};

type Readiness = {
  pathway: { id: string };
  gates: Array<{
    code: string;
    status: string;
    contracts?: Array<{
      moduleId: string;
      assessmentId: string;
      evidenceRequirementId: string;
      gateCode: string;
    }>;
  }>;
};

type Dashboard = {
  pathway: { id: string };
  currentLearning: { pathwayId: string };
};

type ReviewQueue = {
  recentActivity: Array<{ pathwayId: string }>;
};
type ProgramView = {
  modules: Array<{ code: string }>;
};
type PracticeTaskList = Array<{ moduleId: string }>;
type LearningPlan = Array<{ module: { code: string } }>;
type Courses = Array<{ modules: Array<{ moduleCode: string }> }>;

async function seedReadinessEvidence(moduleId: string) {
  const evidenceId = `pathway-isolation-evidence-${moduleId}`;
  await db.insert(evidenceTable).values({
    id: evidenceId,
    learnerId: "learner-demo",
    pathwayId: "path-b",
    moduleId,
    taskId: `task-${moduleId}`,
    title: `Path B ${moduleId} integration evidence`,
    type: "Report",
    description: `Traceable Path B ${moduleId} integration evidence`,
    fileName: null,
  });
  await db.insert(evidenceReviewsTable).values({
    id: `pathway-isolation-evidence-review-${moduleId}`,
    evidenceId,
    reviewerId: "trainer-aria",
    status: "Valid",
    comment: `Path B ${moduleId} evidence verified`,
    quality: { valid: true, relevant: true, sufficient: true, traceable: true },
  });
}

async function completePathBModule(moduleId: string, seedEvidence = true) {
  const detail = await request<AssessmentDetail>(`/assessments/assessment-${moduleId}`);
  await post(
    `/assessor/assessments/assessment-${moduleId}/decision`,
    {
      learnerId: "learner-demo",
      decision: "Competent",
      observation: `Path B ${moduleId} gate verification`,
      criteria: detail.criteria.map((criterion) => ({
        criterionId: criterion.id,
        score: 3,
        observation: "Meets the Path B standard",
        evidenceId: null,
      })),
    },
    201,
  );
  if (seedEvidence) await seedReadinessEvidence(moduleId);
}

async function completeB04WithCausalApiFlow() {
  const activityId = "activity-b04-protection";
  await db.insert(learningTransitionEventsTable).values({
    id: "pathway-isolation-b04-practice-required",
    activityId,
    learnerId: "learner-demo",
    enrollmentId: "enrol-demo",
    programId: "solar-pv-tech",
    pathwayId: "path-b",
    fromState: "OUTCOME_VERIFIED",
    toState: "PRACTICE_REQUIRED",
    actorId: "trainer-aria",
    actorRole: "trainer",
    entityReference: "pathway-isolation-b04-practice-required",
    reason: "Controlled readiness isolation fixture",
    idempotencyKey: "pathway-isolation-b04-practice-required",
    createdBy: "trainer-aria",
  });
  const practice = await post<{ id: string }>("/practice/tasks/task-b04/attempts", {
    sourceActivityId: activityId,
    reflection: "Verified pathway-scoped practice",
    outputSummary: "Path B protection design rationale",
    idempotencyKey: "pathway-isolation-b04-practice-attempt",
  }, 201);
  const evidence = await post<{ id: string }>("/evidence", {
    sourceActivityId: activityId,
    practiceAttemptId: practice.id,
    moduleId: "b04",
    taskId: "task-b04",
    title: "Path B b04 integration evidence",
    type: "Report",
    description: "Traceable Path B b04 integration evidence",
    fileName: null,
    idempotencyKey: "pathway-isolation-b04-evidence",
  }, 201);
  await post(`/trainer/evidence/${evidence.id}/review`, {
    idempotencyKey: `pathway-isolation-review-${evidence.id}`,
    status: "Valid",
    comment: "Path B b04 evidence verified",
    quality: { valid: true, relevant: true, sufficient: true, traceable: true },
  });
}

async function run() {
  const app = createIntegrationTestApp((req) => ({
    userId: "pathway-isolation-learner",
    learnerId: "learner-demo",
    // The learner identity is the default. Staff-only transitions use their
    // corresponding injected test actor, never an unauthenticated demo path.
    role: (req.get("x-pathway-isolation-role") as "learner" | "trainer" | "assessor" | undefined) ??
      (req.path.includes("/assessor/")
        ? "assessor"
        : req.path.includes("/trainer/")
          ? "trainer"
          : "learner"),
  }));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Pathway isolation test server did not bind to an ephemeral port");
  }
  baseUrl = `http://127.0.0.1:${address.port}/api`;
  try {
    await post("/learner/pathway", { pathwayId: "path-b" }, 201);

  const detail = await request<AssessmentDetail>("/assessments/assessment-b01");
  await post(
    "/assessor/assessments/assessment-b01/decision",
    {
      learnerId: "learner-demo",
      decision: "Competent",
      observation: "Path B integration verification",
      criteria: detail.criteria.map((criterion) => ({
        criterionId: criterion.id,
        score: 3,
        observation: "Meets the Path B standard",
        evidenceId: null,
      })),
    },
    201,
  );

  const readiness = await request<Readiness>("/readiness");
  if (
    readiness.pathway.id !== "path-b" ||
    readiness.gates.find((gate) => gate.code === "B1")?.status === "Passed"
  ) {
    throw new Error("Retired Path B B01 assessment incorrectly satisfied the active B1 baseline gate");
  }

  const practice = { id: "pathway-isolation-practice-b01" };
  await db.insert(practiceAttemptsTable).values({
    id: practice.id,
    taskId: "task-b01",
    learnerId: "learner-demo",
    pathwayId: "path-b",
    reflection: "Verified pathway-scoped practice",
    outputSummary: "Path B client brief",
    status: "Submitted",
    createdBy: "learner-demo",
  });
  await db.insert(evidenceTable).values({
    id: "pathway-isolation-evidence-b01",
    learnerId: "learner-demo",
    pathwayId: "path-b",
    moduleId: "b01",
    taskId: "task-b01",
    title: "Path B client brief evidence",
    type: "Design brief",
    description: "Traceable Path B integration evidence",
    fileName: null,
    createdBy: "learner-demo",
  });
  const evidence = { id: "pathway-isolation-evidence-b01" };
  await db.insert(practiceReviewsTable).values([
    {
      id: "pathway-isolation-practice-review-b01-revision",
      attemptId: practice.id,
      reviewerId: "trainer-aria",
      status: "Needs revision",
      feedback: "Path B practice requires one traceability correction",
      createdBy: "trainer-aria",
    },
    {
      id: "pathway-isolation-practice-review-b01-reviewed",
      attemptId: practice.id,
      reviewerId: "trainer-aria",
      status: "Reviewed",
      feedback: "Path B practice verified after correction",
      createdBy: "trainer-aria",
    },
  ]);
  const practiceHistory = await db
    .select()
    .from(practiceReviewsTable)
    .where(eq(practiceReviewsTable.attemptId, practice.id));
  if (
    practiceHistory.length !== 2 ||
    !practiceHistory.some((review) => review.status === "Needs revision") ||
    !practiceHistory.some((review) => review.status === "Reviewed")
  ) {
    throw new Error("Practice review history was overwritten rather than appended");
  }
  await db.insert(evidenceReviewsTable).values({
    id: "pathway-isolation-evidence-review-b01",
    evidenceId: evidence.id,
    reviewerId: "trainer-aria",
    status: "Valid",
    comment: "Path B evidence verified",
    quality: { valid: true, relevant: true, sufficient: true, traceable: true },
    createdBy: "trainer-aria",
  });

  // B01-B08 are retained as Path B compatibility records and still support
  // historical assessment/practice/evidence references, but they must not
  // drive the active Path B readiness projection.
  const b02Detail = await request<AssessmentDetail>("/assessments/assessment-b02");
  await post(
    "/assessor/assessments/assessment-b02/decision",
    {
      learnerId: "learner-demo",
      decision: "Competent",
      observation: "Historical B2 compatibility verification",
      criteria: b02Detail.criteria.map((criterion) => ({
        criterionId: criterion.id,
        score: 3,
        observation: "Retained historical Path B record",
        evidenceId: null,
      })),
    },
    201,
  );
  await seedReadinessEvidence("b02");
  for (const moduleId of ["b03", "b05", "b06"]) {
    await completePathBModule(moduleId);
  }
  await completePathBModule("b04", false);
  // B04 is retained only as a historical compatibility assessment. Active
  // practice/evidence projections must not expose its retired record.
  await completePathBModule("b07");
  await completePathBModule("b08");

  await postAs("/learning/transitions", {
    currentState: "NOT_STARTED",
    targetState: "IN_PROGRESS",
    learnerId: "learner-demo",
    pathwayId: "path-b",
    programId: "solar-pv-tech",
    activityId: "activity-m01",
    entityReference: "pathway-isolation-m01-start",
    reason: "Start shared M01 from Path B",
    idempotencyKey: "pathway-isolation-m01-start",
  }, "learner", 201);
  await postAs("/learning/transitions", {
    currentState: "IN_PROGRESS",
    targetState: "LEARNING_COMPLETED",
    learnerId: "learner-demo",
    pathwayId: "path-b",
    programId: "solar-pv-tech",
    activityId: "activity-m01",
    entityReference: "pathway-isolation-m01-complete",
    reason: "Complete shared M01 from Path B",
    idempotencyKey: "pathway-isolation-m01-complete",
  }, "learner", 201);
  await postAs("/learning/transitions", {
    currentState: "LEARNING_COMPLETED",
    targetState: "OUTCOME_VERIFIED",
    learnerId: "learner-demo",
    pathwayId: "path-b",
    programId: "solar-pv-tech",
    activityId: "activity-m01",
    entityReference: "pathway-isolation-m01-verify",
    reason: "Verify shared M01 from Path B",
    idempotencyKey: "pathway-isolation-m01-verify",
    references: { outcomeId: "outcome-m01" },
  }, "trainer", 201);
  const [sharedM01Activity] = await db.select().from(learningActivitiesTable)
    .where(eq(learningActivitiesTable.id, "activity-m01"));
  const m01Completions = await db.select().from(activityCompletionEventsTable)
    .where(eq(activityCompletionEventsTable.activityId, "activity-m01"));
  const m01Verifications = await db.select().from(outcomeVerificationEventsTable)
    .where(eq(outcomeVerificationEventsTable.activityId, "activity-m01"));
  if (
    sharedM01Activity?.pathwayId !== "path-a" ||
    !m01Completions.some((event) => event.pathwayId === "path-b" && event.status === "STARTED") ||
    !m01Completions.some((event) => event.pathwayId === "path-b" && event.status === "COMPLETED") ||
    !m01Verifications.some((event) => event.pathwayId === "path-b" && event.outcomeId === "outcome-m01")
  ) {
    throw new Error("Path B shared M01 transitions did not preserve Path-A ownership and Path-B event scope");
  }
  const activeProgram = await request<ProgramView>("/programs/solar-pv-tech");
  const activeTasks = await request<PracticeTaskList>("/practice/tasks");
  const activePlan = await request<LearningPlan>("/learner/learning-plan");
  const activeCourses = await request<Courses>("/learning/courses");
  const activeReadiness = await request<Readiness>("/readiness");
  const activeCodes = new Set(["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"]);
  if (
    activeProgram.modules.length !== 10 ||
    activeProgram.modules.some((module) => !activeCodes.has(module.code)) ||
    activeTasks.length !== 10 ||
    activeTasks.some((task) => !task.moduleId.startsWith("m")) ||
    activePlan.some((item) => !activeCodes.has(item.module.code)) ||
    activeCourses.some((course) => course.modules.some((module) => !activeCodes.has(module.moduleCode))) ||
    activeReadiness.gates.some((gate) => !gate.contracts?.length || gate.contracts.some((contract) =>
      !activeCodes.has(`M${contract.moduleId.slice(1).padStart(2, "0")}`) ||
      contract.assessmentId !== `assessment-${contract.moduleId}` ||
      contract.evidenceRequirementId !== `req-${contract.moduleId}` ||
      contract.gateCode !== gate.code
    )) ||
    activeReadiness.gates.some((gate) => gate.status === "Passed")
  ) {
    throw new Error("Path B active projections exposed retired B01-B08 or passed before canonical prerequisites");
  }
  for (const [gateCode, moduleIds] of [
    ["B1", ["m01", "m02", "m03"]],
    ["B2", ["m04", "m05", "m06", "m07"]],
    ["B3", ["m08", "m09"]],
    ["B4", ["m10"]],
  ] as const) {
    for (const moduleId of moduleIds) await completePathBModule(moduleId);
    const gateProgress = await request<Readiness>("/readiness");
    const gate = gateProgress.gates.find((item) => item.code === gateCode);
    const gateIndex = gateProgress.gates.findIndex((item) => item.code === gateCode);
    if (
      gate?.status !== "Passed" ||
      gateProgress.gates.slice(gateIndex + 1).some((item) => item.status === "Passed")
    ) {
      throw new Error(`Path B ${gateCode} did not pass only after its mapped canonical prerequisites`);
    }
  }

  await post("/learner/pathway", { pathwayId: "path-a" }, 201);
  await request("/modules/b01", undefined, 404);
  await request("/assessments/assessment-b01", undefined, 403);
  await post(
    `/trainer/practice/${practice.id}/review`,
    { idempotencyKey: "pathway-isolation-rejected-practice-review", status: "Reviewed", feedback: "Must be rejected outside Path B" },
    403,
  );
  await post(
    `/trainer/evidence/${evidence.id}/review`,
    {
      idempotencyKey: "pathway-isolation-rejected-evidence-review",
      status: "Valid",
      comment: "Must be rejected outside Path B",
      quality: { valid: true, relevant: true, sufficient: true, traceable: true },
    },
    403,
  );

  const pathADashboard = await request<Dashboard>("/learner/dashboard");
  if (
    pathADashboard.pathway.id !== "path-a" ||
    pathADashboard.currentLearning.pathwayId !== "path-a"
  ) {
    throw new Error("Path A dashboard included Path B learner state");
  }

  await post("/learner/pathway", { pathwayId: "path-b" }, 201);
  const pathBDashboard = await request<Dashboard>("/learner/dashboard");
  const assessorDashboard = await request<ReviewQueue>("/assessor/dashboard");
  if (
    pathBDashboard.pathway.id !== "path-b" ||
    pathBDashboard.currentLearning.pathwayId !== "path-b" ||
    assessorDashboard.recentActivity.some((item) => item.pathwayId !== "path-b")
  ) {
    throw new Error("Path B dashboard or assessor queue included Path A state");
  }

    process.stdout.write("Pathway isolation integration check passed\n");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
});