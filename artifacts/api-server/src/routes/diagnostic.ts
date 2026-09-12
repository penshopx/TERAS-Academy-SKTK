import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, diagnosticTemplatesTable, diagnosticQuestionsTable, diagnosticOptionsTable, diagnosticSessionsTable,
  diagnosticResponsesTable, diagnosticProfilesTable, diagnosticProfileItemsTable, diagnosticGapsTable,
  diagnosticRecommendationsTable, diagnosticSafetyFlagsTable, diagnosticAuditEventsTable,
  competencyFrameworksTable, competencyUnitsTable, competencyUnitOutcomesTable,
  competencyUnitPracticeTasksTable, competencyUnitEvidenceRequirementsTable,
  competencyUnitSimulationsTable, competencyUnitSafetyRulesTable, pathwayCompetencyUnitsTable,
  practiceTasksTable, evidenceRequirementsTable, readinessGatesTable, pathwayModuleContractsTable,
} from "@workspace/db";
import { GetDiagnosticResponse, StartDiagnosticSessionResponse, SaveDiagnosticResponsesBody, SaveDiagnosticResponsesResponse, CompleteDiagnosticSessionParams, CompleteDiagnosticSessionResponse, GetCompetencyProfileResponse, GetReadinessMapResponse } from "@workspace/api-zod";
import { authorizeLearner } from "../lib/authorization";
import { learnerContext, readiness } from "../lib/teras";

const router: IRouter = Router();
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const sessionView = (s: typeof diagnosticSessionsTable.$inferSelect) => ({ id: s.id, status: s.status, progress: s.progress, pathwayId: s.pathwayId, templateId: s.templateId, completedAt: s.completedAt });

async function activeTemplate(pathwayId: string) {
  const [template] = await db.select().from(diagnosticTemplatesTable).where(and(eq(diagnosticTemplatesTable.pathwayId, pathwayId), eq(diagnosticTemplatesTable.status, "active"))).orderBy(desc(diagnosticTemplatesTable.createdAt)).limit(1);
  return template;
}

router.get("/diagnostic", async (req, res): Promise<void> => {
  const learnerId = await authorizeLearner(req, res); if (!learnerId) return;
  const context = await learnerContext(learnerId); const template = await activeTemplate(context.pathway.id);
  if (!template) { res.status(404).json({ error: "No active diagnostic template" }); return; }
  const [session] = await db.select().from(diagnosticSessionsTable)
    .where(and(
      eq(diagnosticSessionsTable.learnerId, learnerId),
      eq(diagnosticSessionsTable.pathwayId, context.pathway.id),
      inArray(diagnosticSessionsTable.status, ["in_progress", "completed"]),
    ))
    .orderBy(sql`case when ${diagnosticSessionsTable.status} = 'in_progress' then 0 else 1 end`, desc(diagnosticSessionsTable.createdAt))
    .limit(1);
  const questions = await db.select().from(diagnosticQuestionsTable).where(eq(diagnosticQuestionsTable.templateId, template.id)).orderBy(diagnosticQuestionsTable.sequence);
  const options = await db.select().from(diagnosticOptionsTable);
  const saved = session ? await db.select().from(diagnosticResponsesTable).where(eq(diagnosticResponsesTable.sessionId, session.id)) : [];
  res.json(GetDiagnosticResponse.parse({ template, session: session ? sessionView(session) : null, responses: saved.map(({ questionId, optionId }) => ({ questionId, optionId })), questions: questions.map(q => ({ ...q, options: options.filter(o => o.questionId === q.id) })) }));
});

