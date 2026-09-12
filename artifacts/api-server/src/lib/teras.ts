import { and, desc, eq, inArray } from "drizzle-orm";
import { db, assessmentAttemptsTable, assessmentCriteriaTable, assessmentsTable, baselineModulesTable, courseModulesTable, criterionObservationsTable, enrollmentPathwayEventsTable, enrollmentsTable, evidenceRequirementsTable, evidenceReviewsTable, evidenceTable, gapEventsTable, gapsTable, learningActivitiesTable, learningBaselinesTable, legacyModuleMappingsTable, learningRecordLinksTable, lessonsTable, modulesTable, pathwayBaselineModulesTable, pathwayModuleContractsTable, pathwaysTable, peopleTable, practiceAttemptsTable, practiceTasksTable, programsTable, readinessEventsTable, readinessGatesTable, remediationActivitiesTable, remediationEventsTable, remediationPlansTable, reassessmentLinksTable } from "@workspace/db";
import type { BaselineModule, PathwayModuleContract } from "@workspace/db";
import { selectedBaselineModuleIdsFromVersion } from "./baseline-authoring";
export const DEMO_LEARNER = "learner-demo";
const latest = <T extends { createdAt: Date }, K extends string>(rows: T[], key: (row: T) => K) => { const result = new Map<K, T>(); for (const row of rows) if (!result.has(key(row)) || result.get(key(row))!.createdAt < row.createdAt) result.set(key(row), row); return result; };
export async function catalogue() {
  const [programs, paths, modules, tasks, requirements, assessments, gates, enrollments, baselines, baselineModules, pathwayBaselineModules, pathwayContracts, legacyMappings] = await Promise.all([
    db.select().from(programsTable), db.select().from(pathwaysTable), db.select().from(modulesTable),
    db.select().from(practiceTasksTable), db.select().from(evidenceRequirementsTable),
    db.select().from(assessmentsTable), db.select().from(readinessGatesTable), db.select().from(enrollmentsTable),
    db.select().from(learningBaselinesTable), db.select().from(baselineModulesTable),
    db.select().from(pathwayBaselineModulesTable), db.select().from(pathwayModuleContractsTable),
    db.select().from(legacyModuleMappingsTable),
  ]);
  return { programs, paths, modules, tasks, requirements, assessments, gates, enrollments, baselines, baselineModules, pathwayBaselineModules, pathwayContracts, legacyMappings };
}
type Catalogue = Awaited<ReturnType<typeof catalogue>>;
/** Canonical M modules are owned by Path A, but become operational in another
 * pathway only when that pathway has an explicit baseline selection. */
