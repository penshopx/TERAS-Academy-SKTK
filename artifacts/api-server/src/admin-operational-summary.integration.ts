import { createIntegrationTestApp } from "./integration-test-app";
import {
  adminAuditEventsTable, assessmentAttemptsTable, assessmentsTable, db, enrollmentsTable, evidenceReviewsTable, evidenceTable,
  competencyFrameworksTable, diagnosticFollowUpFailureNotificationsTable, diagnosticFollowUpReminderDeliveriesTable, diagnosticFollowUpReminderResolutionsTable, diagnosticProfilesTable,
  diagnosticRecommendationFollowUpsTable, diagnosticRecommendationsTable, diagnosticSessionsTable,
  diagnosticTemplatesTable,
  gapsTable, modulesTable, pathwaysTable, peopleTable, personRolesTable, practiceAttemptsTable,
  practiceTasksTable, programsTable, reassessmentLinksTable, remediationActivitiesTable,
  remediationEventsTable, remediationPlansTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const suffix = crypto.randomUUID();
const id = (name: string) => `admin-summary-${name}-${suffix}`;
const ids = {
  activeLearner: id("active-learner"), inactiveLearner: id("inactive-learner"), program: id("program"),
  activePath: id("active-path"), inactivePath: id("inactive-path"), activeEnrollment: id("active-enrollment"),
  inactiveEnrollment: id("inactive-enrollment"), activeModule: id("active-module"), inactiveModule: id("inactive-module"),
  activeTask: id("active-task"), inactiveTask: id("inactive-task"), activeAssessment: id("active-assessment"),
  inactiveAssessment: id("inactive-assessment"), activeEvidence: id("active-evidence"), inactiveEvidence: id("inactive-evidence"),
  activePendingAttempt: id("active-attempt-1"), activeCompetentAttempt: id("active-attempt-2"),
  inactiveAttempt: id("inactive-attempt"), activePractice: id("active-practice"), inactivePractice: id("inactive-practice"),
  activeGap: id("active-gap"), inactiveGap: id("inactive-gap"), activePlan: id("active-plan"), inactivePlan: id("inactive-plan"),
  activeActivity: id("active-activity"), inactiveActivity: id("inactive-activity"),
  inactiveReassessment: id("inactive-reassessment"), pendingAfterRemediation: id("pending-after-remediation"),
  trainer: id("trainer"), framework: id("framework"), template: id("template"), session: id("session"),
  profile: id("profile"), recommendation: id("recommendation"), followUp: id("follow-up"), failedDelivery: id("failed-delivery"),
  failedNotification: id("failed-notification"), admin: id("admin"), secondAdmin: id("second-admin"),
};
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function run() {
  const app = createIntegrationTestApp(request => ({
    userId: request.query.actor === "second" ? ids.secondAdmin : ids.admin,
    role: null,
  }));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const listener = app.listen(0, () => resolve(listener)); });
  const address = server.address(); assert(address && typeof address !== "string", "Test server did not bind");
  try {
    await db.insert(peopleTable).values([
      { id: ids.admin, name: "Summary Admin", initials: "SA", email: null, role: "admin", organization: null, status: "active", authProvider: "supabase", authSubject: ids.admin },
      { id: ids.secondAdmin, name: "Second Summary Admin", initials: "SS", email: null, role: "admin", organization: null, status: "active", authProvider: "supabase", authSubject: ids.secondAdmin },
    ]);
    await db.insert(personRolesTable).values([
      { personId: ids.admin, role: "admin" },
      { personId: ids.secondAdmin, role: "admin" },
    ]);
    const baselineResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/summary`);
    const baseline = await baselineResponse.json() as any;
    assert(baselineResponse.status === 200, "Baseline summary request failed");
    const baselineCounts = Object.fromEntries(baseline.queues.map((queue: any) => [queue.id, queue.count]));
    await db.insert(peopleTable).values([
      { id: ids.activeLearner, name: "Active Summary Learner", initials: "AS", email: null, role: "learner", organization: null, status: "active" },
      { id: ids.inactiveLearner, name: "Inactive Summary Learner", initials: "IS", email: null, role: "learner", organization: null, status: "active" },
      { id: ids.trainer, name: "Summary Trainer", initials: "ST", email: `trainer-${suffix}@example.test`, role: "trainer", organization: null, status: "active" },
    ]);
    await db.insert(personRolesTable).values([
      { personId: ids.activeLearner, role: "learner" },
      { personId: ids.inactiveLearner, role: "learner" },
    ]);
    await db.insert(programsTable).values({ id: ids.program, domain: "Summary test", name: "Summary test", description: "Summary isolation", status: "active" });
    await db.insert(pathwaysTable).values([
      { id: ids.activePath, programId: ids.program, name: "Active path", type: "test", outcome: "test", status: "active" },
      { id: ids.inactivePath, programId: ids.program, name: "Inactive path", type: "test", outcome: "test", status: "active" },
    ]);
    await db.insert(enrollmentsTable).values([
      { id: ids.activeEnrollment, learnerId: ids.activeLearner, programId: ids.program, pathwayId: ids.activePath, status: "active" },
      { id: ids.inactiveEnrollment, learnerId: ids.inactiveLearner, programId: ids.program, pathwayId: ids.inactivePath, status: "completed" },
    ]);
    await db.insert(competencyFrameworksTable).values({ id: ids.framework, code: id("FW"), name: "Summary framework", description: "test", version: "1", status: "active" });
    await db.insert(diagnosticTemplatesTable).values({ id: ids.template, frameworkId: ids.framework, pathwayId: ids.activePath, version: "1", name: "Summary template", description: "test", status: "published" });
    await db.insert(diagnosticSessionsTable).values({ id: ids.session, learnerId: ids.activeLearner, enrollmentId: ids.activeEnrollment, pathwayId: ids.activePath, templateId: ids.template, frameworkId: ids.framework, status: "completed", progress: 100 });
    await db.insert(diagnosticProfilesTable).values({ id: ids.profile, sessionId: ids.session, learnerId: ids.activeLearner, pathwayId: ids.activePath, frameworkId: ids.framework, frameworkVersion: "1", currentState: "practice" });
    await db.insert(diagnosticRecommendationsTable).values({ id: ids.recommendation, profileId: ids.profile, frameworkId: ids.framework, kind: "practice", title: "Inspect inverter target", rationale: "test", priority: "high" });
    await db.insert(diagnosticRecommendationFollowUpsTable).values({ id: ids.followUp, recommendationId: ids.recommendation, trainerId: ids.trainer, status: "planned", targetAt: new Date("2030-01-10T00:00:00Z"), note: "test" });
    await db.insert(diagnosticFollowUpReminderDeliveriesTable).values({
      id: ids.failedDelivery, followUpId: ids.followUp, trainerId: ids.trainer, channel: "email", reminderKind: "due_soon",
      destination: `trainer-${suffix}@example.test`, status: "permanently_failed", attemptCount: 3,
      lastAttemptAt: new Date("2030-01-09T03:00:00Z"), failureReason: "secret transport detail: smtp.example.test",
    });
    await db.insert(diagnosticFollowUpFailureNotificationsTable).values({
      id: ids.failedNotification, reminderDeliveryId: ids.failedDelivery, destination: `operations-${suffix}@example.test`,
      status: "failed", attemptedAt: new Date("2030-01-09T03:05:00Z"), failureReason: "raw operations transport: mx.internal.example",
    });
    await db.insert(modulesTable).values([
      { id: ids.activeModule, programId: ids.program, pathwayId: ids.activePath, sequence: 1, code: "AS", name: "Active", capability: "test", evidence: "test", learningOutcomes: [], theory: [] },
      { id: ids.inactiveModule, programId: ids.program, pathwayId: ids.inactivePath, sequence: 1, code: "IS", name: "Inactive", capability: "test", evidence: "test", learningOutcomes: [], theory: [] },
    ]);
    await db.insert(practiceTasksTable).values([
      { id: ids.activeTask, moduleId: ids.activeModule, title: "Active", description: "test", mode: "test", durationMinutes: 1, output: "test" },
      { id: ids.inactiveTask, moduleId: ids.inactiveModule, title: "Inactive", description: "test", mode: "test", durationMinutes: 1, output: "test" },
    ]);
    await db.insert(assessmentsTable).values([{ id: ids.activeAssessment, moduleId: ids.activeModule, name: "Active" }, { id: ids.inactiveAssessment, moduleId: ids.inactiveModule, name: "Inactive" }]);
    await db.insert(evidenceTable).values([
      { id: ids.activeEvidence, learnerId: ids.activeLearner, pathwayId: ids.activePath, moduleId: ids.activeModule, taskId: ids.activeTask, title: "Active", type: "test", description: "test" },
      { id: ids.inactiveEvidence, learnerId: ids.inactiveLearner, pathwayId: ids.inactivePath, moduleId: ids.inactiveModule, taskId: ids.inactiveTask, title: "Inactive", type: "test", description: "test" },
    ]);
    await db.insert(evidenceReviewsTable).values([
      { id: id("active-review"), evidenceId: ids.activeEvidence, status: "Under review", quality: { valid: false, relevant: false, sufficient: false, traceable: false } },
      { id: id("inactive-review"), evidenceId: ids.inactiveEvidence, status: "Under review", quality: { valid: false, relevant: false, sufficient: false, traceable: false } },
    ]);
    await db.insert(assessmentAttemptsTable).values([
      { id: ids.activePendingAttempt, assessmentId: ids.activeAssessment, learnerId: ids.activeLearner, pathwayId: ids.activePath, number: 1, status: "Pending", createdAt: new Date("2030-01-01") },
      { id: ids.activeCompetentAttempt, assessmentId: ids.activeAssessment, learnerId: ids.activeLearner, pathwayId: ids.activePath, number: 2, status: "Completed", decision: "Competent", createdAt: new Date("2020-01-01") },
      { id: ids.inactiveAttempt, assessmentId: ids.inactiveAssessment, learnerId: ids.inactiveLearner, pathwayId: ids.inactivePath, number: 1, status: "Pending" },
      { id: ids.inactiveReassessment, assessmentId: ids.inactiveAssessment, learnerId: ids.inactiveLearner, pathwayId: ids.inactivePath, number: 2, status: "Pending" },
    ]);
    await db.insert(practiceAttemptsTable).values([
      { id: ids.activePractice, taskId: ids.activeTask, learnerId: ids.activeLearner, pathwayId: ids.activePath, reflection: "test", outputSummary: "test", status: "Completed" },
      { id: ids.inactivePractice, taskId: ids.inactiveTask, learnerId: ids.inactiveLearner, pathwayId: ids.inactivePath, reflection: "test", outputSummary: "test", status: "Completed" },
    ]);
    await db.insert(gapsTable).values([
      { id: ids.activeGap, learnerId: ids.activeLearner, pathwayId: ids.activePath, moduleId: ids.activeModule, capability: "test", criterion: "test", severity: "test", priority: "test", diagnosis: "test", gate: "test", recommendedAction: "test" },
      { id: ids.inactiveGap, learnerId: ids.inactiveLearner, pathwayId: ids.inactivePath, moduleId: ids.inactiveModule, capability: "test", criterion: "test", severity: "test", priority: "test", diagnosis: "test", gate: "test", recommendedAction: "test" },
    ]);
    await db.insert(remediationPlansTable).values([{ id: ids.activePlan, gapId: ids.activeGap, title: "Active", description: "test" }, { id: ids.inactivePlan, gapId: ids.inactiveGap, title: "Inactive", description: "test" }]);
    await db.insert(remediationActivitiesTable).values([{ id: ids.activeActivity, planId: ids.activePlan, title: "Active", description: "test", type: "test" }, { id: ids.inactiveActivity, planId: ids.inactivePlan, title: "Inactive", description: "test", type: "test" }]);
    await db.insert(remediationEventsTable).values([{ id: id("active-rem-event"), activityId: ids.activeActivity, status: "In progress" }, { id: id("inactive-rem-event"), activityId: ids.inactiveActivity, status: "In progress" }]);
    await db.insert(reassessmentLinksTable).values([
      { id: id("active-failed-link"), learnerId: ids.activeLearner, pathwayId: ids.activePath, originalGapId: ids.activeGap, remediationPlanId: ids.activePlan, practiceAttemptId: ids.activePractice, evidenceId: ids.activeEvidence, reassessmentAttemptId: ids.activePendingAttempt },
      { id: id("active-link"), learnerId: ids.activeLearner, pathwayId: ids.activePath, originalGapId: ids.activeGap, remediationPlanId: ids.activePlan, practiceAttemptId: ids.activePractice, evidenceId: ids.activeEvidence, reassessmentAttemptId: ids.activeCompetentAttempt },
      { id: id("inactive-link"), learnerId: ids.inactiveLearner, pathwayId: ids.inactivePath, originalGapId: ids.inactiveGap, remediationPlanId: ids.inactivePlan, practiceAttemptId: ids.inactivePractice, evidenceId: ids.inactiveEvidence, reassessmentAttemptId: ids.inactiveReassessment },
    ]);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/summary`);
    const summary = await response.json() as any;
    assert(response.status === 200, "Summary request failed");
    const counts = Object.fromEntries(summary.queues.map((queue: any) => [queue.id, queue.count]));
    assert(counts.evidence === baselineCounts.evidence + 1 && counts.remediation === baselineCounts.remediation + 1, "Only active enrollment evidence and remediation may increase queues");
    const evidenceQueue = summary.queues.find((queue: any) => queue.id === "evidence");
    const activeEvidenceItem = evidenceQueue.items.find((item: any) => item.id === ids.activeEvidence);
    assert(activeEvidenceItem?.learnerId === ids.activeLearner && activeEvidenceItem?.pathwayId === ids.activePath, "Evidence details must preserve learner and pathway context");
    assert(activeEvidenceItem?.trainerId === null && activeEvidenceItem?.assessorId === null, "Evidence details must preserve unassigned responsibility context");
    assert(!evidenceQueue.items.some((item: any) => item.id === ids.inactiveEvidence), "Inactive enrollment items must not leak into queue details");
    const remediationQueue = summary.queues.find((queue: any) => queue.id === "remediation");
    assert(remediationQueue.items.some((item: any) => item.id === ids.activePlan), "Active remediation plan must be present in queue details");
    assert(counts.reassessment === baselineCounts.reassessment, "Completed enrollment reassessment must be excluded and competent active reassessment must not queue");
    assert(counts.assessment === baselineCounts.assessment, "Highest attempt number must win even when its timestamp is older; completed enrollment attempts must be excluded");
    const reminderFailure = summary.failedTrainerReminders.find((item: any) => item.id === ids.failedDelivery);
    assert(reminderFailure?.trainerName === "Summary Trainer" && reminderFailure?.target === "Inspect inverter target", "Permanent reminder failure must identify trainer and target");
    assert(reminderFailure?.lastAttemptAt === "2030-01-09T03:00:00.000Z", "Permanent reminder failure must expose the last attempt time");
    assert(reminderFailure?.reason === "Layanan email tidak dapat menyelesaikan pengiriman.", "Admin summary must redact raw transport failure details");
    assert(!JSON.stringify(reminderFailure).includes("smtp.example.test"), "Admin summary leaked a raw transport failure reason");
    assert(reminderFailure?.failureNotification?.destination === `operations-${suffix}@example.test`, "Failed operations notification must identify its destination");
    assert(reminderFailure?.failureNotification?.attemptedAt === "2030-01-09T03:05:00.000Z", "Failed operations notification must expose its attempt time");
    assert(reminderFailure?.failureNotification?.reason === "Layanan email tidak dapat menyelesaikan pengiriman.", "Failed operations notification must expose only a safe reason");
    assert(!JSON.stringify(reminderFailure).includes("mx.internal.example"), "Admin summary leaked raw operations notification transport details");
    assert(reminderFailure?.status === "open" && reminderFailure?.resolution === null, "New permanent failure must be an open escalation");
    const [profileAfterSummary] = await db.select().from(diagnosticProfilesTable).where(inArray(diagnosticProfilesTable.id, [ids.profile]));
    const [deliveryAfterSummary] = await db.select().from(diagnosticFollowUpReminderDeliveriesTable).where(inArray(diagnosticFollowUpReminderDeliveriesTable.id, [ids.failedDelivery]));
    assert(profileAfterSummary.currentState === "practice", "Operational summary must not change diagnostic status");
    assert(deliveryAfterSummary.status === "permanently_failed", "Operational summary must not change reminder or readiness-related status");

    const resolutionUrl = `http://127.0.0.1:${address.port}/api/admin/reminder-escalations/${ids.failedDelivery}/resolution`;
    const [firstResolutionResponse, secondResolutionResponse] = await Promise.all([
      fetch(`${resolutionUrl}?actor=second`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "Handled through a verified manual call." }),
      }),
      fetch(resolutionUrl, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "Concurrent overwrite attempt." }),
      }),
    ]);
    const resolutionResponses = [firstResolutionResponse, secondResolutionResponse];
    const statuses = resolutionResponses.map(response => response.status).sort((a, b) => a - b);
    assert(statuses[0] === 201 && statuses[1] === 409, "Concurrent resolution attempts must produce exactly one 201 and one 409");
    const createdResponse = resolutionResponses.find(response => response.status === 201);
    assert(createdResponse, "Concurrent resolution attempts did not produce a created resolution");
    const resolution = await createdResponse.json() as any;
    assert(
      ["Handled through a verified manual call.", "Concurrent overwrite attempt."].includes(resolution.note)
        && [ids.admin, ids.secondAdmin].includes(resolution.resolvedByPersonId)
        && resolution.resolvedAt,
      "Resolution must preserve the winning note, actor, and time",
    );
    const storedResolutions = await db.select().from(diagnosticFollowUpReminderResolutionsTable)
      .where(eq(diagnosticFollowUpReminderResolutionsTable.reminderDeliveryId, ids.failedDelivery));
    assert(storedResolutions.length === 1 && storedResolutions[0].id === resolution.id, "Concurrent resolution attempts must store exactly one resolution");
    const [originalDelivery] = await db.select().from(diagnosticFollowUpReminderDeliveriesTable).where(inArray(diagnosticFollowUpReminderDeliveriesTable.id, [ids.failedDelivery]));
    assert(originalDelivery.status === "permanently_failed" && originalDelivery.failureReason === "secret transport detail: smtp.example.test", "Resolution must not mutate the original delivery audit");
    const resolvedSummary = await (await fetch(`http://127.0.0.1:${address.port}/api/admin/summary`)).json() as any;
    const resolvedFailure = resolvedSummary.failedTrainerReminders.find((item: any) => item.id === ids.failedDelivery);
    assert(resolvedFailure?.status === "resolved" && [ids.admin, ids.secondAdmin].includes(resolvedFailure.resolution?.resolvedByPersonId), "Summary must distinguish resolved escalation with its history");
    const baselineOpenFailureCount = baseline.actions?.find((item: any) => item.id === "review-failed-trainer-reminders")?.count ?? 0;
    const resolvedOpenFailureCount = resolvedSummary.actions?.find((item: any) => item.id === "review-failed-trainer-reminders")?.count ?? 0;
    assert(resolvedOpenFailureCount === baselineOpenFailureCount, "Resolved escalation must leave the open action count");

    await db.insert(remediationEventsTable).values({ id: id("active-rem-completed"), activityId: ids.activeActivity, status: "Completed" });
    await db.insert(assessmentAttemptsTable).values({
      id: ids.pendingAfterRemediation, assessmentId: ids.activeAssessment, learnerId: ids.activeLearner,
      pathwayId: ids.activePath, number: 3, status: "Pending",
    });
    await db.insert(reassessmentLinksTable).values({
      id: id("active-pending-after-remediation-link"), learnerId: ids.activeLearner, pathwayId: ids.activePath,
      originalGapId: ids.activeGap, remediationPlanId: ids.activePlan, practiceAttemptId: ids.activePractice,
      evidenceId: ids.activeEvidence, reassessmentAttemptId: ids.pendingAfterRemediation,
    });
    const completedRemediationResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/summary`);
    const completedRemediationSummary = await completedRemediationResponse.json() as any;
    assert(completedRemediationResponse.status === 200, "Completed-remediation summary request failed");
    const completedRemediationCounts = Object.fromEntries(completedRemediationSummary.queues.map((queue: any) => [queue.id, queue.count]));
    assert(completedRemediationCounts.remediation === baselineCounts.remediation, "Completed remediation must leave the remediation queue");
    assert(completedRemediationCounts.reassessment === baselineCounts.reassessment + 1, "Pending reassessment must remain queued after remediation completes");
    assert(completedRemediationCounts.assessment === baselineCounts.assessment + 1, "Pending reassessment attempt must remain in the assessment queue");
  } finally {
    await db.delete(diagnosticFollowUpReminderResolutionsTable).where(inArray(diagnosticFollowUpReminderResolutionsTable.reminderDeliveryId, [ids.failedDelivery]));
    await db.delete(diagnosticFollowUpFailureNotificationsTable).where(inArray(diagnosticFollowUpFailureNotificationsTable.reminderDeliveryId, [ids.failedDelivery]));
    await db.delete(diagnosticFollowUpReminderDeliveriesTable).where(inArray(diagnosticFollowUpReminderDeliveriesTable.id, [ids.failedDelivery]));
    await db.delete(diagnosticRecommendationFollowUpsTable).where(inArray(diagnosticRecommendationFollowUpsTable.id, [ids.followUp]));
    await db.delete(diagnosticRecommendationsTable).where(inArray(diagnosticRecommendationsTable.id, [ids.recommendation]));
    await db.delete(diagnosticProfilesTable).where(inArray(diagnosticProfilesTable.id, [ids.profile]));
    await db.delete(diagnosticSessionsTable).where(inArray(diagnosticSessionsTable.id, [ids.session]));
    await db.delete(diagnosticTemplatesTable).where(inArray(diagnosticTemplatesTable.id, [ids.template]));
    await db.delete(reassessmentLinksTable).where(inArray(reassessmentLinksTable.id, [id("active-failed-link"), id("active-link"), id("inactive-link"), id("active-pending-after-remediation-link")]));
    await db.delete(remediationEventsTable).where(inArray(remediationEventsTable.activityId, [ids.activeActivity, ids.inactiveActivity]));
    await db.delete(remediationActivitiesTable).where(inArray(remediationActivitiesTable.id, [ids.activeActivity, ids.inactiveActivity]));
    await db.delete(remediationPlansTable).where(inArray(remediationPlansTable.id, [ids.activePlan, ids.inactivePlan]));
    await db.delete(gapsTable).where(inArray(gapsTable.id, [ids.activeGap, ids.inactiveGap]));
    await db.delete(practiceAttemptsTable).where(inArray(practiceAttemptsTable.id, [ids.activePractice, ids.inactivePractice]));
    await db.delete(assessmentAttemptsTable).where(inArray(assessmentAttemptsTable.id, [ids.activePendingAttempt, ids.activeCompetentAttempt, ids.inactiveAttempt, ids.inactiveReassessment, ids.pendingAfterRemediation]));
    await db.delete(evidenceReviewsTable).where(inArray(evidenceReviewsTable.evidenceId, [ids.activeEvidence, ids.inactiveEvidence]));
    await db.delete(evidenceTable).where(inArray(evidenceTable.id, [ids.activeEvidence, ids.inactiveEvidence]));
    await db.delete(assessmentsTable).where(inArray(assessmentsTable.id, [ids.activeAssessment, ids.inactiveAssessment]));
    await db.delete(practiceTasksTable).where(inArray(practiceTasksTable.id, [ids.activeTask, ids.inactiveTask]));
    await db.delete(modulesTable).where(inArray(modulesTable.id, [ids.activeModule, ids.inactiveModule]));
    await db.delete(enrollmentsTable).where(inArray(enrollmentsTable.id, [ids.activeEnrollment, ids.inactiveEnrollment]));
    await db.delete(pathwaysTable).where(inArray(pathwaysTable.id, [ids.activePath, ids.inactivePath]));
    await db.delete(competencyFrameworksTable).where(inArray(competencyFrameworksTable.id, [ids.framework]));
    await db.delete(programsTable).where(inArray(programsTable.id, [ids.program]));
    await db.delete(adminAuditEventsTable).where(inArray(adminAuditEventsTable.actorPersonId, [ids.admin, ids.secondAdmin]));
    await db.delete(personRolesTable).where(inArray(personRolesTable.personId, [ids.activeLearner, ids.inactiveLearner, ids.admin, ids.secondAdmin]));
    await db.delete(peopleTable).where(inArray(peopleTable.id, [ids.activeLearner, ids.inactiveLearner, ids.trainer, ids.admin, ids.secondAdmin]));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

await run();