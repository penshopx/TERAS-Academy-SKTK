import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { CreateTrainerEvidenceTriageRunResponse, CreateTrainerIntelligenceRunResponse, GetTrainerDashboardResponse, GetTrainerReminderPreferenceHistoryResponse, GetTrainerReminderPreferencesResponse, GetTrainerReviewQueueResponse, OpenTrainerRemediationBody, OpenTrainerRemediationResponse, RecordDiagnosticRecommendationFollowUpBody, RecordDiagnosticRecommendationFollowUpParams, RecordDiagnosticRecommendationFollowUpResponse, ReviewEvidenceByTrainerBody, ReviewEvidenceByTrainerParams, ReviewEvidenceByTrainerResponse, ReviewPracticeAttemptBody, ReviewPracticeAttemptParams, ReviewPracticeAttemptResponse, UpdateTrainerReminderPreferencesBody, UpdateTrainerReminderPreferencesResponse } from "@workspace/api-zod";
import { db, diagnosticGapsTable, diagnosticProfilesTable, diagnosticRecommendationFollowUpsTable, diagnosticRecommendationsTable, diagnosticSafetyFlagsTable, evidenceReviewsTable, evidenceTable, gapEventsTable, gapsTable, learningRecordLinksTable, peopleTable, practiceAttemptsTable, practiceReviewsTable, practiceTasksTable, modulesTable, remediationActivitiesTable, remediationEventsTable, remediationPlansTable, trainerReminderPreferencesTable } from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { evidenceRecords, gapRecords, pathwayHasModule, remediationRecords, workspaceAssignmentContexts } from "../lib/teras";
import { authorizeWorkspaceRole } from "../lib/authorization";
import { learningNextAction } from "../lib/learning-transition";
import { latestPracticeReviewRows, latestPracticeReviews, practiceQueueState, recentPracticeReviewRows, scopedPracticeQueue, trainerBottlenecks } from "../lib/trainer-bottlenecks";
import { hasValidQuietHours, isValidIanaTimeZone, reminderDeliveryAvailability } from "../lib/trainer-follow-up-notifications";
import { createTrainerIntelligenceRun } from "../lib/trainer-intelligence";
import { createEvidenceTriageRun } from "../lib/evidence-triage";

const router: IRouter = Router();
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const FOLLOW_UP_DUE_SOON_DAYS = 7;
const TRAINER_REVIEW_HISTORY_LIMIT = 50;
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
  const validQuietHours = hasValidQuietHours(preferences);
  return {
    ...preferences,
    quietHoursStart: validQuietHours ? preferences.quietHoursStart : null,
    quietHoursEnd: validQuietHours ? preferences.quietHoursEnd : null,
    ...reminderDeliveryAvailability(new Date(), preferences),
  };
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
  const { contexts, tasks, modules, selectedByContext, attempts, latestReviews, pendingByContext } = await scopedPracticeQueue(trainerId);
  const items = await Promise.all(contexts.map(async (context, index) => {
    const selected = selectedByContext[index]!;
    const pathwayModules = modules.filter((module) => (module.pathwayId === context.pathway.id || selected.has(module.id)) && module.programId === context.program.id);
    const pendingAttempts = pendingByContext[index]!;
    const evidence = await evidenceRecords(context.learner.id, context.pathway.id, context.baselineVersionId);
    return [
      ...evidence.filter((item) => item.status !== "Valid").map((item) => ({ id: item.id, kind: "Evidence", learnerId: context.learner.id, learnerName: context.learner.name, moduleName: item.moduleName, pathwayId: context.pathway.id, pathwayName: context.pathway.name, title: item.title, status: item.status, priority: item.moduleId === "m03" ? "Critical" : "High", updatedAt: item.submittedAt })),
      ...pendingAttempts.map((attempt) => {
        const state = practiceQueueState(attempt, latestReviews)!;
        return { id: attempt.id, kind: "Practice", learnerId: context.learner.id, learnerName: context.learner.name, moduleName: pathwayModules.find((module) => module.id === tasks.find((task) => task.id === attempt.taskId)?.moduleId)?.name ?? "Module", pathwayId: context.pathway.id, pathwayName: context.pathway.name, title: "Practice attempt", status: state.status, priority: "Normal", updatedAt: state.updatedAt };
      }),
    ];
  }));
  return { contexts, items: items.flat(), attempts, tasks };
}