export async function selectedBaselineModuleIds(pathwayId: string, baselineVersionId?: string | null): Promise<Set<string>> {
  const pinned = await selectedBaselineModuleIdsFromVersion(pathwayId, baselineVersionId);
  if (pinned) return pinned;
  const rows = await db.select({ moduleId: baselineModulesTable.moduleId })
    .from(pathwayBaselineModulesTable)
    .innerJoin(baselineModulesTable, eq(pathwayBaselineModulesTable.baselineModuleId, baselineModulesTable.id))
    .where(eq(pathwayBaselineModulesTable.pathwayId, pathwayId));
  return new Set(rows.map(row => row.moduleId));
}
export async function pathwayHasModule(pathwayId: string, moduleId: string, baselineVersionId?: string | null): Promise<boolean> {
  const [module] = await db.select({ pathwayId: modulesTable.pathwayId }).from(modulesTable).where(eq(modulesTable.id, moduleId)).limit(1);
  if (module?.pathwayId === pathwayId) return true;
  return (await selectedBaselineModuleIds(pathwayId, baselineVersionId)).has(moduleId);
}
export async function pathwayHasActivity(pathwayId: string, activityId: string, baselineVersionId?: string | null): Promise<boolean> {
  const [row] = await db.select({ moduleId: courseModulesTable.moduleId })
    .from(learningActivitiesTable)
    .innerJoin(lessonsTable, eq(lessonsTable.id, learningActivitiesTable.lessonId))
    .innerJoin(courseModulesTable, eq(courseModulesTable.id, lessonsTable.courseModuleId))
    .where(eq(learningActivitiesTable.id, activityId))
    .limit(1);
  return Boolean(row && await pathwayHasModule(pathwayId, row.moduleId, baselineVersionId));
}
export const baselineForModule = (moduleId: string, catalogue: Pick<Catalogue, "baselineModules" | "legacyMappings">) => {
  const canonical = catalogue.baselineModules.find((baseline) => baseline.moduleId === moduleId);
  if (canonical) return canonical;
  const legacy = catalogue.legacyMappings.find((mapping) => mapping.legacyModuleId === moduleId);
  return legacy ? catalogue.baselineModules.find((baseline) => baseline.id === legacy.baselineModuleId) : undefined;
};
export const moduleSummary = (
  module: { id: string; pathwayId: string; code: string; name: string; capability: string; evidence: string },
  progress = 0,
  status = "Not started",
  contractPathwayId = module.pathwayId,
  baseline?: BaselineModule,
  pathwayContract?: PathwayModuleContract,
) => {
  return {
    ...module,
    pathwayId: contractPathwayId,
    progress,
    status,
    baseline: baseline ? { code: baseline.code, name: baseline.name, learningOutcome: baseline.learningOutcome, evidenceId: baseline.evidenceId } : null,
    pathwayContract: pathwayContract ? {
      pathwayId: contractPathwayId,
      assessmentId: pathwayContract.assessmentId,
      evidenceRequirementId: pathwayContract.evidenceRequirementId,
      gateCode: pathwayContract.gateCode,
      assessment: pathwayContract.assessment,
      evidence: pathwayContract.evidence,
      output: pathwayContract.output,
      kpi: pathwayContract.kpi,
      portfolio: pathwayContract.portfolio,
    } : null,
  };
};
export const profile = (person: { id: string; name: string; initials: string; role: string; organization: string | null }) => person;
export async function learnerContext(learnerId = DEMO_LEARNER) {
  const [enrollment] = await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.learnerId, learnerId)).orderBy(desc(enrollmentsTable.createdAt));
  const [learner] = await db.select().from(peopleTable).where(eq(peopleTable.id, learnerId));
  if (!enrollment || !learner) throw new Error(`Learner ${learnerId} has no valid enrollment`);
  const [program] = await db.select().from(programsTable).where(eq(programsTable.id, enrollment.programId));
  const [pathwayEvent] = await db.select().from(enrollmentPathwayEventsTable).where(eq(enrollmentPathwayEventsTable.enrollmentId, enrollment.id)).orderBy(desc(enrollmentPathwayEventsTable.sequence), desc(enrollmentPathwayEventsTable.createdAt), desc(enrollmentPathwayEventsTable.id)).limit(1);
  const [pathway] = await db.select().from(pathwaysTable).where(eq(pathwaysTable.id, pathwayEvent?.pathwayId ?? enrollment.pathwayId));
  if (!program || !pathway) throw new Error("Enrollment references missing catalogue records");
  return { enrollment, learner, program, pathway, baselineVersionId: pathwayEvent?.baselineVersionId ?? enrollment.baselineVersionId ?? null };
}
/** Current, active learner pathways explicitly assigned to a workspace actor.
 * This is deliberately enrollment-based rather than derived from a default learner. */
export async function workspaceAssignmentContexts(actorId: string, role: "trainer" | "assessor") {
  const [enrollments, learners, programs, pathways, pathwayEvents] = await Promise.all([
    db.select().from(enrollmentsTable).where(and(
      eq(role === "trainer" ? enrollmentsTable.trainerId : enrollmentsTable.assessorId, actorId),
      eq(enrollmentsTable.status, "active"),
    )),
    db.select().from(peopleTable),
    db.select().from(programsTable),
    db.select().from(pathwaysTable),
    db.select().from(enrollmentPathwayEventsTable),
  ]);
  const learnerById = new Map(learners.map((learner) => [learner.id, learner]));
  const programById = new Map(programs.map((program) => [program.id, program]));
  const pathwayById = new Map(pathways.map((pathway) => [pathway.id, pathway]));
  const latestPathwayEvent = new Map<string, typeof pathwayEvents[number]>();
  for (const event of pathwayEvents) {
    const current = latestPathwayEvent.get(event.enrollmentId);
    if (!current || event.sequence > current.sequence ||
      (event.sequence === current.sequence && event.createdAt > current.createdAt)) {
      latestPathwayEvent.set(event.enrollmentId, event);
    }
  }
  return enrollments.flatMap((enrollment) => {
    const pathway = pathwayById.get(latestPathwayEvent.get(enrollment.id)?.pathwayId ?? enrollment.pathwayId);
    const learner = learnerById.get(enrollment.learnerId);
    const program = programById.get(enrollment.programId);
    // Corrupt catalogue references must never broaden an actor's scope.
    return learner && program && pathway && pathway.programId === enrollment.programId
      ? [{ enrollment, learner, program, pathway, baselineVersionId: latestPathwayEvent.get(enrollment.id)?.baselineVersionId ?? enrollment.baselineVersionId ?? null }]
      : [];
  });
}
/** Resolves a specific active learner/pathway pair without letting the most
 * recently-created enrollment substitute a different pathway. */
