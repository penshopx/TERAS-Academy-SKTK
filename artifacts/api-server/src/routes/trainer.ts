import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { GetTrainerDashboardResponse, GetTrainerReminderPreferenceHistoryResponse, GetTrainerReminderPreferencesResponse, GetTrainerReviewQueueResponse, RecordDiagnosticRecommendationFollowUpBody, RecordDiagnosticRecommendationFollowUpParams, RecordDiagnosticRecommendationFollowUpResponse, ReviewEvidenceByTrainerBody, ReviewEvidenceByTrainerParams, ReviewEvidenceByTrainerResponse, ReviewPracticeAttemptBody, ReviewPracticeAttemptParams, ReviewPracticeAttemptResponse, UpdateTrainerReminderPreferencesBody, UpdateTrainerReminderPreferencesResponse } from "@workspace/api-zod";
import { db, diagnosticGapsTable, diagnosticProfilesTable, diagnosticRecommendationFollowUpsTable, diagnosticRecommendationsTable, diagnosticSafetyFlagsTable, evidenceReviewsTable, evidenceTable, gapEventsTable, gapsTable, learningRecordLinksTable, peopleTable, practiceAttemptsTable, practiceReviewsTable, practiceTasksTable, modulesTable, remediationActivitiesTable, remediationEventsTable, remediationPlansTable, trainerReminderPreferencesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { evidenceRecords, gapRecords, pathwayHasModule, remediationRecords, selectedBaselineModuleIds, workspaceAssignmentContexts } from "../lib/teras";
import { authorizeWorkspaceRole } from "../lib/authorization";
import { learningNextAction } from "../lib/learning-transition";
import { trainerBottlenecks } from "../lib/trainer-bottlenecks";
import { reminderDeliveryAvailability } from "../lib/trainer-follow-up-notifications";

const router: IRouter = Router();
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const FOLLOW_UP_DUE_SOON_DAYS = 7;
const followUpFingerprint = (value: { status: string; targetAt: string | null; note: string }) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reviewFingerprint = (value: object) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
type ReminderPreferencesResponseSource = {
  emailEnabled: boolean;
  timeZone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  updatedAt: Date | null;
};

const DEFAULT_REMINDER_PREFERENCES: ReminderPreferencesResponseSource = {
  emailEnabled: true,
  timeZone: "Asia/Jakarta",
  quietHoursStart: null,
  quietHoursEnd: null,
  updatedAt: null,
};

function reminderPreferencesResponse(preferences: ReminderPreferencesResponseSource) {
  return {
    ...preferences,
    ...reminderDeliveryAvailability(new Date(), preferences),
  };
}

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function followUpReminder(followUps: { status: string; targetAt: Date | null }[], now = new Date()) {
  const latest = followUps[0];
  if (!latest) return { status: null, timing: "unscheduled" as const };
  if (latest.status === "completed") return { status: latest.status, timing: "completed" as const };
  if (!latest.targetAt) return { status: latest.status, timing: "unscheduled" as const };
  if (latest.targetAt.getTime() < now.getTime()) return { status: latest.status, timing: "overdue" as const };
  const dueSoonAt = new Date(now);
  dueSoonAt.setUTCDate(dueSoonAt.getUTCDate() + FOLLOW_UP_DUE_SOON_DAYS);
  return {
    status: latest.status,
    timing: latest.targetAt.getTime() <= dueSoonAt.getTime() ? "due_soon" as const : "scheduled" as const,
  };
}

async function appendModuleRevisionState(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], moduleId: string, learnerId: string, pathwayId: string, reviewerId: string) {
  const gaps = await tx.select().from(gapsTable).where(and(eq(gapsTable.moduleId, moduleId), eq(gapsTable.learnerId, learnerId), eq(gapsTable.pathwayId, pathwayId)));
  if (!gaps.length) return;
  await tx.insert(gapEventsTable).values(gaps.map((gap) => ({ id: id("gap-event"), gapId: gap.id, status: "Open", createdBy: reviewerId })));
  const plans = await tx.select().from(remediationPlansTable);
  const planIds = new Set(plans.filter((plan) => gaps.some((gap) => gap.id === plan.gapId)).map((plan) => plan.id));
  const activities = (await tx.select().from(remediationActivitiesTable)).filter((activity) => planIds.has(activity.planId));
  if (activities.length) await tx.insert(remediationEventsTable).values(activities.map((activity) => ({ id: id("remediation-event"), activityId: activity.id, status: "In progress", createdBy: reviewerId })));
}