router.post("/diagnostic/sessions", async (req, res): Promise<void> => {
  const learnerId = await authorizeLearner(req, res); if (!learnerId) return;
  const context = await learnerContext(learnerId); const template = await activeTemplate(context.pathway.id);
  if (!template) { res.status(404).json({ error: "No active diagnostic template" }); return; }
  const result = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${learnerId}), hashtext(${context.pathway.id}))`);
    const [existing] = await tx.select().from(diagnosticSessionsTable).where(and(eq(diagnosticSessionsTable.learnerId, learnerId), eq(diagnosticSessionsTable.pathwayId, context.pathway.id), eq(diagnosticSessionsTable.status, "in_progress"))).limit(1);
    if (existing) return { session: existing, created: false };
    const [session] = await tx.insert(diagnosticSessionsTable).values({ id: id("diagnostic-session"), learnerId, enrollmentId: context.enrollment.id, pathwayId: context.pathway.id, templateId: template.id, frameworkId: template.frameworkId, createdBy: learnerId }).returning();
    if (!session) throw new Error("Failed to create diagnostic session");
    await tx.insert(diagnosticAuditEventsTable).values({ id: id("diagnostic-audit"), sessionId: session.id, learnerId, action: "diagnostic_started", details: {}, createdBy: learnerId });
    return { session, created: true };
  });
  res.status(result.created ? 201 : 200).json(StartDiagnosticSessionResponse.parse(sessionView(result.session)));
});

router.put("/diagnostic/sessions/:sessionId/responses", async (req, res): Promise<void> => {
  const learnerId = await authorizeLearner(req, res); if (!learnerId) return;
  const params = { sessionId: String(req.params.sessionId) }; const parsed = SaveDiagnosticResponsesBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [session] = await db.select().from(diagnosticSessionsTable).where(and(eq(diagnosticSessionsTable.id, params.sessionId), eq(diagnosticSessionsTable.learnerId, learnerId)));
  const context = await learnerContext(learnerId);
  if (!session || session.status !== "in_progress" || session.enrollmentId !== context.enrollment.id || session.pathwayId !== context.pathway.id) { res.status(404).json({ error: "Diagnostic session not found for the active enrollment and pathway" }); return; }
  const required = await db.select().from(diagnosticQuestionsTable).where(and(eq(diagnosticQuestionsTable.templateId, session.templateId), eq(diagnosticQuestionsTable.required, true)));
  const incoming = new Set(parsed.data.responses.map(r => r.questionId));
  const saved = await db.select().from(diagnosticResponsesTable).where(eq(diagnosticResponsesTable.sessionId, session.id));
  if (parsed.data.progress === 100 && required.some(q => !incoming.has(q.id) && !saved.some(r => r.questionId === q.id))) { res.status(400).json({ error: "REQUIRED_DIAGNOSTIC_ANSWERS_MISSING", message: "Answer every required diagnostic question before completing the diagnostic." }); return; }
  const templateQuestions = new Set((await db.select({ id: diagnosticQuestionsTable.id }).from(diagnosticQuestionsTable).where(eq(diagnosticQuestionsTable.templateId, session.templateId))).map(q => q.id));
  const validOptions = await db.select({ id: diagnosticOptionsTable.id, questionId: diagnosticOptionsTable.questionId }).from(diagnosticOptionsTable);
  const optionById = new Map(validOptions.map(option => [option.id, option.questionId]));
  if (parsed.data.responses.some(response => !templateQuestions.has(response.questionId) || optionById.get(response.optionId) !== response.questionId)) {
    res.status(400).json({ error: "INVALID_DIAGNOSTIC_QUESTION_OR_OPTION", message: "Question and option must belong to the active diagnostic template." });
    return;
  }
  await db.transaction(async tx => {
    for (const response of parsed.data.responses) {
      const [question] = await tx.select().from(diagnosticQuestionsTable).where(and(eq(diagnosticQuestionsTable.id, response.questionId), eq(diagnosticQuestionsTable.templateId, session.templateId)));
      const [option] = await tx.select().from(diagnosticOptionsTable).where(and(eq(diagnosticOptionsTable.id, response.optionId), eq(diagnosticOptionsTable.questionId, response.questionId)));
      if (!question || !option) throw new Error("Invalid diagnostic question or option for this session template");
      await tx.insert(diagnosticResponsesTable).values({ id: id("diagnostic-response"), sessionId: session.id, questionId: question.id, optionId: option.id, frameworkId: session.frameworkId, competencyUnitId: question.competencyUnitId, createdBy: learnerId }).onConflictDoUpdate({ target: [diagnosticResponsesTable.sessionId, diagnosticResponsesTable.questionId], set: { optionId: option.id, answeredAt: new Date(), updatedAt: new Date() } });
    }
    await tx.update(diagnosticSessionsTable).set({ progress: parsed.data.progress, updatedAt: new Date() }).where(eq(diagnosticSessionsTable.id, session.id));
    await tx.insert(diagnosticAuditEventsTable).values({ id: id("diagnostic-audit"), sessionId: session.id, learnerId, action: "responses_saved", details: { progress: parsed.data.progress }, createdBy: learnerId });
  });
  const [updated] = await db.select().from(diagnosticSessionsTable).where(eq(diagnosticSessionsTable.id, session.id));
  res.json(SaveDiagnosticResponsesResponse.parse(sessionView(updated!)));
});

/** Completion projection is deliberately one locked transaction. */
async function profileForAtomic(learnerId: string, session: typeof diagnosticSessionsTable.$inferSelect) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.id}))`);
    const [existing] = await tx.select().from(diagnosticProfilesTable).where(eq(diagnosticProfilesTable.sessionId, session.id));
    if (existing) {
      const [gaps, recommendations] = await Promise.all([
        tx.select().from(diagnosticGapsTable).where(eq(diagnosticGapsTable.profileId, existing.id)),
        tx.select().from(diagnosticRecommendationsTable).where(eq(diagnosticRecommendationsTable.profileId, existing.id)),
      ]);
      return { profile: existing, gaps, recommendations };
    }
    const [framework] = await tx.select().from(competencyFrameworksTable).where(eq(competencyFrameworksTable.id, session.frameworkId));
    const [mappings, units, questions, responses, options, outcomes, practiceMappings, evidenceMappings, simulations, safetyRules, practiceTasks, evidenceRequirements, readinessGates, pathwayContracts] = await Promise.all([
      tx.select().from(pathwayCompetencyUnitsTable).where(eq(pathwayCompetencyUnitsTable.pathwayId, session.pathwayId)),
      tx.select().from(competencyUnitsTable).where(eq(competencyUnitsTable.frameworkId, session.frameworkId)),
      tx.select().from(diagnosticQuestionsTable).where(eq(diagnosticQuestionsTable.templateId, session.templateId)),
      tx.select().from(diagnosticResponsesTable).where(eq(diagnosticResponsesTable.sessionId, session.id)),
      tx.select().from(diagnosticOptionsTable),
      tx.select().from(competencyUnitOutcomesTable),
      tx.select().from(competencyUnitPracticeTasksTable),
      tx.select().from(competencyUnitEvidenceRequirementsTable),
      tx.select().from(competencyUnitSimulationsTable),
      tx.select().from(competencyUnitSafetyRulesTable),
      tx.select().from(practiceTasksTable),
      tx.select().from(evidenceRequirementsTable),
      tx.select().from(readinessGatesTable).where(and(eq(readinessGatesTable.pathwayId, session.pathwayId), eq(readinessGatesTable.active, true))),
      tx.select().from(pathwayModuleContractsTable).where(eq(pathwayModuleContractsTable.pathwayId, session.pathwayId)),
    ]);
    const optionById = new Map(options.map(o => [o.id, o]));
    const questionById = new Map(questions.map(q => [q.id, q]));
    const unitById = new Map(units.map(u => [u.id, u]));
    const provenanceFor = (unitId?: string) => {
      const relevant = responses.filter(response => {
        const question = questionById.get(response.questionId);
        return !unitId || question?.competencyUnitId === unitId;
      });
      return {
        sessionId: session.id,
        responseIds: relevant.map(response => response.id),
        questionIds: relevant.map(response => response.questionId),
        optionIds: relevant.map(response => response.optionId),
      };
    };
    const requiredProvenanceFor = (unitId?: string) => {
      const provenance = provenanceFor(unitId);
      if (!provenance.responseIds.length || !provenance.questionIds.length || !provenance.optionIds.length) {
        throw new Error(`Diagnostic projection is missing response provenance${unitId ? ` for competency unit ${unitId}` : ""}`);
      }
      return provenance;
    };
    const scores = new Map<string, number[]>();
    const dimensions = new Map<string, number[]>();
    const unitDimensions = new Map<string, Map<string, number[]>>();
    const criticalUnits = new Set<string>();
    for (const response of responses) {
      const question = questionById.get(response.questionId);
      const option = optionById.get(response.optionId);
      if (!question || !option) continue;
      const dimension = question.dimension.toUpperCase().replace(" ", "_");
      (dimensions.get(dimension) ?? (dimensions.set(dimension, []), dimensions.get(dimension)!)).push(option.score);
      if (question.competencyUnitId) {
        (scores.get(question.competencyUnitId) ?? (scores.set(question.competencyUnitId, []), scores.get(question.competencyUnitId)!)).push(option.score);
        const byDimension = unitDimensions.get(question.competencyUnitId) ?? new Map<string, number[]>();
        unitDimensions.set(question.competencyUnitId, byDimension);
        (byDimension.get(dimension) ?? (byDimension.set(dimension, []), byDimension.get(dimension)!)).push(option.score);
        if (option.safetyOutcome === "CRITICAL_SAFETY_FAILURE") criticalUnits.add(question.competencyUnitId);
      }
    }
    const dimensionNames = ["KNOWLEDGE", "EXPERIENCE", "PRACTICAL_CAPABILITY", "SAFETY", "COMMUNICATION", "EVIDENCE"];
    const dimensionSummaries = Object.fromEntries(dimensionNames.map(name => {
      const values = dimensions.get(name) ?? [];
      return [name, values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length / 3 * 100) : 0];
    }));
    const critical = criticalUnits.size > 0;
    const [profile] = await tx.insert(diagnosticProfilesTable).values({
      id: id("competency-profile"), sessionId: session.id, learnerId, pathwayId: session.pathwayId,
      frameworkId: session.frameworkId, frameworkVersion: framework?.version ?? "unknown",
      currentState: critical ? "SAFETY_BLOCKED" : "DIAGNOSTIC_CURRENT_POSITION",
      safetyOverride: critical, dimensionSummaries, provenance: requiredProvenanceFor(), createdBy: learnerId,
    }).returning();
    if (!profile) throw new Error("Failed to create profile");
    const gaps: Array<Record<string, unknown>> = [];
    const recommendations: Array<Record<string, unknown>> = [];
    for (const mapping of mappings) {
      const unit = unitById.get(mapping.unitId);
      const raw = scores.get(mapping.unitId) ?? [];
      const score = raw.length ? Math.round(raw.reduce((a, b) => a + b, 0) / raw.length / 3 * 100) : 0;
      const blocked = criticalUnits.has(mapping.unitId);
      const state = blocked ? "SAFETY_BLOCKED" : score >= 67 ? "READY_FOR_PRACTICE" : score >= 34 ? "DEVELOPING" : "FOUNDATIONAL";
      await tx.insert(diagnosticProfileItemsTable).values({
        id: id("profile-item"), profileId: profile.id, competencyUnitId: mapping.unitId,
        frameworkId: session.frameworkId, unitCode: unit?.code ?? "", unitTitle: unit?.title ?? "",
        state, score, evidenceLevel: "diagnostic_only", provenance: requiredProvenanceFor(mapping.unitId), createdBy: learnerId,
      });
      if (score >= 67 && !blocked) continue;
      const diagnosis = blocked ? "Critical safety response requires supervised remediation." : "Diagnostic indicates further learning, practice, and evidence are needed.";
      const gap = { id: id("diagnostic-gap"), profileId: profile.id, competencyUnitId: mapping.unitId, frameworkId: session.frameworkId, unitCode: unit?.code ?? "", unitTitle: unit?.title ?? "", diagnosis, severity: blocked ? "CRITICAL" : "MODERATE", provenance: requiredProvenanceFor(mapping.unitId), createdBy: learnerId };
      await tx.insert(diagnosticGapsTable).values(gap); gaps.push(gap);
      const outcome = outcomes.find(o => o.unitId === mapping.unitId);
      const practice = practiceMappings.find(p => p.unitId === mapping.unitId);
      const evidence = evidenceMappings.find(e => e.unitId === mapping.unitId);
      const simulation = simulations.find(s => s.unitId === mapping.unitId);
      const safety = safetyRules.find(r => r.unitId === mapping.unitId);
      const mappedPracticeTask = practice && practiceTasks.find(task => task.id === practice.taskId);
      const mappedEvidenceRequirement = evidence && evidenceRequirements.find(requirement => requirement.id === evidence.requirementId);
      const mappedGate = readinessGates.find(gate => gate.competencyUnitId === mapping.unitId);
      const mappedContract = mappedGate && pathwayContracts.find(contract => contract.gateCode === mappedGate.code);
      const moduleId = mappedPracticeTask?.moduleId ?? mappedEvidenceRequirement?.moduleId ?? mappedContract?.moduleId;
      if (!moduleId) throw new Error(`Diagnostic competency unit ${mapping.unitId} has no pathway module mapping`);
      const weakestDimension = weakestDimensionFor(unitDimensions.get(mapping.unitId));
      const kind = blocked
        ? "SAFETY_REMEDIATION"
        : weakestDimension === "EVIDENCE"
          ? "EVIDENCE"
          : weakestDimension === "PRACTICAL_CAPABILITY" && simulation && !practice
            ? "INTERNAL_SIMULATION"
            : weakestDimension === "PRACTICAL_CAPABILITY"
              ? "PRACTICE"
              : "LEARNING";
      const href = kind === "EVIDENCE" ? "/evidence" : kind === "LEARNING" ? "/learning" : "/practice";
      const title = blocked
        ? `Perbaiki aturan keselamatan ${safety?.code ?? "yang dipetakan"} sebelum praktik terbimbing`
        : kind === "EVIDENCE"
          ? `Lengkapi bukti yang dipetakan untuk ${unit?.title ?? "unit kompetensi"}`
          : kind === "INTERNAL_SIMULATION"
            ? `Lakukan simulasi internal untuk ${unit?.title ?? "unit kompetensi"}`
            : kind === "PRACTICE"
              ? `Latih ${unit?.title ?? "unit kompetensi"} melalui tugas praktik yang dipetakan`
              : `Pelajari ${outcome?.outcomeCode ?? "hasil belajar yang dipetakan"} untuk ${unit?.title ?? "unit kompetensi"}`;
      const rationale = blocked
        ? "Respons diagnostik menunjukkan risiko keselamatan kritis pada unit ini. Lakukan remediasi terbimbing; ini bukan asesmen resmi."
        : `Dimensi ${weakestDimension || "kapabilitas"} memerlukan intervensi yang terhubung langsung ke framework sebelum melanjutkan kesiapan internal.`;
      const recommendation = { id: id("diagnostic-recommendation"), profileId: profile.id, competencyUnitId: mapping.unitId, frameworkId: session.frameworkId, unitCode: unit?.code ?? "", unitTitle: unit?.title ?? "", moduleId, practiceTaskId: kind === "PRACTICE" ? practice?.taskId : null, evidenceRequirementId: kind === "EVIDENCE" ? evidence?.requirementId : null, simulationId: kind === "INTERNAL_SIMULATION" ? simulation?.id : null, safetyRuleId: blocked ? safety?.id : null, kind, title, rationale, priority: blocked ? "URGENT" : "HIGH", href, createdBy: learnerId };
      await tx.insert(diagnosticRecommendationsTable).values(recommendation); recommendations.push(recommendation);
    }
    for (const unitId of criticalUnits) await tx.insert(diagnosticSafetyFlagsTable).values({ id: id("safety-flag"), profileId: profile.id, competencyUnitId: unitId, code: "CRITICAL_SAFETY_FAILURE", severity: "CRITICAL", blocking: true, detail: "Diagnostic response indicates unsafe practice.", createdBy: learnerId });
    await tx.insert(diagnosticAuditEventsTable).values([
      { id: id("diagnostic-audit"), sessionId: session.id, learnerId, action: "profile_generated", details: { profileId: profile.id }, createdBy: learnerId },
      ...gaps.map(g => ({ id: id("diagnostic-audit"), sessionId: session.id, learnerId, action: "gap_generated", details: { gapId: g.id }, createdBy: learnerId })),
      ...recommendations.map(r => ({ id: id("diagnostic-audit"), sessionId: session.id, learnerId, action: "recommendation_generated", details: { recommendationId: r.id }, createdBy: learnerId })),
      { id: id("diagnostic-audit"), sessionId: session.id, learnerId, action: "diagnostic_completed", details: { profileId: profile.id }, createdBy: learnerId },
    ]);
    await tx.update(diagnosticSessionsTable).set({ status: "completed", progress: 100, completedAt: new Date(), updatedAt: new Date() }).where(eq(diagnosticSessionsTable.id, session.id));
    return { profile, gaps, recommendations };
  });
}