export async function activeLearnerPathwayContext(learnerId: string, pathwayId: string) {
  const contexts = await Promise.all(
    (await db.select().from(enrollmentsTable).where(and(eq(enrollmentsTable.learnerId, learnerId), eq(enrollmentsTable.status, "active"))))
      .map(async (enrollment) => {
        const [learner, program, pathway, pathwayEvent] = await Promise.all([
          db.select().from(peopleTable).where(eq(peopleTable.id, learnerId)).then((rows) => rows[0]),
          db.select().from(programsTable).where(eq(programsTable.id, enrollment.programId)).then((rows) => rows[0]),
          db.select().from(pathwaysTable).where(eq(pathwaysTable.id, pathwayId)).then((rows) => rows[0]),
          db.select().from(enrollmentPathwayEventsTable).where(eq(enrollmentPathwayEventsTable.enrollmentId, enrollment.id)).orderBy(desc(enrollmentPathwayEventsTable.sequence), desc(enrollmentPathwayEventsTable.createdAt), desc(enrollmentPathwayEventsTable.id)).limit(1).then((rows) => rows[0]),
        ]);
        const activePathwayId = pathwayEvent?.pathwayId ?? enrollment.pathwayId;
        return learner && program && pathway && activePathwayId === pathwayId && pathway.programId === enrollment.programId
          ? { enrollment, learner, program, pathway, baselineVersionId: pathwayEvent?.baselineVersionId ?? enrollment.baselineVersionId ?? null }
          : null;
      }),
  );
  return contexts.find((context) => context !== null) ?? null;
}
export async function pathwaySummary(pathwayId: string, source?: Catalogue, baselineVersionId?: string | null) {
  const { paths, modules, gates, pathwayBaselineModules, pathwayContracts, baselineModules } = source ?? await catalogue();
  const pathway = paths.find((item) => item.id === pathwayId);
  if (!pathway) return null;
  const pathwayGates = gates.filter((gate) => gate.pathwayId === pathwayId).sort((a, b) => a.sequence - b.sequence).map(({ id, code, name, sequence, requirement }) => ({ id, code, name, sequence, requirement }));
  const selections = pathwayBaselineModules.filter((selection) => selection.pathwayId === pathwayId);
  const selectedBaselineIds = baselineVersionId
    ? await selectedBaselineModuleIds(pathwayId, baselineVersionId).then(moduleIds => new Set(baselineModules.filter(baseline => moduleIds.has(baseline.moduleId)).map(baseline => baseline.id)))
    : new Set(selections.map((selection) => selection.baselineModuleId));
  const selectedBaselineModules = baselineModules.filter((baseline) => selectedBaselineIds.has(baseline.id)).sort((a, b) => a.sequence - b.sequence);
  const contracts = pathwayContracts.filter((contract) => selectedBaselineModules.some((baseline) => baseline.moduleId === contract.moduleId));
  const firstContract = contracts[0];
  const terminalPortfolio = terminalPortfolioForPathway(pathway);
  return {
    ...pathway,
    moduleCount: modules.filter((module) => module.pathwayId === pathwayId).length,
    baselineModuleCount: selectedBaselineModules.length,
    gateCount: pathwayGates.length,
    gates: pathwayGates,
    contract: firstContract ? {
      assessment: firstContract.assessment,
      evidence: contracts.map((contract) => contract.evidence).join(", "),
      output: firstContract.portfolio,
      kpi: firstContract.kpi,
      portfolio: terminalPortfolio,
    } : undefined,
    terminalPortfolio,
  };
}
/** The portfolio is a pathway outcome, not a mutable progress label. */
export const terminalPortfolioForPathway = (pathway: { id: string; name: string; purpose?: string | null }) =>
  pathway.purpose === "capability-development" || /path[\s_-]*a/i.test(`${pathway.id} ${pathway.name}`)
    ? "Capability Portfolio"
    : "Certification Readiness Portfolio";