async function queue(trainerId: string) {
  const [contexts, attempts, reviews, tasks, modules] = await Promise.all([workspaceAssignmentContexts(trainerId, "trainer"), db.select().from(practiceAttemptsTable), db.select().from(practiceReviewsTable), db.select().from(practiceTasksTable), db.select().from(modulesTable)]);
  const latestReviews = new Map<string, typeof reviews[number]>();
  for (const review of reviews) if (!latestReviews.has(review.attemptId) || latestReviews.get(review.attemptId)!.createdAt < review.createdAt) latestReviews.set(review.attemptId, review);
  const items = await Promise.all(contexts.map(async (context) => {
    const selected = await selectedBaselineModuleIds(context.pathway.id, context.baselineVersionId);
    const pathwayModules = modules.filter((module) => (module.pathwayId === context.pathway.id || selected.has(module.id)) && module.programId === context.program.id);
    const moduleIds = new Set(pathwayModules.map((module) => module.id));
    const evidence = await evidenceRecords(context.learner.id, context.pathway.id, context.baselineVersionId);
    return [
      ...evidence.filter((item) => item.status !== "Valid").map((item) => ({ id: item.id, kind: "Evidence", learnerId: context.learner.id, learnerName: context.learner.name, moduleName: item.moduleName, pathwayId: context.pathway.id, pathwayName: context.pathway.name, title: item.title, status: item.status, priority: item.moduleId === "m03" ? "Critical" : "High", updatedAt: item.submittedAt })),
      ...attempts.filter((attempt) => attempt.learnerId === context.learner.id && attempt.pathwayId === context.pathway.id && moduleIds.has(tasks.find((task) => task.id === attempt.taskId)?.moduleId ?? "") && (latestReviews.get(attempt.id)?.status ?? attempt.status) !== "Reviewed").map((attempt) => ({ id: attempt.id, kind: "Practice", learnerId: context.learner.id, learnerName: context.learner.name, moduleName: pathwayModules.find((module) => module.id === tasks.find((task) => task.id === attempt.taskId)?.moduleId)?.name ?? "Module", pathwayId: context.pathway.id, pathwayName: context.pathway.name, title: "Practice attempt", status: latestReviews.get(attempt.id)?.status ?? attempt.status, priority: "Normal", updatedAt: attempt.createdAt })),
    ];
  }));
  return { contexts, items: items.flat() };
}