function weakestDimensionFor(dimensions?: Map<string, number[]>) {
  if (!dimensions?.size) return "";
  return [...dimensions.entries()].sort(([, left], [, right]) => {
    const leftAverage = left.reduce((sum, value) => sum + value, 0) / left.length;
    const rightAverage = right.reduce((sum, value) => sum + value, 0) / right.length;
    return leftAverage - rightAverage;
  })[0]?.[0] ?? "";
}

router.post("/diagnostic/sessions/:sessionId/complete", async (req, res): Promise<void> => { const learnerId = await authorizeLearner(req, res); if (!learnerId) return; const parsed = CompleteDiagnosticSessionParams.safeParse(req.params); if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; } const context = await learnerContext(learnerId); const [session] = await db.select().from(diagnosticSessionsTable).where(and(eq(diagnosticSessionsTable.id, parsed.data.sessionId), eq(diagnosticSessionsTable.learnerId, learnerId), eq(diagnosticSessionsTable.enrollmentId, context.enrollment.id), eq(diagnosticSessionsTable.pathwayId, context.pathway.id))); if (!session) { res.status(404).json({ error: "Diagnostic session not found for the active enrollment and pathway" }); return; } const required = await db.select().from(diagnosticQuestionsTable).where(and(eq(diagnosticQuestionsTable.templateId, session.templateId), eq(diagnosticQuestionsTable.required, true))); const saved = await db.select().from(diagnosticResponsesTable).where(eq(diagnosticResponsesTable.sessionId, session.id)); if (required.some(q => !saved.some(r => r.questionId === q.id))) { res.status(400).json({ error: "REQUIRED_DIAGNOSTIC_ANSWERS_MISSING", message: "Answer every required diagnostic question before completion." }); return; } const result = await profileForAtomic(learnerId, session); const items = await db.select().from(diagnosticProfileItemsTable).where(eq(diagnosticProfileItemsTable.profileId, result.profile.id)); res.json(CompleteDiagnosticSessionResponse.parse({ ...result.profile, items: items.map(({ competencyUnitId, unitCode, unitTitle, state, score, evidenceLevel, provenance }) => ({ competencyUnitId, unitCode, unitTitle, state, score, evidenceLevel, provenance })), gaps: result.gaps, recommendations: result.recommendations })); });
router.get("/competency-profile", async (req, res): Promise<void> => { const learnerId = await authorizeLearner(req, res); if (!learnerId) return; const context = await learnerContext(learnerId); const [profile] = await db.select().from(diagnosticProfilesTable).where(and(eq(diagnosticProfilesTable.learnerId, learnerId), eq(diagnosticProfilesTable.pathwayId, context.pathway.id))).orderBy(desc(diagnosticProfilesTable.completedAt)).limit(1); if (!profile) { res.status(404).json({ error: "No completed diagnostic profile" }); return; } const items = await db.select().from(diagnosticProfileItemsTable).where(eq(diagnosticProfileItemsTable.profileId, profile.id)); const gaps = await db.select().from(diagnosticGapsTable).where(eq(diagnosticGapsTable.profileId, profile.id)); const recommendations = await db.select().from(diagnosticRecommendationsTable).where(eq(diagnosticRecommendationsTable.profileId, profile.id)); res.json(GetCompetencyProfileResponse.parse({ ...profile, items: items.map(({ competencyUnitId, unitCode, unitTitle, state, score, evidenceLevel, provenance }) => ({ competencyUnitId, unitCode, unitTitle, state, score, evidenceLevel, provenance })), gaps, recommendations })); });
router.get("/readiness-map", async (req, res): Promise<void> => { const learnerId = await authorizeLearner(req, res); if (!learnerId) return; const context = await learnerContext(learnerId); const [profile] = await db.select().from(diagnosticProfilesTable).where(and(eq(diagnosticProfilesTable.learnerId, learnerId), eq(diagnosticProfilesTable.pathwayId, context.pathway.id))).orderBy(desc(diagnosticProfilesTable.completedAt)).limit(1); if (!profile) { res.status(404).json({ error: "No completed diagnostic profile" }); return; } const items = await db.select().from(diagnosticProfileItemsTable).where(eq(diagnosticProfileItemsTable.profileId, profile.id)); const gaps = await db.select().from(diagnosticGapsTable).where(eq(diagnosticGapsTable.profileId, profile.id)); const recommendations = await db.select().from(diagnosticRecommendationsTable).where(eq(diagnosticRecommendationsTable.profileId, profile.id)); res.json(GetReadinessMapResponse.parse({ profile: { ...profile, items: items.map(({ competencyUnitId, unitCode, unitTitle, state, score, evidenceLevel, provenance }) => ({ competencyUnitId, unitCode, unitTitle, state, score, evidenceLevel, provenance })), gaps, recommendations }, readiness: await readiness(context) })); });
export default router;