export async function progressByModule(learnerId = DEMO_LEARNER, pathwayId?: string) { const activePathwayId = pathwayId ?? (await learnerContext(learnerId)).pathway.id; const [attempts, assessments, practiceAttempts, evidence] = await Promise.all([db.select().from(assessmentAttemptsTable).where(and(eq(assessmentAttemptsTable.learnerId, learnerId), eq(assessmentAttemptsTable.pathwayId, activePathwayId))), db.select().from(assessmentsTable), db.select().from(practiceAttemptsTable).where(and(eq(practiceAttemptsTable.learnerId, learnerId), eq(practiceAttemptsTable.pathwayId, activePathwayId))), db.select().from(evidenceTable).where(and(eq(evidenceTable.learnerId, learnerId), eq(evidenceTable.pathwayId, activePathwayId)))]); const assessmentModules = new Map(assessments.map((assessment) => [assessment.id, assessment.moduleId])); const completed = new Set(attempts.filter((attempt) => attempt.decision === "Competent").map((attempt) => assessmentModules.get(attempt.assessmentId))); const practiced = new Set(practiceAttempts.map((attempt) => attempt.taskId.replace(/^task-/, ""))); const evidenced = new Set(evidence.map((item) => item.moduleId)); return (id: string) => completed.has(id) ? { progress: 100, status: "Complete" } : evidenced.has(id) ? { progress: 60, status: "In progress" } : practiced.has(id) ? { progress: 30, status: "In progress" } : { progress: 0, status: "Not started" }; }
export async function evidenceRecords(learnerId = DEMO_LEARNER, pathwayId?: string, baselineVersionId?: string | null) { const context = baselineVersionId === undefined || pathwayId === undefined ? await learnerContext(learnerId) : null; const activePathwayId = pathwayId ?? context!.pathway.id; const pin = baselineVersionId === undefined ? context!.baselineVersionId : baselineVersionId; const [evidence, reviews, modules, people, links, selected] = await Promise.all([db.select().from(evidenceTable), db.select().from(evidenceReviewsTable), db.select().from(modulesTable), db.select().from(peopleTable), db.select().from(learningRecordLinksTable).where(and(eq(learningRecordLinksTable.learnerId, learnerId), eq(learningRecordLinksTable.pathwayId, activePathwayId))), selectedBaselineModuleIds(activePathwayId, pin)]); const reviewMap = latest(reviews, (review) => review.evidenceId), moduleMap = new Map(modules.map((module) => [module.id, module])), personMap = new Map(people.map((person) => [person.id, person])), linkMap = latest(links.filter((link): link is typeof link & { evidenceId: string } => Boolean(link.evidenceId)), (link) => link.evidenceId); return evidence.filter((item) => item.learnerId === learnerId && item.pathwayId === activePathwayId && selected.has(item.moduleId)).map((item) => { const review = reviewMap.get(item.id), module = moduleMap.get(item.moduleId), link = linkMap.get(item.id); return { id: item.id, title: item.title, type: item.type, moduleId: item.moduleId, moduleName: module?.name ?? "Unknown module", taskId: item.taskId, pathwayId: item.pathwayId, sourceActivityId: link?.activityId ?? null, practiceAttemptId: link?.practiceAttemptId ?? null, description: item.description, status: review?.status ?? "Under review", submittedAt: item.createdAt, reviewer: review?.reviewerId ? personMap.get(review.reviewerId)?.name ?? null : null, reviewerComment: review?.comment ?? null, fileName: item.fileName, quality: review?.quality ?? { valid: false, relevant: false, sufficient: false, traceable: false }, causalReferences: { learningRecordLinkIds: link ? [link.id] : [], practiceAttemptIds: link?.practiceAttemptId ? [link.practiceAttemptId] : [], evidenceReviewIds: review ? [review.id] : [], gapIds: link?.gapId ? [link.gapId] : [], remediationPlanIds: link?.remediationPlanId ? [link.remediationPlanId] : [], reassessmentAttemptIds: link?.reassessmentAttemptId ? [link.reassessmentAttemptId] : [] } }; }); }
export async function gapRecords(learnerId = DEMO_LEARNER, pathwayId?: string) { const activePathwayId = pathwayId ?? (await learnerContext(learnerId)).pathway.id; const [gaps, events] = await Promise.all([db.select().from(gapsTable), db.select().from(gapEventsTable)]); const statuses = latest(events, (event) => event.gapId); return gaps.filter((gap) => gap.learnerId === learnerId && gap.pathwayId === activePathwayId).map((gap) => ({ ...gap, status: statuses.get(gap.id)?.status ?? "Open" })); }
export async function remediationRecords(learnerId = DEMO_LEARNER, pathwayId?: string) { const activePathwayId = pathwayId ?? (await learnerContext(learnerId)).pathway.id; const gaps = await gapRecords(learnerId, activePathwayId), gapIds = new Set(gaps.map((gap) => gap.id)); const [plans, activities, events, links] = await Promise.all([db.select().from(remediationPlansTable), db.select().from(remediationActivitiesTable), db.select().from(remediationEventsTable), db.select().from(learningRecordLinksTable).where(and(eq(learningRecordLinksTable.learnerId, learnerId), eq(learningRecordLinksTable.pathwayId, activePathwayId)))]); const state = latest(events, (event) => event.activityId); return plans.filter((plan) => gapIds.has(plan.gapId)).map((plan) => { const planActivities = activities.filter((activity) => activity.planId === plan.id).map((activity) => ({ ...activity, status: state.get(activity.id)?.status ?? "Not started" })); const planLinks = links.filter(link => link.remediationPlanId === plan.id); return { ...plan, status: planActivities.every((activity) => activity.status === "Completed") ? "Completed" : planActivities.some((activity) => activity.status === "In progress") ? "In progress" : "Not started", activities: planActivities, causalReferences: { learningRecordLinkIds: planLinks.map(link => link.id), gapIds: [plan.gapId], practiceAttemptIds: planLinks.flatMap(link => link.practiceAttemptId ? [link.practiceAttemptId] : []), evidenceIds: planLinks.flatMap(link => link.evidenceId ? [link.evidenceId] : []), evidenceReviewIds: planLinks.flatMap(link => link.evidenceReviewId ? [link.evidenceReviewId] : []), reassessmentAttemptIds: planLinks.flatMap(link => link.reassessmentAttemptId ? [link.reassessmentAttemptId] : []) } }; }); }
export async function assessmentSummary(assessment: { id: string; moduleId: string; name: string; gateCode?: string | null }, learnerId = DEMO_LEARNER, pathwayId?: string) { const activePathwayId = pathwayId ?? (await learnerContext(learnerId)).pathway.id; const [attempts, criteria, observations] = await Promise.all([db.select().from(assessmentAttemptsTable).where(and(eq(assessmentAttemptsTable.assessmentId, assessment.id), eq(assessmentAttemptsTable.learnerId, learnerId), eq(assessmentAttemptsTable.pathwayId, activePathwayId))), db.select().from(assessmentCriteriaTable).where(eq(assessmentCriteriaTable.assessmentId, assessment.id)), db.select().from(criterionObservationsTable)]); const latestAttempt = attempts.sort((a, b) => b.number - a.number || b.createdAt.getTime() - a.createdAt.getTime())[0]; const byCriterion = new Map(observations.filter((observation) => observation.attemptId === latestAttempt?.id).map((observation) => [observation.criterionId, observation])); const scores = criteria.map((criterion) => byCriterion.get(criterion.id)?.score).filter((score): score is number => score !== undefined); return { id: assessment.id, moduleId: assessment.moduleId, name: assessment.name, gateCode: assessment.gateCode ?? null, status: latestAttempt?.status ?? "Not started", score: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length / 3 * 100) : 0, attemptCount: attempts.length, criticalFailure: Boolean(latestAttempt) && criteria.some((criterion) => criterion.critical && (byCriterion.get(criterion.id)?.score ?? 0) < 2), latestAttemptId: latestAttempt?.id ?? null, criterionIds: criteria.map(criterion => criterion.id) }; }
export async function readiness(context?: Awaited<ReturnType<typeof learnerContext>>) {
  const activeContext = context ?? await learnerContext();
  const selected = await selectedBaselineModuleIds(activeContext.pathway.id, activeContext.baselineVersionId);
  const [allModules, gates, gaps, evidences, allAssessments, allRequirements, allContracts, learnerAttempts, learnerEvidence, learnerReviews, learnerReassessmentLinks, allRemediationPlans, learnerLearningLinks] = await Promise.all([
    db.select().from(modulesTable),
    db.select().from(readinessGatesTable).where(and(eq(readinessGatesTable.pathwayId, activeContext.pathway.id), eq(readinessGatesTable.active, true))).orderBy(readinessGatesTable.sequence),
    gapRecords(activeContext.learner.id, activeContext.pathway.id),
    evidenceRecords(activeContext.learner.id, activeContext.pathway.id, activeContext.baselineVersionId),
    db.select().from(assessmentsTable),
    db.select().from(evidenceRequirementsTable),
    db.select().from(pathwayModuleContractsTable).where(eq(pathwayModuleContractsTable.pathwayId, activeContext.pathway.id)),
    db.select().from(assessmentAttemptsTable).where(and(eq(assessmentAttemptsTable.learnerId, activeContext.learner.id), eq(assessmentAttemptsTable.pathwayId, activeContext.pathway.id))),
    db.select().from(evidenceTable).where(and(eq(evidenceTable.learnerId, activeContext.learner.id), eq(evidenceTable.pathwayId, activeContext.pathway.id))),
    db.select().from(evidenceReviewsTable),
    db.select().from(reassessmentLinksTable).where(and(eq(reassessmentLinksTable.learnerId, activeContext.learner.id), eq(reassessmentLinksTable.pathwayId, activeContext.pathway.id))),
    db.select().from(remediationPlansTable),
    db.select().from(learningRecordLinksTable).where(and(eq(learningRecordLinksTable.learnerId, activeContext.learner.id), eq(learningRecordLinksTable.pathwayId, activeContext.pathway.id))),
  ]);
  // Readiness is a baseline projection, not a legacy catalogue projection:
  // B01-B08 remain addressable history but cannot become active Path B gates.
  const modules = allModules.filter((module) => selected.has(module.id));
  const moduleIds = new Set(modules.map((module) => module.id));
  const contracts = allContracts.filter((contract) => moduleIds.has(contract.moduleId));
  if (!contracts.length) throw new Error(`No active pathway module contracts configured for ${activeContext.pathway.name}`);
  const assessmentIds = new Set(contracts.map((contract) => contract.assessmentId));
  const requirementIds = new Set(contracts.map((contract) => contract.evidenceRequirementId));
  const assessments = allAssessments.filter((assessment) => assessmentIds.has(assessment.id));
  const requirements = allRequirements.filter((requirement) => requirementIds.has(requirement.id));
  const assessmentStates = await Promise.all(assessments.map((assessment) => assessmentSummary(assessment, activeContext.learner.id, activeContext.pathway.id)));
  const stateByAssessment = new Map(assessmentStates.map((assessment) => [assessment.id, assessment]));
  const validEvidenceModules = new Set(evidences.filter((evidence) => evidence.status === "Valid").map((evidence) => evidence.moduleId));
  const safetyBlockers = [
    ...assessmentStates.filter((assessment) => assessment.criticalFailure).map((assessment) => `Critical safety failure in ${assessment.name}`),
    ...gaps.filter((gap) => gap.status !== "Resolved" && gap.severity === "Critical").map((gap) => gap.diagnosis),
  ];
  let previousPassed = true;
  const inputEvidence = {
    assessments: assessmentStates.map((assessment) => ({
      id: assessment.id,
      score: assessment.score,
      completed: assessment.status === "Completed",
      criticalFailure: assessment.criticalFailure,
      assessmentAttemptId: assessment.latestAttemptId,
      criterionIds: assessment.criterionIds,
    })),
    evidence: requirements.map((requirement) => ({
      requirementId: requirement.id,
      satisfied: validEvidenceModules.has(requirement.moduleId),
      evidenceIds: learnerEvidence.filter(item => item.moduleId === requirement.moduleId).map(item => item.id),
      evidenceReviewIds: learnerEvidence.filter(item => item.moduleId === requirement.moduleId)
        .flatMap(item => learnerReviews.filter(review => review.evidenceId === item.id).map(review => review.id)),
    })),
    openCriticalGaps: gaps.filter((gap) => gap.status !== "Resolved" && gap.severity === "Critical").map((gap) => gap.id),
    gates: [] as Array<{
      gateId: string;
      gapIds: string[];
      criterionIds: string[];
      assessmentAttemptIds: string[];
      evidenceIds: string[];
      evidenceReviewIds: string[];
      remediationPlanIds: string[];
      reassessmentAttemptIds: string[];
      learningRecordLinkIds: string[];
      diagnosticProfileIds: string[];
      diagnosticGapIds: string[];
      diagnosticRecommendationIds: string[];
    }>,
  };
  const gateViews = gates.map((gate) => {
    // Contracts, rather than the legacy global assessment.gateCode, are the
    // operational pathway mapping. This keeps the same canonical assessment
    // usable under the distinct Path A and Path B gate partitions.
    const gateContracts = contracts.filter((contract) => contract.gateCode === gate.code);
    if (!gateContracts.length) throw new Error(`Readiness gate ${gate.code} has zero active pathway contract requirements`);
    const gateAssessmentIds = new Set(gateContracts.map((contract) => contract.assessmentId));
    const gateRequirementIds = new Set(gateContracts.map((contract) => contract.evidenceRequirementId));
    const gateAssessments = assessments.filter((assessment) => gateAssessmentIds.has(assessment.id));
    const gateRequirements = requirements.filter((requirement) => gateRequirementIds.has(requirement.id));
    if (gateAssessments.length !== gateAssessmentIds.size || gateRequirements.length !== gateRequirementIds.size) {
      throw new Error(`Readiness gate ${gate.code} has unresolved pathway contract prerequisites`);
    }
    const failedAssessments = gateAssessments.filter((assessment) => {
      const state = stateByAssessment.get(assessment.id);
      return !state || state.status !== "Completed" || state.criticalFailure;
    });
    const missingRequirements = gateRequirements.filter((requirement) => !validEvidenceModules.has(requirement.moduleId));
    const policyBlockers = [
      ...failedAssessments.map((assessment) => stateByAssessment.get(assessment.id)?.criticalFailure ? `Critical safety failure in ${assessment.name}` : `Assessment not complete: ${assessment.name}`),
      ...missingRequirements.map((requirement) => `Valid evidence required: ${requirement.name}`),
    ];
    const gateAssessmentStates = gateAssessments.map((assessment) => stateByAssessment.get(assessment.id)).filter(Boolean);
    const gateAssessmentAttempts = gateAssessmentStates.flatMap(state => state?.latestAttemptId ? [state.latestAttemptId] : []);
    const gateCriterionIds = gateAssessmentStates.flatMap(state => state?.criterionIds ?? []);
    const gateEvidence = learnerEvidence.filter(item => gateRequirements.some(requirement => requirement.moduleId === item.moduleId));
    const gateEvidenceIds = gateEvidence.map(item => item.id);
    const gateEvidenceReviewIds = gateEvidence.flatMap(item => learnerReviews.filter(review => review.evidenceId === item.id).map(review => review.id));
    const gateGapIds = gaps.filter(gap => gateContracts.some(contract => contract.moduleId === gap.moduleId)).map(gap => gap.id);
    const gateRemediationPlanIds = allRemediationPlans.filter(plan => gateGapIds.includes(plan.gapId)).map(plan => plan.id);
    const gateReassessmentAttemptIds = learnerReassessmentLinks
      .filter(link => gateRemediationPlanIds.includes(link.remediationPlanId))
      .map(link => link.reassessmentAttemptId);
    const gateLearningLinks = learnerLearningLinks.filter(link =>
      (link.gapId ? gateGapIds.includes(link.gapId) : false) ||
      (link.remediationPlanId ? gateRemediationPlanIds.includes(link.remediationPlanId) : false) ||
      (link.evidenceId ? gateEvidenceIds.includes(link.evidenceId) : false) ||
      (link.evidenceReviewId ? gateEvidenceReviewIds.includes(link.evidenceReviewId) : false) ||
      (link.reassessmentAttemptId ? gateReassessmentAttemptIds.includes(link.reassessmentAttemptId) : false)
    );
    const diagnosticIds = (key: "diagnosticProfileId" | "diagnosticGapId" | "diagnosticRecommendationId") =>
      [...new Set(gateLearningLinks.flatMap(link => typeof link.metadata[key] === "string" ? [link.metadata[key] as string] : []))];
    inputEvidence.gates!.push({
      gateId: gate.id,
      gapIds: gateGapIds,
      criterionIds: gateCriterionIds,
      assessmentAttemptIds: gateAssessmentAttempts,
      evidenceIds: gateEvidenceIds,
      evidenceReviewIds: gateEvidenceReviewIds,
      remediationPlanIds: gateRemediationPlanIds,
      reassessmentAttemptIds: gateReassessmentAttemptIds,
      learningRecordLinkIds: gateLearningLinks.map(link => link.id),
      diagnosticProfileIds: diagnosticIds("diagnosticProfileId"),
      diagnosticGapIds: diagnosticIds("diagnosticGapId"),
      diagnosticRecommendationIds: diagnosticIds("diagnosticRecommendationId"),
    });
    const assessmentScore = gateAssessmentStates.length
      ? gateAssessmentStates.reduce((sum, state) => sum + state!.score, 0) / gateAssessmentStates.length
      : 100;
    const evidenceScore = gateRequirements.length
      ? gateRequirements.filter((requirement) => validEvidenceModules.has(requirement.moduleId)).length / gateRequirements.length * 100
      : 100;
    const score = Math.round((assessmentScore + evidenceScore) / 2);
    if (score < gate.threshold) policyBlockers.push(`Rule threshold not met: ${score}/${gate.threshold}`);
    const hardGateFailed = gate.hardGate && policyBlockers.length > 0;
    const passed = previousPassed && policyBlockers.length === 0 && safetyBlockers.length === 0;
    const status = passed ? "Passed" : previousPassed ? "In progress" : "Locked";
    previousPassed = passed;
    return {
      id: gate.id, code: gate.code, name: gate.name, requirement: gate.requirement, status, score,
      threshold: gate.threshold, hardGate: gate.hardGate, hardGateFailed,
      competencyUnitId: gate.competencyUnitId, ruleVersion: gate.ruleVersion, blockers: policyBlockers,
      contracts: gateContracts.map((contract) => ({
        id: contract.id, moduleId: contract.moduleId, assessmentId: contract.assessmentId,
        evidenceRequirementId: contract.evidenceRequirementId, gateCode: contract.gateCode,
        assessment: contract.assessment, evidence: contract.evidence, output: contract.output,
        kpi: contract.kpi, portfolio: contract.portfolio,
      })),
    };
  });
  const activeGate = gateViews.find((gate) => gate.status === "In progress") ?? [...gateViews].reverse().find((gate) => gate.status === "Passed") ?? gateViews[0];
  if (!activeGate) throw new Error(`No readiness gates configured for ${activeContext.pathway.name}`);
  const currentIndex = gateViews.findIndex((gate) => gate.id === activeGate.id);
  const requiredAssessmentCount = assessmentIds.size;
  const completeAssessmentCount = assessmentStates.filter((assessment) => assessment.status === "Completed" && !assessment.criticalFailure).length;
  const requiredEvidenceCount = requirements.length;
  const validEvidenceCount = requirements.filter((requirement) => validEvidenceModules.has(requirement.moduleId)).length;
  const completedRequirements = completeAssessmentCount + validEvidenceCount;
  const totalRequirements = requiredAssessmentCount + requiredEvidenceCount;
  const currentBlockers = gateViews.filter((gate) => gate.status === "In progress").flatMap((gate) => gate.blockers);
  const blockers = [...new Set([...safetyBlockers, ...currentBlockers])];
  const score = totalRequirements ? Math.round(completedRequirements / totalRequirements * 100) : 100;
  const hardGateFailed = gateViews.some((gate) => gate.hardGateFailed);
  const allRulesPassed = gateViews.every((gate) => gate.status === "Passed");
  const status = safetyBlockers.length > 0 || hardGateFailed
    ? "Not Ready"
    : allRulesPassed
      ? "Ready for Official Assessment"
      : "Developing";
  const ruleVersion = Math.max(...gates.map((gate) => gate.ruleVersion));
  const decisionReason = safetyBlockers.length
    ? "Critical safety evidence failed. Safety is a non-compensable hard gate."
    : hardGateFailed
      ? "One or more configured hard gates have not been satisfied."
      : allRulesPassed
        ? "All active readiness rules, thresholds, evidence requirements, and safety gates are satisfied."
        : "Evidence or assessment thresholds are still developing.";
  const evaluatedAt = new Date();
  await db.insert(readinessEventsTable).values({
    id: crypto.randomUUID(),
    enrollmentId: activeContext.enrollment.id,
    pathwayId: activeContext.pathway.id,
    gateId: activeGate.id,
    status,
    score,
    blockers,
    ruleVersion,
    inputEvidence,
    decisionReason,
    evaluatedAt,
    createdBy: activeContext.learner.id,
  });
  const publicGate = (gate: typeof gateViews[number]) => ({
    id: gate.id, code: gate.code, name: gate.name, requirement: gate.requirement,
    status: gate.status, score: gate.score, threshold: gate.threshold,
    hardGate: gate.hardGate, competencyUnitId: gate.competencyUnitId,
    ruleVersion: gate.ruleVersion, blockers: gate.blockers, contracts: gate.contracts,
  });
  return {
    pathway: await pathwaySummary(activeContext.pathway.id, undefined, activeContext.baselineVersionId),
    status,
    score,
    ruleVersion,
    evaluatedAt,
    decisionReason,
    inputEvidence,
    currentGate: publicGate(activeGate),
    nextGate: gateViews[currentIndex + 1] ? publicGate(gateViews[currentIndex + 1]) : null,
    gates: gateViews.map(publicGate),
    blockers,
    outstandingGapCount: gaps.filter((gap) => gap.status !== "Resolved").length,
    missingEvidenceCount: requirements.filter((requirement) => !validEvidenceModules.has(requirement.moduleId)).length,
  };
}