async function diagnosticFollowUps(contexts: Awaited<ReturnType<typeof workspaceAssignmentContexts>>) {
  const [followUps, people] = await Promise.all([
    db.select().from(diagnosticRecommendationFollowUpsTable),
    db.select().from(peopleTable),
  ]);
  const trainerNames = new Map(people.map((person) => [person.id, person.name]));
  return Promise.all(contexts.map(async (context) => {
    const [profile] = await db.select().from(diagnosticProfilesTable)
      .where(and(
        eq(diagnosticProfilesTable.learnerId, context.learner.id),
        eq(diagnosticProfilesTable.pathwayId, context.pathway.id),
      ))
      .orderBy(desc(diagnosticProfilesTable.completedAt), desc(diagnosticProfilesTable.id))
      .limit(1);
    if (!profile) return {
      learnerId: context.learner.id,
      learnerName: context.learner.name,
      pathwayId: context.pathway.id,
      pathwayName: context.pathway.name,
      baselineScore: null,
      currentState: null,
      completedAt: null,
      dimensionSummaries: {},
      gaps: [],
      recommendations: [],
      safetyFindings: [],
    };
    const [gaps, recommendations, safetyFindings] = await Promise.all([
      db.select().from(diagnosticGapsTable).where(eq(diagnosticGapsTable.profileId, profile.id)),
      db.select().from(diagnosticRecommendationsTable).where(eq(diagnosticRecommendationsTable.profileId, profile.id)),
      db.select().from(diagnosticSafetyFlagsTable).where(eq(diagnosticSafetyFlagsTable.profileId, profile.id)),
    ]);
    const dimensionSummaries = Object.fromEntries(
      Object.entries(profile.dimensionSummaries).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
    const scores = Object.values(dimensionSummaries);
    return {
      learnerId: context.learner.id,
      learnerName: context.learner.name,
      pathwayId: context.pathway.id,
      pathwayName: context.pathway.name,
      baselineScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
      currentState: profile.currentState,
      completedAt: profile.completedAt,
      dimensionSummaries,
      gaps: gaps.sort((a, b) => (a.severity === "Critical" ? -1 : 0) - (b.severity === "Critical" ? -1 : 0)),
      recommendations: recommendations
        .sort((a, b) => (a.priority === "Critical" ? -1 : 0) - (b.priority === "Critical" ? -1 : 0))
        .map((recommendation) => {
          const recommendationFollowUps = followUps
            .filter((followUp) => followUp.recommendationId === recommendation.id)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
          return {
            ...recommendation,
            followUpReminder: followUpReminder(recommendationFollowUps),
            followUps: recommendationFollowUps.map((followUp) => ({
              id: followUp.id,
              recommendationId: followUp.recommendationId,
              trainerId: followUp.trainerId,
              trainerName: trainerNames.get(followUp.trainerId) ?? "Trainer",
              status: followUp.status,
              targetAt: followUp.targetAt,
              note: followUp.note,
              recordedAt: followUp.createdAt,
            })),
          };
        }),
      safetyFindings,
    };
  }));
}

router.get("/trainer/review-queue", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  res.json(GetTrainerReviewQueueResponse.parse((await queue(trainerId)).items));
});
router.get("/trainer/dashboard", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  const { contexts, items } = await queue(trainerId);
  const [scoped, allEvidence, allEvidenceReviews, allAttempts, allPracticeReviews, allTasks, people] = await Promise.all([
    Promise.all(contexts.map(async (context) => ({ evidence: await evidenceRecords(context.learner.id, context.pathway.id, context.baselineVersionId), gaps: await gapRecords(context.learner.id, context.pathway.id), plans: await remediationRecords(context.learner.id, context.pathway.id) }))),
    db.select().from(evidenceTable), db.select().from(evidenceReviewsTable), db.select().from(practiceAttemptsTable), db.select().from(practiceReviewsTable), db.select().from(practiceTasksTable), db.select().from(peopleTable),
  ]);
  const [trainer] = await db.select().from(peopleTable).where(eq(peopleTable.id, trainerId));
  const contextFor = (learnerId: string, pathwayId: string) => contexts.find((context) => context.learner.id === learnerId && context.pathway.id === pathwayId);
  const reviewerNames = new Map(people.map((person) => [person.id, person.name]));
  const evidenceById = new Map(allEvidence.map((item) => [item.id, item]));
  const attemptById = new Map(allAttempts.map((item) => [item.id, item]));
  const taskById = new Map(allTasks.map((item) => [item.id, item]));
  const reviewHistory = [
    ...allEvidenceReviews.flatMap((review) => {
      const evidence = evidenceById.get(review.evidenceId); const context = evidence && contextFor(evidence.learnerId, evidence.pathwayId);
      return evidence && context ? [{ id: review.id, kind: "Evidence" as const, learnerId: context.learner.id, learnerName: context.learner.name, pathwayId: context.pathway.id, pathwayName: context.pathway.name, subject: evidence.title, outcome: review.status, comment: review.comment ?? "", quality: review.quality, reviewer: review.reviewerId ? reviewerNames.get(review.reviewerId) ?? null : null, recordedAt: review.createdAt }] : [];
    }),
    ...allPracticeReviews.flatMap((review) => {
      const attempt = attemptById.get(review.attemptId); const context = attempt && contextFor(attempt.learnerId, attempt.pathwayId);
      return attempt && context ? [{ id: review.id, kind: "Practice" as const, learnerId: context.learner.id, learnerName: context.learner.name, pathwayId: context.pathway.id, pathwayName: context.pathway.name, subject: taskById.get(attempt.taskId)?.title ?? "Practice attempt", outcome: review.status, comment: review.feedback, quality: null, reviewer: review.reviewerId ? reviewerNames.get(review.reviewerId) ?? null : null, recordedAt: review.createdAt }] : [];
    }),
  ].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime() || b.id.localeCompare(a.id));
  const [bottlenecks, diagnosticFollowUpItems] = await Promise.all([trainerBottlenecks(contexts), diagnosticFollowUps(contexts)]);
  res.json(GetTrainerDashboardResponse.parse({ trainer, assignedLearnerCount: new Set(contexts.map((context) => context.learner.id)).size, pendingFeedbackCount: items.filter((item) => item.kind === "Practice").length, pendingEvidenceCount: scoped.flatMap((item) => item.evidence).filter((item) => item.status === "Under review").length, activeRemediationCount: scoped.flatMap((item) => item.plans).filter((item) => item.status !== "Completed").length, blockedLearnerCount: new Set(contexts.filter((context, index) => scoped[index]!.gaps.some((gap) => gap.severity === "Critical" && gap.status !== "Resolved")).map((context) => context.learner.id)).size, bottlenecks, diagnosticFollowUps: diagnosticFollowUpItems, recentActivity: items, reviewHistory }));
});
router.get("/trainer/reminder-preferences", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  const [latest] = await db.select().from(trainerReminderPreferencesTable)
    .where(eq(trainerReminderPreferencesTable.trainerId, trainerId))
    .orderBy(desc(trainerReminderPreferencesTable.createdAt), desc(trainerReminderPreferencesTable.id))
    .limit(1);
  res.json(GetTrainerReminderPreferencesResponse.parse(reminderPreferencesResponse(latest ? {
    emailEnabled: latest.emailEnabled,
    timeZone: latest.timeZone,
    quietHoursStart: latest.quietHoursStart,
    quietHoursEnd: latest.quietHoursEnd,
    updatedAt: latest.createdAt,
  } : DEFAULT_REMINDER_PREFERENCES)));
});
router.get("/trainer/reminder-preferences/history", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  const revisions = await db.select().from(trainerReminderPreferencesTable)
    .where(eq(trainerReminderPreferencesTable.trainerId, trainerId))
    .orderBy(desc(trainerReminderPreferencesTable.createdAt), desc(trainerReminderPreferencesTable.id));
  res.json(GetTrainerReminderPreferenceHistoryResponse.parse(revisions.map((revision) => ({
    id: revision.id,
    emailEnabled: revision.emailEnabled,
    timeZone: revision.timeZone,
    quietHoursStart: revision.quietHoursStart,
    quietHoursEnd: revision.quietHoursEnd,
    recordedAt: revision.createdAt,
  }))));
});
router.put("/trainer/reminder-preferences", async (req, res): Promise<void> => {
  const body = UpdateTrainerReminderPreferencesBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  if (!isTimeZone(body.data.timeZone)) { res.status(400).json({ error: "Time zone must be a valid IANA time zone" }); return; }
  if ((body.data.quietHoursStart === null) !== (body.data.quietHoursEnd === null)) {
    res.status(400).json({ error: "Quiet hours start and end must both be set or both be empty" });
    return;
  }
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  const [revision] = await db.insert(trainerReminderPreferencesTable).values({
    id: id("trainer-reminder-preference"),
    trainerId,
    emailEnabled: body.data.emailEnabled,
    timeZone: body.data.timeZone,
    quietHoursStart: body.data.quietHoursStart,
    quietHoursEnd: body.data.quietHoursEnd,
    createdBy: trainerId,
  }).returning();
  res.json(UpdateTrainerReminderPreferencesResponse.parse(reminderPreferencesResponse({
    emailEnabled: revision!.emailEnabled,
    timeZone: revision!.timeZone,
    quietHoursStart: revision!.quietHoursStart,
    quietHoursEnd: revision!.quietHoursEnd,
    updatedAt: revision!.createdAt,
  })));
});
router.post("/trainer/diagnostic-recommendations/:recommendationId/follow-ups", async (req, res): Promise<void> => {
  const params = RecordDiagnosticRecommendationFollowUpParams.safeParse(req.params);
  const body = RecordDiagnosticRecommendationFollowUpBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  if (!body.data.note.trim()) { res.status(400).json({ error: "Follow-up note cannot be blank" }); return; }
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  const [recommendation] = await db.select().from(diagnosticRecommendationsTable).where(eq(diagnosticRecommendationsTable.id, params.data.recommendationId));
  if (!recommendation) { res.status(404).json({ error: "Diagnostic recommendation not found" }); return; }
  const [profile] = await db.select().from(diagnosticProfilesTable).where(eq(diagnosticProfilesTable.id, recommendation.profileId));
  if (!profile) { res.status(404).json({ error: "Diagnostic profile not found" }); return; }
  const contexts = await workspaceAssignmentContexts(trainerId, "trainer");
  if (!contexts.some((context) => context.learner.id === profile.learnerId && context.pathway.id === profile.pathwayId)) {
    res.status(403).json({ error: "Diagnostic recommendation is outside your assigned active pathway" });
    return;
  }
  const [trainer] = await db.select().from(peopleTable).where(eq(peopleTable.id, trainerId));
  const normalized = {
    status: body.data.status,
    targetAt: body.data.targetAt ? new Date(body.data.targetAt).toISOString() : null,
    note: body.data.note.trim(),
  };
  const fingerprint = followUpFingerprint(normalized);
  const followUp = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(diagnosticRecommendationFollowUpsTable).values({
      id: id("diagnostic-follow-up"),
      recommendationId: recommendation.id,
      trainerId,
      idempotencyKey: body.data.idempotencyKey,
      idempotencyFingerprint: fingerprint,
      status: normalized.status,
      targetAt: normalized.targetAt ? new Date(normalized.targetAt) : null,
      note: normalized.note,
      createdBy: trainerId,
    }).onConflictDoNothing({
      target: [
        diagnosticRecommendationFollowUpsTable.recommendationId,
        diagnosticRecommendationFollowUpsTable.trainerId,
        diagnosticRecommendationFollowUpsTable.idempotencyKey,
      ],
    }).returning();
    if (inserted) return inserted;
    const [existing] = await tx.select().from(diagnosticRecommendationFollowUpsTable).where(and(
      eq(diagnosticRecommendationFollowUpsTable.recommendationId, recommendation.id),
      eq(diagnosticRecommendationFollowUpsTable.trainerId, trainerId),
      eq(diagnosticRecommendationFollowUpsTable.idempotencyKey, body.data.idempotencyKey),
    )).limit(1);
    return existing;
  });
  if (!followUp) throw new Error("Diagnostic recommendation follow-up was not recorded");
  if (followUp.idempotencyFingerprint !== fingerprint) {
    res.status(409).json({ error: "The idempotency key was already used with a different follow-up draft." });
    return;
  }
  res.status(201).json(RecordDiagnosticRecommendationFollowUpResponse.parse({
    id: followUp.id,
    recommendationId: followUp.recommendationId,
    trainerId: followUp.trainerId,
    trainerName: trainer?.name ?? "Trainer",
    status: followUp.status,
    targetAt: followUp.targetAt,
    note: followUp.note,
    recordedAt: followUp.createdAt,
  }));
});
router.post("/trainer/practice/:attemptId/review", async (req, res): Promise<void> => {
  const params = ReviewPracticeAttemptParams.safeParse(req.params); const body = ReviewPracticeAttemptBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const reviewerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!reviewerId) return;
  const [attempt] = await db.select().from(practiceAttemptsTable).where(eq(practiceAttemptsTable.id, params.data.attemptId));
  if (!attempt) { res.status(404).json({ error: "Practice attempt not found" }); return; }
  const [task] = await db.select().from(practiceTasksTable).where(eq(practiceTasksTable.id, attempt.taskId));
  const contexts = await workspaceAssignmentContexts(reviewerId, "trainer");
  const context = contexts.find((item) => item.learner.id === attempt.learnerId && item.pathway.id === attempt.pathwayId);
  const [module] = task ? await db.select().from(modulesTable).where(eq(modulesTable.id, task.moduleId)) : [];
  if (!context || !task || !module || !await pathwayHasModule(context.pathway.id, module.id, context.baselineVersionId) || module.programId !== context.program.id) { res.status(403).json({ error: "Practice attempt is outside your assigned active pathway" }); return; }
  const fingerprint = reviewFingerprint({ status: body.data.status, feedback: body.data.feedback });
  const review = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(practiceReviewsTable).values({
      id: id("practice-review"), attemptId: attempt.id, reviewerId, status: body.data.status, feedback: body.data.feedback,
      idempotencyKey: body.data.idempotencyKey, idempotencyFingerprint: fingerprint, createdBy: reviewerId,
    }).onConflictDoNothing().returning();
    if (inserted) {
      if (body.data.status === "Needs revision") await appendModuleRevisionState(tx, task.moduleId, attempt.learnerId, attempt.pathwayId, reviewerId);
      return inserted;
    }
    const [existing] = await tx.select().from(practiceReviewsTable).where(and(
      eq(practiceReviewsTable.attemptId, attempt.id),
      eq(practiceReviewsTable.reviewerId, reviewerId),
      eq(practiceReviewsTable.idempotencyKey, body.data.idempotencyKey),
    )).limit(1);
    return existing;
  });
  if (!review) throw new Error("Practice review was not recorded");
  if (review.idempotencyFingerprint !== fingerprint) { res.status(409).json({ error: "The idempotency key was already used with a different practice review." }); return; }
  const [link] = await db.select().from(learningRecordLinksTable).where(eq(learningRecordLinksTable.practiceAttemptId, attempt.id)).limit(1);
  if (!link) throw new Error("Practice attempt has no causal learning record");
  res.json(ReviewPracticeAttemptResponse.parse({ id: attempt.id, taskId: attempt.taskId, submittedAt: attempt.createdAt, status: review.status, reflection: attempt.reflection, outputSummary: attempt.outputSummary, pathwayId: attempt.pathwayId, sourceActivityId: link.activityId, nextAction: learningNextAction("REVISION_REQUIRED", { activityId: link.activityId, taskId: attempt.taskId, practiceAttemptId: attempt.id }), feedback: review.feedback }));
});
router.post("/trainer/evidence/:evidenceId/review", async (req, res): Promise<void> => {
  const params = ReviewEvidenceByTrainerParams.safeParse(req.params); const body = ReviewEvidenceByTrainerBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const reviewerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!reviewerId) return;
  if (body.data.status === "Valid" && Object.values(body.data.quality).some((passed) => !passed)) { res.status(400).json({ error: "Evidence cannot be marked Valid while a quality check is incomplete" }); return; }
  const [evidence] = await db.select().from(evidenceTable).where(eq(evidenceTable.id, params.data.evidenceId));
  if (!evidence) { res.status(404).json({ error: "Evidence not found" }); return; }
  const contexts = await workspaceAssignmentContexts(reviewerId, "trainer");
  const context = contexts.find((item) => item.learner.id === evidence.learnerId && item.pathway.id === evidence.pathwayId);
  if (!context) { res.status(403).json({ error: "Evidence is outside your assigned active pathway" }); return; }
  const fingerprint = reviewFingerprint({ status: body.data.status, comment: body.data.comment, quality: body.data.quality });
  const review = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(evidenceReviewsTable).values({
      id: id("evidence-review"), evidenceId: evidence.id, reviewerId, status: body.data.status, comment: body.data.comment,
      quality: body.data.quality, idempotencyKey: body.data.idempotencyKey, idempotencyFingerprint: fingerprint, createdBy: reviewerId,
    }).onConflictDoNothing().returning();
    if (inserted) {
      if (body.data.status === "Needs revision") await appendModuleRevisionState(tx, evidence.moduleId, evidence.learnerId, evidence.pathwayId, reviewerId);
      return inserted;
    }
    const [existing] = await tx.select().from(evidenceReviewsTable).where(and(
      eq(evidenceReviewsTable.evidenceId, evidence.id),
      eq(evidenceReviewsTable.reviewerId, reviewerId),
      eq(evidenceReviewsTable.idempotencyKey, body.data.idempotencyKey),
    )).limit(1);
    return existing;
  });
  if (!review) throw new Error("Evidence review was not recorded");
  if (review.idempotencyFingerprint !== fingerprint) { res.status(409).json({ error: "The idempotency key was already used with a different evidence review." }); return; }
  res.json(ReviewEvidenceByTrainerResponse.parse((await evidenceRecords(evidence.learnerId, evidence.pathwayId, context.baselineVersionId)).find((item) => item.id === evidence.id)));
});
export default router;