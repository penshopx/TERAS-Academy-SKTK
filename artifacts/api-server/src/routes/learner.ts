import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { CompleteRemediationActivityBody, CompleteRemediationActivityParams, CompleteRemediationActivityResponse, CompleteRemediationParams, CompleteRemediationResponse, CreateEvidenceBody, CreateEvidenceResponse, CreatePracticeAttemptBody, CreatePracticeAttemptParams, CreatePracticeAttemptResponse, GetCapabilityPassportResponse, GetLearnerDashboardResponse, GetLearnerJourneyResponse, GetLearnerLearningPlanResponse, GetLearnerReadinessResponse, ListEvidenceResponse, ListGapsResponse, ListRemediationResponse, SelectLearnerPathwayBody, SelectLearnerPathwayResponse } from "@workspace/api-zod";
import { db, assessmentAttemptsTable, assessmentsTable, enrollmentPathwayEventsTable, evidenceReviewsTable, evidenceTable, learningTransitionEventsTable, learningRecordLinksTable, learningActivitiesTable, lessonsTable, courseModulesTable, modulesTable, pathwaysTable, practiceAttemptsTable, practiceTasksTable, reassessmentLinksTable, remediationActivitiesTable, remediationEventsTable, remediationPlansTable, diagnosticSessionsTable, diagnosticProfilesTable, diagnosticGapsTable, diagnosticRecommendationsTable, diagnosticSafetyFlagsTable, gapsTable, readinessEventsTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { baselineForModule, catalogue, evidenceRecords, gapRecords, learnerContext, moduleSummary, pathwayHasModule, pathwaySummary, progressByModule, readiness, remediationRecords, selectedBaselineModuleIds, terminalPortfolioForPathway } from "../lib/teras";
import { authorizeLearner } from "../lib/authorization";
import { learningNextAction, transitionLearningState, type LearningState, type LearningTransitionResult } from "../lib/learning-transition";
const router: IRouter = Router(); const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
function bad(req: any, res: any, error: string) { req.log.warn({ error }, "Invalid request"); res.status(400).json({ error }); }
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopedIdempotencyKey = (operation: string, learnerId: string, key: string) => `${operation}:${digest({ learnerId, key })}`;
function idempotencyConflict(res: any) {
  res.status(409).json({
    error: "IDEMPOTENCY_KEY_REUSED",
    message: "The idempotency key was already used with a different payload.",
  });
}
class RejectedLearningTransition extends Error {
  constructor(readonly result: Extract<LearningTransitionResult, { ok: false }>) {
    super(result.value.message);
  }
}
async function learningWrite<T>(write: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  try {
    return await db.transaction(write);
  } catch (error) {
    if (error instanceof RejectedLearningTransition) return { kind: "rejected" as const, transition: error.result };
    throw error;
  }
}
async function currentLearningState(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  learnerId: string,
  pathwayId: string,
  activityId: string,
) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${learnerId}:${pathwayId}:${activityId}`}))`);
  const [latest] = await tx.select({ toState: learningTransitionEventsTable.toState })
    .from(learningTransitionEventsTable)
    .where(and(
      eq(learningTransitionEventsTable.activityId, activityId),
      eq(learningTransitionEventsTable.learnerId, learnerId),
      eq(learningTransitionEventsTable.pathwayId, pathwayId),
    ))
    .orderBy(desc(learningTransitionEventsTable.createdAt), desc(learningTransitionEventsTable.id))
    .limit(1);
  return (latest?.toState ?? "NOT_STARTED") as LearningState;
}
async function pathwayTimeline(learnerId: string) {
  const context = await learnerContext(learnerId);
  const [pathwayEvents, pathways] = await Promise.all([
    db.select().from(enrollmentPathwayEventsTable).where(eq(enrollmentPathwayEventsTable.enrollmentId, context.enrollment.id)).orderBy(enrollmentPathwayEventsTable.sequence),
    db.select().from(pathwaysTable),
  ]);
  const pathwayIds = [...new Set([context.enrollment.pathwayId, context.pathway.id, ...pathwayEvents.map(event => event.pathwayId)])];
  const [diagnosticSessions, diagnosticProfiles, diagnosticGaps, diagnosticRecommendations, transitions, learningLinks, practices, evidence, reviews, assessmentAttempts, reassessmentLinks, remediationEvents, remediationActivities, remediationPlans, gaps, readinessEvents] = await Promise.all([
    db.select().from(diagnosticSessionsTable).where(and(eq(diagnosticSessionsTable.learnerId, learnerId), inArray(diagnosticSessionsTable.pathwayId, pathwayIds))),
    db.select().from(diagnosticProfilesTable).where(and(eq(diagnosticProfilesTable.learnerId, learnerId), inArray(diagnosticProfilesTable.pathwayId, pathwayIds))),
    db.select().from(diagnosticGapsTable),
    db.select().from(diagnosticRecommendationsTable),
    db.select().from(learningTransitionEventsTable).where(and(eq(learningTransitionEventsTable.learnerId, learnerId), inArray(learningTransitionEventsTable.pathwayId, pathwayIds))),
    db.select().from(learningRecordLinksTable).where(and(eq(learningRecordLinksTable.learnerId, learnerId), inArray(learningRecordLinksTable.pathwayId, pathwayIds))),
    db.select().from(practiceAttemptsTable).where(and(eq(practiceAttemptsTable.learnerId, learnerId), inArray(practiceAttemptsTable.pathwayId, pathwayIds))),
    db.select().from(evidenceTable).where(and(eq(evidenceTable.learnerId, learnerId), inArray(evidenceTable.pathwayId, pathwayIds))),
    db.select().from(evidenceReviewsTable),
    db.select().from(assessmentAttemptsTable).where(and(eq(assessmentAttemptsTable.learnerId, learnerId), inArray(assessmentAttemptsTable.pathwayId, pathwayIds))),
    db.select().from(reassessmentLinksTable).where(and(eq(reassessmentLinksTable.learnerId, learnerId), inArray(reassessmentLinksTable.pathwayId, pathwayIds))),
    db.select().from(remediationEventsTable),
    db.select().from(remediationActivitiesTable),
    db.select().from(remediationPlansTable),
    db.select().from(gapsTable).where(and(eq(gapsTable.learnerId, learnerId), inArray(gapsTable.pathwayId, pathwayIds))),
    db.select().from(readinessEventsTable).where(and(eq(readinessEventsTable.enrollmentId, context.enrollment.id), inArray(readinessEventsTable.pathwayId, pathwayIds))),
  ]);
  const map = new Map(pathways.map(pathway => [pathway.id, pathway]));
  const original = map.get(context.enrollment.pathwayId) ?? context.pathway;
  type TimelineRecord = { id: string; pathwayId: string; label: string; description: string; status: string; date: Date; href: string | null; refs?: Record<string, string[]> };
  const records: TimelineRecord[] = [{
    id: "pathway-enrol",
    pathwayId: original.id,
    label: "Pathway enrollment",
    description: `Enrolled on ${original.name}.`,
    status: "Complete",
    date: context.enrollment.createdAt,
    href: "/programs/solar-pv-tech",
  }];
  records.push(...pathwayEvents.map(event => ({
    id: `pathway-${event.id}`, pathwayId: event.pathwayId, label: "Pathway selected",
    description: `Activated ${map.get(event.pathwayId)?.name ?? "capability pathway"}.`,
    status: "Complete", date: event.createdAt, href: "/programs/solar-pv-tech",
  })));
  const add = (record: TimelineRecord) => records.push(record);
  const diagnosticRefsFor = (links: typeof learningLinks) => {
    const values = (key: "diagnosticProfileId" | "diagnosticGapId" | "diagnosticRecommendationId") =>
      [...new Set(links.flatMap(link => typeof link.metadata[key] === "string" ? [link.metadata[key] as string] : []))];
    return {
      diagnosticProfileIds: values("diagnosticProfileId"),
      diagnosticGapIds: values("diagnosticGapId"),
      diagnosticRecommendationIds: values("diagnosticRecommendationId"),
    };
  };
  const diagnosticRefsForTransitions = (events: typeof transitions) => {
    const values = (key: "diagnosticProfileId" | "diagnosticGapId" | "diagnosticRecommendationId") =>
      [...new Set(events.flatMap(event => {
        const references = event.metadata.references;
        return references && typeof references === "object" && typeof (references as Record<string, unknown>)[key] === "string"
          ? [(references as Record<string, string>)[key]!]
          : [];
      }))];
    return {
      diagnosticProfileIds: values("diagnosticProfileId"),
      diagnosticGapIds: values("diagnosticGapId"),
      diagnosticRecommendationIds: values("diagnosticRecommendationId"),
    };
  };
  for (const session of diagnosticSessions) {
    const profile = diagnosticProfiles.find(candidate => candidate.sessionId === session.id);
    const profileGaps = profile ? diagnosticGaps.filter(candidate => candidate.profileId === profile.id) : [];
    const profileRecommendations = profile ? diagnosticRecommendations.filter(candidate => candidate.profileId === profile.id) : [];
    if (session.status === "completed" && session.completedAt) add({
      id: `diagnostic-${session.id}`, pathwayId: session.pathwayId, label: "Diagnostic completed",
      description: "Persisted diagnostic responses established the learner capability baseline and core gaps.",
      status: "Complete", date: session.completedAt, href: "/diagnostic",
      refs: {
        diagnosticSessionIds: [session.id],
        diagnosticProfileIds: profile ? [profile.id] : [],
        diagnosticGapIds: profileGaps.map(gap => gap.id),
        diagnosticRecommendationIds: profileRecommendations.map(recommendation => recommendation.id),
      },
    });
  }
  for (const event of transitions) {
    const links = learningLinks.filter(link => link.metadata.transitionEventId === event.id);
    add({
    id: `learning-${event.id}`, pathwayId: event.pathwayId, label: `Learning: ${event.toState}`,
    description: event.reason, status: event.toState === "READY" ? "Complete" : "Recorded", date: event.createdAt,
    href: "/learning", refs: { learningTransitionEventIds: [event.id], ...diagnosticRefsFor(links) },
  });
  }
  for (const attempt of practices) add({
    id: `practice-${attempt.id}`, pathwayId: attempt.pathwayId, label: "Practice attempt submitted",
    description: attempt.outputSummary, status: attempt.status, date: attempt.createdAt, href: "/practice",
      refs: { practiceAttemptIds: [attempt.id], ...diagnosticRefsFor(learningLinks.filter(link => link.practiceAttemptId === attempt.id)) },
  });
  for (const item of evidence) {
    add({ id: `evidence-${item.id}`, pathwayId: item.pathwayId, label: "Evidence submitted",
      description: item.title, status: "Recorded", date: item.createdAt, href: "/evidence",
      refs: { evidenceIds: [item.id], ...diagnosticRefsFor(learningLinks.filter(link => link.evidenceId === item.id)) } });
    for (const review of reviews.filter(candidate => candidate.evidenceId === item.id)) add({
      id: `evidence-review-${review.id}`, pathwayId: item.pathwayId, label: "Evidence review",
      description: review.comment ?? `Evidence review recorded as ${review.status}.`, status: review.status,
      date: review.createdAt, href: "/evidence", refs: {
        evidenceIds: [item.id],
        evidenceReviewIds: [review.id],
        ...diagnosticRefsFor(learningLinks.filter(link => link.evidenceReviewId === review.id || link.evidenceId === item.id)),
      },
    });
  }
  const reassessmentByAttempt = new Map(reassessmentLinks.map(link => [link.reassessmentAttemptId, link]));
  for (const attempt of assessmentAttempts) {
    const reassessment = reassessmentByAttempt.get(attempt.id);
    add({
    id: `assessment-${attempt.id}`, pathwayId: attempt.pathwayId, label: reassessment ? "Reassessment attempt" : "Assessment attempt",
    description: attempt.decision ?? "Assessment attempt recorded.", status: attempt.status, date: attempt.createdAt,
    href: "/assessments", refs: reassessment
      ? {
          assessmentAttemptIds: [attempt.id],
          reassessmentAttemptIds: [attempt.id],
          gapIds: [reassessment.originalGapId],
          remediationPlanIds: [reassessment.remediationPlanId],
          practiceAttemptIds: [reassessment.practiceAttemptId],
          evidenceIds: [reassessment.evidenceId],
          ...diagnosticRefsForTransitions(transitions.filter(event => {
            const references = event.metadata.references;
            return references && typeof references === "object" &&
              (references as Record<string, unknown>).reassessmentAttemptId === attempt.id;
          })),
        }
      : {
          assessmentAttemptIds: [attempt.id],
          ...diagnosticRefsForTransitions(transitions.filter(event => {
            const references = event.metadata.references;
            return references && typeof references === "object" && (
              (references as Record<string, unknown>).reassessmentAttemptId === attempt.id ||
              (references as Record<string, unknown>).previousAssessmentAttemptId === attempt.id
            );
          })),
        },
  });
  }
  for (const event of remediationEvents) {
    const activity = remediationActivities.find(candidate => candidate.id === event.activityId);
    const plan = activity && remediationPlans.find(candidate => candidate.id === activity.planId);
    const gap = plan && gaps.find(candidate => candidate.id === plan.gapId);
    if (plan && gap) add({
      id: `remediation-${event.id}`, pathwayId: gap.pathwayId, label: "Remediation",
      description: `${plan.title}: ${activity?.title ?? "activity"} recorded as ${event.status}.`, status: event.status,
      date: event.createdAt, href: "/remediation", refs: { gapIds: [gap.id], remediationPlanIds: [plan.id], remediationEventIds: [event.id], ...diagnosticRefsFor(learningLinks.filter(link => link.remediationPlanId === plan.id)) },
    });
  }
  for (const event of readinessEvents) {
    const gateSnapshot = event.inputEvidence.gates?.find(gate => gate.gateId === event.gateId);
    add({
      id: `readiness-${event.id}`, pathwayId: event.pathwayId, label: "Readiness evaluated",
      description: event.decisionReason, status: event.status, date: event.evaluatedAt, href: "/readiness",
      refs: {
        readinessEventIds: [event.id],
        gateIds: [event.gateId],
        learningRecordLinkIds: gateSnapshot?.learningRecordLinkIds ?? [],
        diagnosticProfileIds: gateSnapshot?.diagnosticProfileIds ?? [],
        diagnosticGapIds: gateSnapshot?.diagnosticGapIds ?? [],
        diagnosticRecommendationIds: gateSnapshot?.diagnosticRecommendationIds ?? [],
      },
    });
  }
  records.sort((left, right) => left.date.getTime() - right.date.getTime() || left.id.localeCompare(right.id));
  return { context, steps: records.map(record => ({ ...record, pathwayName: map.get(record.pathwayId)?.name ?? "Unknown pathway", causalReferences: record.refs ?? {} })) };
}
async function diagnosticView(learnerId: string) {
  const context = await learnerContext(learnerId);
  const [session] = await db.select().from(diagnosticSessionsTable)
    .where(and(eq(diagnosticSessionsTable.learnerId, learnerId), eq(diagnosticSessionsTable.pathwayId, context.pathway.id)))
    .orderBy(desc(diagnosticSessionsTable.createdAt))
    .limit(1);
  if (!session) return { context, attempt: null };
  const [profile] = await db.select().from(diagnosticProfilesTable).where(eq(diagnosticProfilesTable.sessionId, session.id)).limit(1);
  const [gaps, safetyFlags] = profile ? await Promise.all([
    db.select().from(diagnosticGapsTable).where(eq(diagnosticGapsTable.profileId, profile.id)),
    db.select().from(diagnosticSafetyFlagsTable).where(eq(diagnosticSafetyFlagsTable.profileId, profile.id)),
  ]) : [[], []];
  const dimensionScores = profile ? Object.values(profile.dimensionSummaries).filter((value): value is number => typeof value === "number") : [];
  const result = profile ? {
    baselineScore: dimensionScores.length ? Math.round(dimensionScores.reduce((sum, value) => sum + value, 0) / dimensionScores.length) : 0,
    gaps: gaps.map(gap => gap.diagnosis),
    safetyBlockers: safetyFlags.filter(flag => flag.blocking).map(flag => flag.detail),
    blocked: safetyFlags.some(flag => flag.blocking),
  } : null;
  return { context, attempt: { ...session, completedAt: session.completedAt, result } };
}
router.get("/evidence", async (req, res): Promise<void> => { const learnerId = await authorizeLearner(req, res); if (!learnerId) return; res.json(ListEvidenceResponse.parse(await evidenceRecords(learnerId))); });
router.post("/learner/pathway", async (req, res): Promise<void> => { const parsed = SelectLearnerPathwayBody.safeParse(req.body); if (!parsed.success) { bad(req, res, parsed.error.message); return; } const learnerId = await authorizeLearner(req, res); if (!learnerId) return; const context = await learnerContext(learnerId); const [pathway] = await db.select().from(pathwaysTable).where(eq(pathwaysTable.id, parsed.data.pathwayId)); if (!pathway || pathway.programId !== context.program.id) { res.status(404).json({ error: "Pathway not found for the enrolled program" }); return; } const event = await db.transaction(async (tx) => { await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${context.enrollment.id}))`); const [previous] = await tx.select().from(enrollmentPathwayEventsTable).where(eq(enrollmentPathwayEventsTable.enrollmentId, context.enrollment.id)).orderBy(desc(enrollmentPathwayEventsTable.sequence)).limit(1); return (await tx.insert(enrollmentPathwayEventsTable).values({ id: id("pathway-selection"), enrollmentId: context.enrollment.id, pathwayId: pathway.id, programId: context.program.id, sequence: (previous?.sequence ?? 0) + 1, createdBy: learnerId }).returning())[0]; }); const summary = await pathwaySummary(pathway.id); if (!summary) throw new Error(`Missing pathway catalogue for ${pathway.id}`); res.status(201).json(SelectLearnerPathwayResponse.parse({ pathway: summary, programId: pathway.programId, selectedAt: event.createdAt })); });
router.post("/evidence", async (req, res): Promise<void> => {
  const parsed = CreateEvidenceBody.safeParse(req.body);
  if (!parsed.success) { bad(req, res, parsed.error.message); return; }
  const learnerId = await authorizeLearner(req, res);
  if (!learnerId) return;
  const context = await learnerContext(learnerId);
  const [module, task, attempt] = await Promise.all([
    db.select().from(modulesTable).where(eq(modulesTable.id, parsed.data.moduleId)).then(rows => rows[0]),
    db.select().from(practiceTasksTable).where(eq(practiceTasksTable.id, parsed.data.taskId)).then(rows => rows[0]),
    db.select().from(practiceAttemptsTable).where(eq(practiceAttemptsTable.id, parsed.data.practiceAttemptId)).then(rows => rows[0]),
  ]);
  if (!module || !await pathwayHasModule(context.pathway.id, module.id) || !task || task.moduleId !== module.id || !attempt || attempt.taskId !== task.id || attempt.learnerId !== learnerId || attempt.pathwayId !== context.pathway.id) {
    res.status(404).json({ error: "Linked practice attempt was not found for the enrolled pathway" });
    return;
  }
  const transitionKey = scopedIdempotencyKey("evidence-submit", learnerId, parsed.data.idempotencyKey);
  const fingerprint = digest({
    moduleId: parsed.data.moduleId, taskId: parsed.data.taskId, title: parsed.data.title, type: parsed.data.type,
    description: parsed.data.description, fileName: parsed.data.fileName, sourceActivityId: parsed.data.sourceActivityId,
    practiceAttemptId: parsed.data.practiceAttemptId,
  });
  const result = await learningWrite(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${transitionKey}))`);
    const [duplicate] = await tx.select().from(learningTransitionEventsTable).where(eq(learningTransitionEventsTable.idempotencyKey, transitionKey)).limit(1);
    if (duplicate) {
      const metadata = duplicate.metadata as { idempotencyFingerprint?: string } | null;
      return metadata?.idempotencyFingerprint === fingerprint
        ? { kind: "duplicate" as const, entityId: duplicate.entityReference }
        : { kind: "conflict" as const };
    }
    const currentState = await currentLearningState(tx, learnerId, context.pathway.id, parsed.data.sourceActivityId);
    const record = { id: id("evidence"), learnerId, pathwayId: context.pathway.id, moduleId: parsed.data.moduleId, taskId: parsed.data.taskId, title: parsed.data.title, type: parsed.data.type, description: parsed.data.description, fileName: parsed.data.fileName, createdBy: learnerId };
    await tx.insert(evidenceTable).values(record);
    await tx.insert(evidenceReviewsTable).values({ id: id("evidence-review"), evidenceId: record.id, status: "Under review", quality: { valid: false, relevant: false, sufficient: false, traceable: false }, createdBy: learnerId });
    const transition = await transitionLearningState({
      currentState,
      targetState: "EVIDENCE_SUBMITTED",
      learnerId,
      pathwayId: context.pathway.id,
      programId: context.program.id,
      activityId: parsed.data.sourceActivityId,
      entityReference: record.id,
      reason: "Learner submitted evidence linked to a practice attempt",
      idempotencyKey: transitionKey,
      idempotencyFingerprint: fingerprint,
      references: { practiceAttemptId: attempt.id, evidenceId: record.id },
    }, { id: learnerId, role: "learner" }, tx);
    if (!transition.ok) throw new RejectedLearningTransition(transition);
    return { kind: "created" as const, entityId: record.id };
  });
  if (result.kind === "rejected") { res.status(result.transition.statusCode).json(result.transition.value); return; }
  if (result.kind === "conflict") { idempotencyConflict(res); return; }
  const response = (await evidenceRecords(learnerId)).find(item => item.id === result.entityId);
  if (!response) throw new Error(`Idempotent evidence result ${result.entityId} was not found`);
  res.status(result.kind === "duplicate" ? 200 : 201).json(CreateEvidenceResponse.parse(response));
});
router.post("/practice/tasks/:taskId/attempts", async (req, res): Promise<void> => {
  const params = CreatePracticeAttemptParams.safeParse(req.params), body = CreatePracticeAttemptBody.safeParse(req.body);
  if (!params.success) { bad(req, res, params.error.message); return; }
  if (!body.success) { bad(req, res, body.error.message); return; }
  const learnerId = await authorizeLearner(req, res);
  if (!learnerId) return;
  const context = await learnerContext(learnerId);
  const [task] = await db.select().from(practiceTasksTable).where(eq(practiceTasksTable.id, params.data.taskId));
  const [module] = task ? await db.select().from(modulesTable).where(eq(modulesTable.id, task.moduleId)) : [];
  if (!task || !module || !await pathwayHasModule(context.pathway.id, module.id)) { res.status(404).json({ error: "Practice task not found for the enrolled pathway" }); return; }
  const transitionKey = scopedIdempotencyKey("practice-attempt", learnerId, body.data.idempotencyKey);
  const fingerprint = digest({ taskId: task.id, reflection: body.data.reflection, outputSummary: body.data.outputSummary, sourceActivityId: body.data.sourceActivityId });
  const result = await learningWrite(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${transitionKey}))`);
    const [duplicate] = await tx.select().from(learningTransitionEventsTable).where(eq(learningTransitionEventsTable.idempotencyKey, transitionKey)).limit(1);
    if (duplicate) {
      const metadata = duplicate.metadata as { idempotencyFingerprint?: string } | null;
      if (metadata?.idempotencyFingerprint !== fingerprint) return { kind: "conflict" as const };
      const [existing] = await tx.select().from(practiceAttemptsTable).where(eq(practiceAttemptsTable.id, duplicate.entityReference)).limit(1);
      if (!existing) throw new Error(`Idempotent practice result ${duplicate.entityReference} was not found`);
      return { kind: "duplicate" as const, row: existing };
    }
    const currentState = await currentLearningState(tx, learnerId, context.pathway.id, body.data.sourceActivityId);
    const [row] = await tx.insert(practiceAttemptsTable).values({ id: id("practice"), taskId: task.id, learnerId, pathwayId: context.pathway.id, reflection: body.data.reflection, outputSummary: body.data.outputSummary, status: "Submitted", createdBy: learnerId }).returning();
    if (!row) throw new Error("Practice attempt insert returned no row");
    const transition = await transitionLearningState({
      currentState,
      targetState: "PRACTICE_IN_PROGRESS",
      learnerId,
      pathwayId: context.pathway.id,
      programId: context.program.id,
      activityId: body.data.sourceActivityId,
      entityReference: row.id,
      reason: "Learner created a pathway-scoped practice attempt",
      idempotencyKey: transitionKey,
      idempotencyFingerprint: fingerprint,
      references: { practiceAttemptId: row.id },
    }, { id: learnerId, role: "learner" }, tx);
    if (!transition.ok) throw new RejectedLearningTransition(transition);
    return { kind: "created" as const, row };
  });
  if (result.kind === "rejected") { res.status(result.transition.statusCode).json(result.transition.value); return; }
  if (result.kind === "conflict") { idempotencyConflict(res); return; }
  const row = result.row;
  res.status(result.kind === "duplicate" ? 200 : 201).json(CreatePracticeAttemptResponse.parse({
    id: row.id,
    taskId: row.taskId,
    submittedAt: row.createdAt,
    status: row.status,
    reflection: row.reflection,
    outputSummary: row.outputSummary,
    pathwayId: row.pathwayId,
    sourceActivityId: body.data.sourceActivityId,
     causalReferences: { practiceAttemptIds: [row.id], learningRecordLinkIds: [] },
    nextAction: learningNextAction("PRACTICE_IN_PROGRESS", { activityId: body.data.sourceActivityId, taskId: task.id, practiceAttemptId: row.id }),
    feedback: null,
  }));
});
router.get("/gaps", async (req, res): Promise<void> => { const learnerId = await authorizeLearner(req, res); if (!learnerId) return; res.json(ListGapsResponse.parse(await gapRecords(learnerId))); }); router.get("/remediation", async (req, res): Promise<void> => { const learnerId = await authorizeLearner(req, res); if (!learnerId) return; res.json(ListRemediationResponse.parse(await remediationRecords(learnerId))); });
router.post("/remediation/:remediationId/activities/:activityId/complete", async (req, res): Promise<void> => {
  const params = CompleteRemediationActivityParams.safeParse(req.params), body = CompleteRemediationActivityBody.safeParse(req.body);
  if (!params.success) { bad(req, res, params.error.message); return; }
  if (!body.success) { bad(req, res, body.error.message); return; }
  const learnerId = await authorizeLearner(req, res); if (!learnerId) return;
  const context = await learnerContext(learnerId);
  const plan = (await remediationRecords(learnerId, context.pathway.id)).find(item => item.id === params.data.remediationId);
  const activity = plan?.activities.find(item => item.id === params.data.activityId);
  if (!plan || !activity) { res.status(404).json({ error: "Remediation activity not found for the active pathway" }); return; }
  const key = `remediation-activity:${digest({ learnerId, key: body.data.idempotencyKey })}`;
  const fingerprint = digest({ learnerId, planId: plan.id, activityId: activity.id, completionNote: body.data.completionNote });
  const result = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    const [duplicate] = await tx.select().from(remediationEventsTable).where(eq(remediationEventsTable.idempotencyKey, key)).limit(1);
    if (duplicate) return duplicate.idempotencyFingerprint === fingerprint ? "duplicate" : "conflict";
    await tx.insert(remediationEventsTable).values({ id: id("remediation-event"), activityId: activity.id, status: "Completed", idempotencyKey: key, idempotencyFingerprint: fingerprint, createdBy: learnerId });
    return "created";
  });
  if (result === "conflict") { idempotencyConflict(res); return; }
  const updated = (await remediationRecords(learnerId, context.pathway.id)).find(item => item.id === plan.id);
  res.status(result === "created" ? 201 : 200).json(CompleteRemediationActivityResponse.parse(updated));
});
router.post("/remediation/:remediationId/complete", async (req, res): Promise<void> => { const parsed = CompleteRemediationParams.safeParse(req.params); if (!parsed.success) { bad(req, res, parsed.error.message); return; } const learnerId = await authorizeLearner(req, res); if (!learnerId) return; const context = await learnerContext(learnerId); const plan = (await remediationRecords(learnerId, context.pathway.id)).find((item) => item.id === parsed.data.remediationId); if (!plan) { res.status(404).json({ error: "Remediation plan not found" }); return; } const links = await db.select().from(reassessmentLinksTable).where(and(eq(reassessmentLinksTable.learnerId, learnerId), eq(reassessmentLinksTable.pathwayId, context.pathway.id), eq(reassessmentLinksTable.remediationPlanId, plan.id))); let causal: typeof links[number] | undefined, review: typeof evidenceReviewsTable.$inferSelect | undefined; for (const link of links) { const [attempt] = await db.select().from(assessmentAttemptsTable).where(eq(assessmentAttemptsTable.id, link.reassessmentAttemptId)); const [assessment] = attempt ? await db.select().from(assessmentsTable).where(eq(assessmentsTable.id, attempt.assessmentId)) : []; const [evidence] = await db.select().from(evidenceTable).where(eq(evidenceTable.id, link.evidenceId)); const [candidateReview] = await db.select().from(evidenceReviewsTable).where(eq(evidenceReviewsTable.evidenceId, link.evidenceId)).orderBy(desc(evidenceReviewsTable.createdAt)).limit(1); if (attempt?.decision === "Competent" && attempt.learnerId === learnerId && attempt.pathwayId === context.pathway.id && assessment?.moduleId === evidence?.moduleId && candidateReview?.status === "Valid" && Object.values(candidateReview.quality).every(Boolean)) { causal = link; review = candidateReview; break; } } const complete = plan.activities.every(activity => activity.status === "Completed") && causal && review; if (!complete) { req.log.warn({ remediationId: plan.id }, "Rejected remediation completion without recorded prerequisites"); res.status(409).json({ error: "REMEDIATION_PREREQUISITES_NOT_MET", message: "Complete every required remediation activity, re-practice, valid evidence review, and competent reassessment before closing this plan." }); return; } res.json(CompleteRemediationResponse.parse(plan)); });
router.get("/readiness", async (req, res): Promise<void> => { const learnerId = await authorizeLearner(req, res); if (!learnerId) return; res.json(GetLearnerReadinessResponse.parse(await readiness(await learnerContext(learnerId)))); });
router.get("/learner/journey", async (req, res): Promise<void> => {
  const learnerId = await authorizeLearner(req, res); if (!learnerId) return;
  const timeline = await pathwayTimeline(learnerId);
  res.json(GetLearnerJourneyResponse.parse(timeline.steps));
});
router.get("/learner/learning-plan", async (req, res): Promise<void> => {
  const learnerId = await authorizeLearner(req, res); if (!learnerId) return;
  const [context, source] = await Promise.all([learnerContext(learnerId), catalogue()]);
  const selected = await selectedBaselineModuleIds(context.pathway.id);
  const progress = await progressByModule(learnerId, context.pathway.id);
  const [links, profiles] = await Promise.all([
    db.select().from(learningRecordLinksTable).where(and(eq(learningRecordLinksTable.learnerId, learnerId), eq(learningRecordLinksTable.pathwayId, context.pathway.id))),
    db.select().from(diagnosticProfilesTable).where(and(eq(diagnosticProfilesTable.learnerId, learnerId), eq(diagnosticProfilesTable.pathwayId, context.pathway.id))).orderBy(desc(diagnosticProfilesTable.completedAt)).limit(1),
  ]);
  const diagnosticProfile = profiles[0];
  const [diagnosticGaps, diagnosticRecommendations] = diagnosticProfile
    ? await Promise.all([
        db.select().from(diagnosticGapsTable).where(eq(diagnosticGapsTable.profileId, diagnosticProfile.id)),
        db.select().from(diagnosticRecommendationsTable).where(eq(diagnosticRecommendationsTable.profileId, diagnosticProfile.id)),
      ])
    : [[], []];
  const linkActivityIds = [...new Set(links.map(link => link.activityId))];
  const activityModules = linkActivityIds.length
    ? await db.select({ activityId: learningActivitiesTable.id, moduleId: courseModulesTable.moduleId })
        .from(learningActivitiesTable)
        .innerJoin(lessonsTable, eq(lessonsTable.id, learningActivitiesTable.lessonId))
        .innerJoin(courseModulesTable, eq(courseModulesTable.id, lessonsTable.courseModuleId))
        .where(inArray(learningActivitiesTable.id, linkActivityIds))
    : [];
  const moduleIdByActivityId = new Map(activityModules.map(item => [item.activityId, item.moduleId]));
  res.json(GetLearnerLearningPlanResponse.parse(source.modules
    .filter((module) => selected.has(module.id) && progress(module.id).progress < 100)
    .sort((a, b) => a.sequence - b.sequence)
    .map((module, index) => {
      const baseline = baselineForModule(module.id, source);
      const contract = source.pathwayContracts.find(item => item.pathwayId === context.pathway.id && item.moduleId === (baseline?.moduleId ?? module.id));
      const moduleRecommendations = diagnosticRecommendations.filter(recommendation => recommendation.moduleId === module.id);
      const moduleCompetencyUnitIds = new Set(moduleRecommendations.flatMap(recommendation => recommendation.competencyUnitId ? [recommendation.competencyUnitId] : []));
      const moduleDiagnosticGaps = diagnosticGaps.filter(gap => moduleCompetencyUnitIds.has(gap.competencyUnitId));
      const moduleLinks = links.filter(link => moduleIdByActivityId.get(link.activityId) === module.id);
      return {
        id: `plan-${module.id}`,
        module: moduleSummary(module, progress(module.id).progress, progress(module.id).status, context.pathway.id, baseline, contract),
        priority: index === 0 ? "High" : "Normal",
        reason: "Continue pathway learning.",
        estimatedMinutes: 90,
        status: progress(module.id).status,
        causalReferences: {
          diagnosticProfileIds: diagnosticProfile ? [diagnosticProfile.id] : [],
          diagnosticGapIds: moduleDiagnosticGaps.map(gap => gap.id),
          diagnosticRecommendationIds: moduleRecommendations.map(recommendation => recommendation.id),
          learningRecordLinkIds: moduleLinks.map(link => link.id),
          outcomeIds: moduleLinks.flatMap(link => link.outcomeId ? [link.outcomeId] : []),
          practiceAttemptIds: moduleLinks.flatMap(link => link.practiceAttemptId ? [link.practiceAttemptId] : []),
          evidenceIds: moduleLinks.flatMap(link => link.evidenceId ? [link.evidenceId] : []),
          gapIds: moduleLinks.flatMap(link => link.gapId ? [link.gapId] : []),
          remediationPlanIds: moduleLinks.flatMap(link => link.remediationPlanId ? [link.remediationPlanId] : []),
          reassessmentAttemptIds: moduleLinks.flatMap(link => link.reassessmentAttemptId ? [link.reassessmentAttemptId] : []),
        },
      };
    })));
});
router.get("/learner/dashboard", async (req, res): Promise<void> => { const learnerId = await authorizeLearner(req, res); if (!learnerId) return; const [context, source] = await Promise.all([learnerContext(learnerId), catalogue()]); const { modules, tasks, enrollments } = source; const selected = await selectedBaselineModuleIds(context.pathway.id); const [view, gaps, evidence, progress, diagnostic] = await Promise.all([readiness(context), gapRecords(learnerId, context.pathway.id), evidenceRecords(learnerId, context.pathway.id), progressByModule(learnerId, context.pathway.id), diagnosticView(learnerId)]); const pathwayModules = modules.filter((module) => selected.has(module.id)).sort((a, b) => a.sequence - b.sequence); const current = pathwayModules.find((module) => progress(module.id).progress < 100) ?? pathwayModules[0]; const task = tasks.find((item) => item.moduleId === current.id); if (!current || !task) throw new Error(`Incomplete curriculum for ${context.pathway.name}`); const currentBaseline = baselineForModule(current.id, source); const currentContract = source.pathwayContracts.find(item => item.pathwayId === context.pathway.id && item.moduleId === (currentBaseline?.moduleId ?? current.id)); const result = diagnostic.attempt?.result as { baselineScore?: number; gaps?: string[]; safetyBlockers?: string[]; blocked?: boolean } | null; const diagnosticDone = diagnostic.attempt?.status === "completed"; res.json(GetLearnerDashboardResponse.parse({ learner: context.learner, program: { ...context.program, moduleCount: pathwayModules.length, learnerCount: new Set(enrollments.filter((item) => item.programId === context.program.id).map((item) => item.learnerId)).size }, pathway: view.pathway, capabilityProgress: Math.round(pathwayModules.reduce((sum, module) => sum + progress(module.id).progress, 0) / pathwayModules.length), readiness: view, currentLearning: moduleSummary(current, progress(current.id).progress, progress(current.id).status, context.pathway.id, currentBaseline, currentContract), currentPractice: { ...task, status: "Available" }, mainGap: gaps.find((gap) => gap.status !== "Resolved") ?? null, evidenceCounts: { total: evidence.length, valid: evidence.filter((item) => item.status === "Valid").length, underReview: evidence.filter((item) => item.status === "Under review").length, needsRevision: evidence.filter((item) => item.status === "Needs revision").length }, diagnostic: { status: diagnostic.attempt?.status ?? "not_started", score: diagnosticDone ? result?.baselineScore ?? 0 : null, topGaps: diagnosticDone ? result?.gaps?.slice(0, 3) ?? [] : [], safetyBlockers: diagnosticDone ? result?.safetyBlockers ?? [] : [], blocked: diagnosticDone ? Boolean(result?.blocked) : false }, nextAction: !diagnosticDone ? { title: diagnostic.attempt ? "Resume your diagnostic" : "Start your diagnostic", description: "Set your personal baseline before continuing pathway learning.", href: "/diagnostic", priority: "High" } : { title: `Continue ${current.code}`, description: result?.blocked ? "Resolve the critical safety blocker before practice." : "Continue your active pathway learning.", href: result?.blocked ? "/diagnostic/result" : `/modules/${current.id}`, priority: "High" } })); });
router.get("/passport", async (req, res): Promise<void> => {
  const learnerId = await authorizeLearner(req, res);
  if (!learnerId) return;
  const context = await learnerContext(learnerId);
  // Readiness persists the decision snapshot. Build the timeline afterwards so
  // a first passport request includes the exact decision it returns.
  const view = await readiness(context);
  const timeline = await pathwayTimeline(learnerId);
  const [attempts, assessments, modules, evidence, selected] = await Promise.all([
    db.select().from(assessmentAttemptsTable).where(and(
      eq(assessmentAttemptsTable.learnerId, learnerId),
      eq(assessmentAttemptsTable.pathwayId, timeline.context.pathway.id),
      eq(assessmentAttemptsTable.decision, "Competent"),
    )),
    db.select().from(assessmentsTable),
    db.select().from(modulesTable),
    evidenceRecords(learnerId, timeline.context.pathway.id),
    selectedBaselineModuleIds(timeline.context.pathway.id),
  ]);
  if (!view.pathway) throw new Error(`Missing pathway catalogue for ${timeline.context.pathway.id}`);
  const assessmentById = new Map(assessments.map((item) => [item.id, item]));
  const moduleById = new Map(modules.map((item) => [item.id, item]));
  const achievements = attempts.flatMap((attempt) => {
    const module = moduleById.get(assessmentById.get(attempt.assessmentId)?.moduleId ?? "");
    return module && selected.has(module.id) && module.programId === timeline.context.program.id
      ? [{
          id: `achievement-${attempt.id}`,
          capability: module.capability,
          level: "Internal evidence verified",
          program: timeline.context.program.name,
          pathway: timeline.context.pathway.name,
          achievedAt: attempt.createdAt,
          evidenceCount: evidence.filter((item) => item.moduleId === module.id).length,
          status: "Readiness record" as const,
        }]
      : [];
  });
  const terminalPortfolio = terminalPortfolioForPathway(timeline.context.pathway);
  res.json(GetCapabilityPassportResponse.parse({
    learner: timeline.context.learner,
    pathway: view.pathway,
    headline: `${terminalPortfolio} · ${view.pathway.name}`,
    subtitle: "A longitudinal record of verified practice and internal readiness.",
    terminalPortfolio,
    readinessDisclaimer: "Internal readiness-preparation information only. This is not an official competency decision or certification claim.",
    readiness: view,
    achievements,
    timeline: timeline.steps,
  }));
});
export default router;