async function diagnosticFollowUps(contexts: Awaited<ReturnType<typeof workspaceAssignmentContexts>>) {
  const [followUps, people] = await Promise.all([
    db.select({
      id: diagnosticRecommendationFollowUpsTable.id,
      recommendationId: diagnosticRecommendationFollowUpsTable.recommendationId,
      trainerId: diagnosticRecommendationFollowUpsTable.trainerId,
      status: diagnosticRecommendationFollowUpsTable.status,
      targetAt: diagnosticRecommendationFollowUpsTable.targetAt,
      note: diagnosticRecommendationFollowUpsTable.note,
      createdAt: diagnosticRecommendationFollowUpsTable.createdAt,
    }).from(diagnosticRecommendationFollowUpsTable),
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
  const { contexts, items, attempts, tasks } = await queue(trainerId);
  const evidenceScopes = contexts.map((context) => and(
    eq(evidenceTable.learnerId, context.learner.id),
    eq(evidenceTable.pathwayId, context.pathway.id),
  ));
  const allEvidence = evidenceScopes.length
    ? await db.select().from(evidenceTable).where(or(...evidenceScopes))
    : [];
  const evidenceIds = allEvidence.map((item) => item.id);
  const attemptIds = attempts.map((attempt) => attempt.id);
  const [scoped, allEvidenceReviews, allPracticeReviews, people] = await Promise.all([
    Promise.all(contexts.map(async (context) => ({ evidence: await evidenceRecords(context.learner.id, context.pathway.id, context.baselineVersionId), gaps: await gapRecords(context.learner.id, context.pathway.id), plans: await remediationRecords(context.learner.id, context.pathway.id) }))),
    evidenceIds.length
      ? db.select().from(evidenceReviewsTable)
        .where(inArray(evidenceReviewsTable.evidenceId, evidenceIds))
        .orderBy(desc(evidenceReviewsTable.createdAt), desc(evidenceReviewsTable.id))
        .limit(TRAINER_REVIEW_HISTORY_LIMIT)
      : [],
    recentPracticeReviewRows(attemptIds, TRAINER_REVIEW_HISTORY_LIMIT),
    db.select().from(peopleTable),
  ]);
  const [trainer] = await db.select().from(peopleTable).where(eq(peopleTable.id, trainerId));
  const contextFor = (learnerId: string, pathwayId: string) => contexts.find((context) => context.learner.id === learnerId && context.pathway.id === pathwayId);
  const reviewerNames = new Map(people.map((person) => [person.id, person.name]));
  const evidenceById = new Map(allEvidence.map((item) => [item.id, item]));
  const attemptById = new Map(attempts.map((item) => [item.id, item]));
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const reviewHistory = [
    ...allEvidenceReviews.flatMap((review) => {
      const evidence = evidenceById.get(review.evidenceId); const context = evidence && contextFor(evidence.learnerId, evidence.pathwayId);
      return evidence && context ? [{ id: review.id, kind: "Evidence" as const, learnerId: context.learner.id, learnerName: context.learner.name, pathwayId: context.pathway.id, pathwayName: context.pathway.name, subject: evidence.title, outcome: review.status, comment: review.comment ?? "", quality: review.quality, reviewer: review.reviewerId ? reviewerNames.get(review.reviewerId) ?? null : null, recordedAt: review.createdAt }] : [];
    }),
    ...allPracticeReviews.flatMap((review) => {
      const attempt = attemptById.get(review.attemptId); const context = attempt && contextFor(attempt.learnerId, attempt.pathwayId);
      return attempt && context ? [{ id: review.id, kind: "Practice" as const, learnerId: context.learner.id, learnerName: context.learner.name, pathwayId: context.pathway.id, pathwayName: context.pathway.name, subject: taskById.get(attempt.taskId)?.title ?? "Practice attempt", outcome: review.status, comment: review.feedback, quality: null, reviewer: review.reviewerId ? reviewerNames.get(review.reviewerId) ?? null : null, recordedAt: review.createdAt }] : [];
    }),
  ].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, TRAINER_REVIEW_HISTORY_LIMIT);
  const [bottlenecks, diagnosticFollowUpItems] = await Promise.all([trainerBottlenecks(contexts), diagnosticFollowUps(contexts)]);
  res.json(GetTrainerDashboardResponse.parse({ trainer, assignedLearnerCount: new Set(contexts.map((context) => context.learner.id)).size, pendingFeedbackCount: items.filter((item) => item.kind === "Practice").length, pendingEvidenceCount: scoped.flatMap((item) => item.evidence).filter((item) => item.status === "Under review").length, activeRemediationCount: scoped.flatMap((item) => item.plans).filter((item) => item.status !== "Completed").length, blockedLearnerCount: new Set(contexts.filter((context, index) => scoped[index]!.gaps.some((gap) => gap.severity === "Critical" && gap.status !== "Resolved")).map((context) => context.learner.id)).size, bottlenecks, diagnosticFollowUps: diagnosticFollowUpItems, recentActivity: items, reviewHistory }));
});
router.post("/trainer/intelligence/runs", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  if (req.body && Object.keys(req.body).length > 0) { res.status(400).json({ error: "Trainer intelligence accepts no request fields." }); return; }
  const result = await createTrainerIntelligenceRun(trainerId);
  res.json(CreateTrainerIntelligenceRunResponse.parse(result));
});
router.post("/trainer/evidence-triage/runs", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  if (req.body && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
    res.status(400).json({ error: "Evidence triage accepts no request fields." }); return;
  }
  const result = await createEvidenceTriageRun(trainerId);
  res.json(CreateTrainerEvidenceTriageRunResponse.parse(result));
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
  if (!isValidIanaTimeZone(body.data.timeZone)) { res.status(400).json({ error: "Time zone must be a valid IANA time zone" }); return; }
  if ((body.data.quietHoursStart === null) !== (body.data.quietHoursEnd === null)) {
    res.status(400).json({ error: "Quiet hours start and end must both be set or both be empty" });
    return;
  }
  if (
    body.data.quietHoursStart !== null
    && body.data.quietHoursStart === body.data.quietHoursEnd
    && !body.data.confirmFullDayQuietHours
  ) {
    res.status(400).json({
      error: "Equal quiet-hours start and end pause reminders for the full 24 hours. Set confirmFullDayQuietHours to true to confirm.",
    });
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
router.post("/trainer/remediation", async (req, res): Promise<void> => {
  const body = OpenTrainerRemediationBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  const input = body.data;
  const fingerprint = reviewFingerprint({ ...input, idempotencyKey: undefined });
  const result = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`);
    const [profile] = await tx.select().from(diagnosticProfilesTable).where(eq(diagnosticProfilesTable.id, input.diagnosticProfileId)).limit(1);
    const [diagnosticGap] = await tx.select().from(diagnosticGapsTable).where(eq(diagnosticGapsTable.id, input.diagnosticGapId)).limit(1);
    const [recommendation] = await tx.select().from(diagnosticRecommendationsTable).where(eq(diagnosticRecommendationsTable.id, input.diagnosticRecommendationId)).limit(1);
    if (!profile || !diagnosticGap || !recommendation || profile.pathwayId === null) return { error: "Diagnostic chain not found" as const, status: 404 as const };
    if (profile.pathwayId === null || profile.learnerId === null || diagnosticGap.profileId !== profile.id || recommendation.profileId !== profile.id ||
      diagnosticGap.competencyUnitId !== recommendation.competencyUnitId || recommendation.moduleId !== input.moduleId) {
      return { error: "Diagnostic references do not form one learner pathway module chain" as const, status: 409 as const };
    }
    const contexts = await workspaceAssignmentContexts(trainerId, "trainer");
    const context = contexts.find(item => item.learner.id === profile.learnerId && item.pathway.id === profile.pathwayId);
    if (!context) return { error: "Learner is outside the trainer's assigned active pathway" as const, status: 403 as const };
    if (context.pathway.purpose !== "capability-development") return { error: "Operational remediation opening is limited to Capability Development" as const, status: 409 as const };
    const [module] = await tx.select().from(modulesTable).where(and(eq(modulesTable.id, input.moduleId), eq(modulesTable.programId, context.program.id))).limit(1);
    if (!module || module.pathwayId !== context.pathway.id) return { error: "Module is outside the active pathway" as const, status: 409 as const };
    const [existing] = await tx.select().from(remediationEventsTable).where(eq(remediationEventsTable.idempotencyKey, input.idempotencyKey)).limit(1);
    if (existing) {
      if (existing.idempotencyFingerprint !== fingerprint) return { error: "The idempotency key was already used with a different remediation" as const, status: 409 as const };
      const [existingActivity] = await tx.select().from(remediationActivitiesTable).where(eq(remediationActivitiesTable.id, existing.activityId)).limit(1);
      const [existingPlan] = existingActivity ? await tx.select().from(remediationPlansTable).where(eq(remediationPlansTable.id, existingActivity.planId)).limit(1) : [];
      const [existingGap] = existingPlan ? await tx.select().from(gapsTable).where(eq(gapsTable.id, existingPlan.gapId)).limit(1) : [];
      return { value: { gapId: existingGap?.id, remediationPlanId: existingPlan?.id, remediationActivityId: existingActivity?.id, learnerId: profile.learnerId, pathwayId: profile.pathwayId, moduleId: input.moduleId, diagnosticProfileId: profile.id, diagnosticGapId: diagnosticGap.id, diagnosticRecommendationId: recommendation.id, status: "Open" as const }, statusCode: 200 as const };
    }
    const gapId = `gap-${crypto.randomUUID()}`, planId = `remediation-${crypto.randomUUID()}`, activityId = `remediation-activity-${crypto.randomUUID()}`;
    await tx.insert(gapsTable).values({ id: gapId, learnerId: profile.learnerId, pathwayId: profile.pathwayId, moduleId: input.moduleId, capability: recommendation.title, criterion: diagnosticGap.competencyUnitId, severity: "Moderate", priority: "High", diagnosis: "Diagnostic chain requires operational remediation", gate: "Capability development", recommendedAction: input.title, createdBy: trainerId });
    await tx.insert(remediationPlansTable).values({ id: planId, gapId, title: input.title, description: input.description, dueLabel: input.dueLabel, createdBy: trainerId });
    await tx.insert(remediationActivitiesTable).values({ id: activityId, planId, title: input.activityTitle, description: input.activityDescription, type: input.activityType, createdBy: trainerId });
    await tx.insert(gapEventsTable).values({ id: `gap-event-${crypto.randomUUID()}`, gapId, status: "Open", createdBy: trainerId });
    await tx.insert(remediationEventsTable).values({ id: `remediation-event-${crypto.randomUUID()}`, activityId, status: "Open", idempotencyKey: input.idempotencyKey, idempotencyFingerprint: fingerprint, createdBy: trainerId });
    return { value: { gapId, remediationPlanId: planId, remediationActivityId: activityId, learnerId: profile.learnerId, pathwayId: profile.pathwayId, moduleId: input.moduleId, diagnosticProfileId: profile.id, diagnosticGapId: diagnosticGap.id, diagnosticRecommendationId: recommendation.id, status: "Open" as const }, statusCode: 201 as const };
  });
  if ("error" in result) { res.status(result.status ?? 409).json({ error: result.error }); return; }
  res.status(result.statusCode).json(OpenTrainerRemediationResponse.parse(result.value));
});
export default router;