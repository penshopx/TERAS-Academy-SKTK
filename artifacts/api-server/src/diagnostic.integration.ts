import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, pool, diagnosticAuditEventsTable, diagnosticGapsTable, diagnosticOptionsTable,
  diagnosticProfileItemsTable, diagnosticProfilesTable, diagnosticRecommendationsTable,
  diagnosticRecommendationFollowUpsTable,
  diagnosticResponsesTable, diagnosticSafetyFlagsTable, diagnosticSessionsTable,
  enrollmentsTable, peopleTable, programsTable, pathwaysTable, competencyFrameworksTable,
  competencyUnitsTable, pathwayCompetencyUnitsTable, diagnosticTemplatesTable,
  diagnosticQuestionsTable,
  readinessEventsTable,
  personRolesTable,
} from "@workspace/db";
import { createIntegrationTestApp } from "./integration-test-app";

const suffix = crypto.randomUUID();
const learnerA = `diagnostic-a-${suffix}`;
const learnerB = `diagnostic-b-${suffix}`;
const learnerC = `diagnostic-c-${suffix}`;
const trainerA = `diagnostic-trainer-a-${suffix}`;
const trainerB = `diagnostic-trainer-b-${suffix}`;
const enrollmentA = `diagnostic-enrol-a-${suffix}`;
const enrollmentB = `diagnostic-enrol-b-${suffix}`;
const enrollmentC = `diagnostic-enrol-c-${suffix}`;
const ids = [learnerA, learnerB, learnerC];
const peopleIds = [...ids, trainerA, trainerB];
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function cleanup() {
  const sessions = await db.select({ id: diagnosticSessionsTable.id }).from(diagnosticSessionsTable).where(inArray(diagnosticSessionsTable.learnerId, ids));
  const sessionIds = sessions.map(x => x.id);
  if (sessionIds.length) {
    const profiles = await db.select({ id: diagnosticProfilesTable.id }).from(diagnosticProfilesTable).where(inArray(diagnosticProfilesTable.sessionId, sessionIds));
    const profileIds = profiles.map(x => x.id);
    if (profileIds.length) {
      const recommendationIds = (await db.select({ id: diagnosticRecommendationsTable.id }).from(diagnosticRecommendationsTable).where(inArray(diagnosticRecommendationsTable.profileId, profileIds))).map(x => x.id);
      if (recommendationIds.length) await db.delete(diagnosticRecommendationFollowUpsTable).where(inArray(diagnosticRecommendationFollowUpsTable.recommendationId, recommendationIds));
      await db.delete(diagnosticSafetyFlagsTable).where(inArray(diagnosticSafetyFlagsTable.profileId, profileIds));
      await db.delete(diagnosticRecommendationsTable).where(inArray(diagnosticRecommendationsTable.profileId, profileIds));
      await db.delete(diagnosticGapsTable).where(inArray(diagnosticGapsTable.profileId, profileIds));
      await db.delete(diagnosticProfileItemsTable).where(inArray(diagnosticProfileItemsTable.profileId, profileIds));
      await db.delete(diagnosticProfilesTable).where(inArray(diagnosticProfilesTable.id, profileIds));
    }
    await db.delete(diagnosticAuditEventsTable).where(inArray(diagnosticAuditEventsTable.sessionId, sessionIds));
    await db.delete(diagnosticResponsesTable).where(inArray(diagnosticResponsesTable.sessionId, sessionIds));
    await db.delete(diagnosticSessionsTable).where(inArray(diagnosticSessionsTable.id, sessionIds));
  }
  await db.delete(readinessEventsTable).where(inArray(readinessEventsTable.enrollmentId, [enrollmentA, enrollmentB, enrollmentC]));
  await db.delete(enrollmentsTable).where(inArray(enrollmentsTable.id, [enrollmentA, enrollmentB, enrollmentC]));
  await db.delete(personRolesTable).where(inArray(personRolesTable.personId, [trainerA, trainerB]));
  await db.delete(peopleTable).where(inArray(peopleTable.id, peopleIds));
}

async function run() {
  const previousDemoAccess = process.env.TERAS_ENABLE_DEMO_ACCESS;
  delete process.env.TERAS_ENABLE_DEMO_ACCESS;
  const migration = await readFile(new URL("../../../lib/db/migrations/0017_diagnostic.sql", import.meta.url), "utf8");
  await pool.query(migration);
  const followUpMigration = await readFile(new URL("../../../lib/db/migrations/0019_diagnostic_recommendation_follow_ups.sql", import.meta.url), "utf8");
  await pool.query(followUpMigration);
  await db.insert(programsTable).values({ id: "solar-pv-tech", domain: "renewable", name: "Solar PV", description: "Fixture", status: "active", createdBy: "diagnostic-test" }).onConflictDoNothing();
  await db.insert(pathwaysTable).values({ id: "path-a", programId: "solar-pv-tech", name: "Path A", type: "standard", outcome: "Technician", status: "active", createdBy: "diagnostic-test" }).onConflictDoNothing();
  await db.insert(pathwaysTable).values({ id: "path-b", programId: "solar-pv-tech", name: "Path B", type: "standard", outcome: "Designer", status: "active", createdBy: "diagnostic-test" }).onConflictDoNothing();
  await db.insert(competencyFrameworksTable).values({ id: "framework-skttk-solar-pv", code: "SKTTK", name: "SKTTK", description: "Fixture", domain: "solar", version: "1.0", status: "active", createdBy: "diagnostic-test" }).onConflictDoNothing();
  await db.insert(competencyUnitsTable).values([
    { id: "skttk-u-safe-isolation", frameworkId: "framework-skttk-solar-pv", code: "SAFE", title: "Safety", description: "Safety", sequence: 1, status: "active", createdBy: "diagnostic-test" },
    { id: "skttk-u-installation", frameworkId: "framework-skttk-solar-pv", code: "INSTALL", title: "Installation", description: "Installation", sequence: 2, status: "active", createdBy: "diagnostic-test" },
    { id: "skttk-u-design", frameworkId: "framework-skttk-solar-pv", code: "DESIGN", title: "Design", description: "Design", sequence: 3, status: "active", createdBy: "diagnostic-test" },
  ]).onConflictDoNothing();
  await db.insert(pathwayCompetencyUnitsTable).values([
    { id: "skttk-map-path-a-safe", pathwayId: "path-a", unitId: "skttk-u-safe-isolation", sequence: 1, createdBy: "diagnostic-test" },
    { id: "skttk-map-path-a-install", pathwayId: "path-a", unitId: "skttk-u-installation", sequence: 2, createdBy: "diagnostic-test" },
    { id: "skttk-map-path-a-design", pathwayId: "path-a", unitId: "skttk-u-design", sequence: 3, createdBy: "diagnostic-test" },
  ]).onConflictDoNothing();
  await db.insert(diagnosticTemplatesTable).values({ id: "diag-skttk-spv-v1", frameworkId: "framework-skttk-solar-pv", pathwayId: "path-a", version: "1.0", name: "Diagnostic", description: "Fixture", status: "active", dimensions: ["Safety"], createdBy: "diagnostic-test" }).onConflictDoNothing();
  await db.insert(diagnosticQuestionsTable).values([
    { id: "diag-q-safety", templateId: "diag-skttk-spv-v1", frameworkId: "framework-skttk-solar-pv", competencyUnitId: "skttk-u-safe-isolation", dimension: "Safety", prompt: "Safety?", sequence: 1, createdBy: "diagnostic-test" },
    ...["knowledge", "practice", "evidence", "problem", "readiness"].map((name, i) => ({ id: `diag-q-${name}`, templateId: "diag-skttk-spv-v1", frameworkId: "framework-skttk-solar-pv", competencyUnitId: i < 3 ? "skttk-u-installation" : "skttk-u-design", dimension: name, prompt: `${name}?`, sequence: i + 2, createdBy: "diagnostic-test" })),
  ]).onConflictDoNothing();
  await db.insert(diagnosticOptionsTable).values([
    { id: "diag-o-safe", questionId: "diag-q-safety", code: "CRITICAL_FAILURE", label: "Unsafe", score: 0, safetyOutcome: "CRITICAL_SAFETY_FAILURE", createdBy: "diagnostic-test" },
    { id: "diag-o-safe-ok", questionId: "diag-q-safety", code: "SAFE_SEQUENCE", label: "Safe", score: 3, safetyOutcome: "SAFE", createdBy: "diagnostic-test" },
    ...["knowledge", "practice", "evidence", "problem", "readiness"].flatMap(q => [
      { id: `diag-q-${q}-low`, questionId: `diag-q-${q}`, code: "LOW", label: "Low", score: 0, createdBy: "diagnostic-test" },
      { id: `diag-q-${q}-developing`, questionId: `diag-q-${q}`, code: "DEVELOPING", label: "Developing", score: 2, createdBy: "diagnostic-test" },
      { id: `diag-q-${q}-strong`, questionId: `diag-q-${q}`, code: "STRONG", label: "Strong", score: 3, createdBy: "diagnostic-test" },
    ]),
  ]).onConflictDoNothing();
  await cleanup();
  await db.insert(peopleTable).values([
    { id: learnerA, name: "Diagnostic A", initials: "DA", email: `${learnerA}@test`, role: "learner", organization: "test", createdBy: learnerA },
    { id: learnerB, name: "Diagnostic B", initials: "DB", email: `${learnerB}@test`, role: "learner", organization: "test", createdBy: learnerB },
    { id: learnerC, name: "Diagnostic C", initials: "DC", email: `${learnerC}@test`, role: "learner", organization: "test", createdBy: learnerC },
    { id: trainerA, name: "Diagnostic Trainer A", initials: "TA", email: `${trainerA}@test`, role: "trainer", clerkUserId: `clerk-${trainerA}`, organization: "test", createdBy: trainerA },
    { id: trainerB, name: "Diagnostic Trainer B", initials: "TB", email: `${trainerB}@test`, role: "trainer", clerkUserId: `clerk-${trainerB}`, organization: "test", createdBy: trainerB },
  ]);
  await db.insert(personRolesTable).values([
    { personId: trainerA, role: "trainer", createdBy: trainerA },
    { personId: trainerB, role: "trainer", createdBy: trainerB },
  ]);
  await db.insert(enrollmentsTable).values([
    { id: enrollmentA, learnerId: learnerA, programId: "solar-pv-tech", pathwayId: "path-a", trainerId: trainerA, assessorId: null, createdBy: learnerA },
    { id: enrollmentB, learnerId: learnerB, programId: "solar-pv-tech", pathwayId: "path-a", trainerId: trainerB, assessorId: null, createdBy: learnerB },
    { id: enrollmentC, learnerId: learnerC, programId: "solar-pv-tech", pathwayId: "path-b", trainerId: trainerA, assessorId: null, status: "inactive", createdBy: learnerC },
  ]);
  const app = createIntegrationTestApp(req => {
    const identity = req.get("x-diagnostic-learner");
    if (identity === "a") return { userId: learnerA, role: "learner", learnerId: learnerA };
    if (identity === "b") return { userId: learnerB, role: "learner", learnerId: learnerB };
    if (identity === "c") return { userId: learnerC, role: "learner", learnerId: learnerC };
    if (identity === "trainer-a") return { userId: `clerk-${trainerA}`, role: "trainer" };
    if (identity === "trainer-b") return { userId: `clerk-${trainerB}`, role: "trainer" };
    return { userId: null, role: null };
  });
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  type TestIdentity = "a" | "b" | "c" | "trainer-a" | "trainer-b";
  const request = async <T>(path: string, options: RequestInit = {}, expected = 200, who?: TestIdentity): Promise<T> => {
    const response = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(who ? { "x-diagnostic-learner": who } : {}), ...options.headers } });
    if (response.status !== expected) throw new Error(`${options.method ?? "GET"} ${path}: expected ${expected}, got ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const put = (path: string, body: unknown, expected = 200, who: TestIdentity | undefined = "a") => request<any>(path, { method: "PUT", body: JSON.stringify(body) }, expected, who);
  try {
    const [beforeA, beforeB] = await Promise.all([request<any>("/diagnostic", {}, 200, "a"), request<any>("/diagnostic", {}, 200, "b")]);
    assert(beforeA.template.id === "diag-skttk-spv-v1" && beforeA.session === null && beforeA.questions.length === 6, "diagnostic template output was not validated");
    assert(beforeB.session === null && beforeB.responses?.length === 0, "diagnostic state leaked between learners");
    await request("/diagnostic", {}, 404, "c");
    const safety = beforeA.questions.find((q: any) => q.id === "diag-q-safety");
    const sessionA = await request<any>("/diagnostic/sessions", { method: "POST", body: "{}" }, 201, "a");
    const sessionB = await request<any>("/diagnostic/sessions", { method: "POST", body: "{}" }, 201, "b");
    assert(sessionA.id !== sessionB.id, "sessions were not isolated");
    const crossSaveBody = { progress: 25, responses: [{ questionId: safety.id, optionId: "diag-o-safe" }] };
    const beforeCrossSessions = await db.select().from(diagnosticSessionsTable).where(inArray(diagnosticSessionsTable.id, [sessionA.id, sessionB.id]));
    const beforeCrossResponses = await db.select().from(diagnosticResponsesTable).where(inArray(diagnosticResponsesTable.sessionId, [sessionA.id, sessionB.id]));
    await put(`/diagnostic/sessions/${sessionA.id}/responses`, crossSaveBody, 404, "b");
    await put(`/diagnostic/sessions/${sessionB.id}/responses`, crossSaveBody, 404, "a");
    await request(`/diagnostic/sessions/${sessionA.id}/complete`, { method: "POST", body: "{}" }, 404, "b");
    await request(`/diagnostic/sessions/${sessionB.id}/complete`, { method: "POST", body: "{}" }, 404, "a");
    const afterCrossSessions = await db.select().from(diagnosticSessionsTable).where(inArray(diagnosticSessionsTable.id, [sessionA.id, sessionB.id]));
    const afterCrossResponses = await db.select().from(diagnosticResponsesTable).where(inArray(diagnosticResponsesTable.sessionId, [sessionA.id, sessionB.id]));
    assert(JSON.stringify(afterCrossSessions) === JSON.stringify(beforeCrossSessions), "cross-account access changed another learner's diagnostic attempt");
    assert(JSON.stringify(afterCrossResponses) === JSON.stringify(beforeCrossResponses), "cross-account access changed another learner's diagnostic answers");
    const invalid = await put(`/diagnostic/sessions/${sessionA.id}/responses`, { progress: 10, responses: [{ questionId: safety.id, optionId: "wrong-option" }] }, 400);
    assert(invalid.error === "INVALID_DIAGNOSTIC_QUESTION_OR_OPTION", "invalid question/option was not rejected with a useful error");
    const options = await db.select().from(diagnosticOptionsTable);
    const option = (q: string, code: string) => options.find(o => o.questionId === q && o.code === code)!.id;
    const low = ["diag-q-knowledge", "diag-q-practice", "diag-q-evidence", "diag-q-problem", "diag-q-readiness"].map(q => ({ questionId: q, optionId: option(q, "LOW") }));
    const incomplete = await put(`/diagnostic/sessions/${sessionA.id}/responses`, { progress: 100, responses: [{ questionId: "diag-q-safety", optionId: option("diag-q-safety", "SAFE_SEQUENCE") }] }, 400);
    assert(incomplete.error === "REQUIRED_DIAGNOSTIC_ANSWERS_MISSING", "completion did not reject missing required answers");
    await put(`/diagnostic/sessions/${sessionA.id}/responses`, { progress: 50, responses: low.slice(0, 2) });
    const resumed = await request<any>("/diagnostic", {}, 200, "a");
    assert(resumed.session.id === sessionA.id && resumed.responses.length === 2, "saved responses did not resume through GET");
    const completeBody = { progress: 100, responses: [
      { questionId: "diag-q-safety", optionId: option("diag-q-safety", "CRITICAL_FAILURE") },
      { questionId: "diag-q-knowledge", optionId: option("diag-q-knowledge", "STRONG") },
      { questionId: "diag-q-practice", optionId: option("diag-q-practice", "LOW") },
      { questionId: "diag-q-evidence", optionId: option("diag-q-evidence", "LOW") },
      { questionId: "diag-q-problem", optionId: option("diag-q-problem", "STRONG") },
      { questionId: "diag-q-readiness", optionId: option("diag-q-readiness", "DEVELOPING") },
    ] };
    await put(`/diagnostic/sessions/${sessionA.id}/responses`, completeBody);
    const readinessBefore = await request<any>("/readiness", {}, 200, "a");
    const [completed1, completed2] = await Promise.all([
      request<any>(`/diagnostic/sessions/${sessionA.id}/complete`, { method: "POST", body: "{}" }, 200, "a"),
      request<any>(`/diagnostic/sessions/${sessionA.id}/complete`, { method: "POST", body: "{}" }, 200, "a"),
    ]);
    assert(completed1.id === completed2.id && completed1.safetyOverride === true, "concurrent completion was not idempotent");
    assert(completed1.pathwayId === "path-a" && Object.values(completed1.dimensionSummaries).some((score: any) => score > 0 && score <= 100), "profile dimensions were not normalized from answered options");
    assert(completed1.items.every((item: any) => Number.isInteger(item.score) && item.score >= 0 && item.score <= 100), "profile item scores were not normalized to 0-100");
    const profile = await request<any>("/competency-profile", {}, 200, "a");
    const map = await request<any>("/readiness-map", {}, 200, "a");
    assert(profile.id === completed1.id && map.profile.id === profile.id, "profile/readiness-map output failed validation");
    assert(map.profile.gaps.filter((g: any) => g.severity === "CRITICAL").every((g: any) => g.competencyUnitId === "skttk-u-safe-isolation"), "safety remediation was not scoped to the linked unit");
    assert(map.profile.recommendations.filter((r: any) => r.priority === "URGENT").every((r: any) => r.competencyUnitId === "skttk-u-safe-isolation"), "highest-priority safety remediation leaked to another unit");
    assert(map.profile.recommendations.some((r: any) => r.competencyUnitId === "skttk-u-installation" && r.priority === "HIGH"), "low practice/evidence did not produce mapped recommendations");
    assert((await request<any>("/diagnostic", {}, 200, "a")).responses.length === 6, "completed responses were not returned");
    const audits = await db.select({ action: diagnosticAuditEventsTable.action, details: diagnosticAuditEventsTable.details }).from(diagnosticAuditEventsTable).where(eq(diagnosticAuditEventsTable.sessionId, sessionA.id));
    assert(["diagnostic_started", "responses_saved", "profile_generated", "gap_generated", "recommendation_generated", "diagnostic_completed"].every(action => audits.some(a => a.action === action)), "audit event names were incomplete");
    assert(audits.every(a => !JSON.stringify(a.details).includes("I would work live")), "audit stored response content");
    const readinessAfter = await request<any>("/readiness", {}, 200, "a");
    const stableReadiness = ({ evaluatedAt: _evaluatedAt, ...value }: Record<string, unknown>) => value;
    assert(JSON.stringify(stableReadiness(readinessBefore)) === JSON.stringify(stableReadiness(readinessAfter)), "canonical readiness changed after diagnostic completion");
    const bStillOwnsSession = await request<any>("/diagnostic", {}, 200, "b");
    assert(bStillOwnsSession.session.id === sessionB.id && bStillOwnsSession.session.status === "in_progress", "learner A completion leaked into learner B");
    const historicalSessionId = `diagnostic-session-historical-${suffix}`;
    const inactiveSessionId = `diagnostic-session-inactive-${suffix}`;
    const historicalProfileId = `diagnostic-profile-historical-${suffix}`;
    const inactiveProfileId = `diagnostic-profile-inactive-${suffix}`;
    await db.insert(diagnosticSessionsTable).values([
      { id: historicalSessionId, learnerId: learnerA, enrollmentId: enrollmentA, pathwayId: "path-b", templateId: "diag-skttk-spv-v1", frameworkId: "framework-skttk-solar-pv", status: "completed", progress: 100, completedAt: new Date(), createdBy: learnerA },
      { id: inactiveSessionId, learnerId: learnerC, enrollmentId: enrollmentC, pathwayId: "path-b", templateId: "diag-skttk-spv-v1", frameworkId: "framework-skttk-solar-pv", status: "completed", progress: 100, completedAt: new Date(), createdBy: learnerC },
    ]);
    await db.insert(diagnosticProfilesTable).values([
      { id: historicalProfileId, sessionId: historicalSessionId, learnerId: learnerA, pathwayId: "path-b", frameworkId: "framework-skttk-solar-pv", frameworkVersion: "1.0", currentState: "HISTORICAL_PROFILE_MUST_NOT_LEAK", dimensionSummaries: { Historical: 99 }, completedAt: new Date(), createdBy: learnerA },
      { id: inactiveProfileId, sessionId: inactiveSessionId, learnerId: learnerC, pathwayId: "path-b", frameworkId: "framework-skttk-solar-pv", frameworkVersion: "1.0", currentState: "INACTIVE_PROFILE_MUST_NOT_LEAK", dimensionSummaries: { Inactive: 98 }, completedAt: new Date(), createdBy: learnerC },
    ]);
    await db.insert(diagnosticGapsTable).values([
      { id: `diagnostic-gap-historical-${suffix}`, profileId: historicalProfileId, competencyUnitId: "skttk-u-design", frameworkId: "framework-skttk-solar-pv", diagnosis: "HISTORICAL_GAP_MUST_NOT_LEAK", severity: "Critical", createdBy: learnerA },
      { id: `diagnostic-gap-inactive-${suffix}`, profileId: inactiveProfileId, competencyUnitId: "skttk-u-design", frameworkId: "framework-skttk-solar-pv", diagnosis: "INACTIVE_GAP_MUST_NOT_LEAK", severity: "Critical", createdBy: learnerC },
    ]);
    await db.insert(diagnosticRecommendationsTable).values([
      { id: `diagnostic-recommendation-historical-${suffix}`, profileId: historicalProfileId, competencyUnitId: "skttk-u-design", frameworkId: "framework-skttk-solar-pv", kind: "module", title: "HISTORICAL_RECOMMENDATION_MUST_NOT_LEAK", rationale: "Historical pathway", priority: "Critical", createdBy: learnerA },
      { id: `diagnostic-recommendation-inactive-${suffix}`, profileId: inactiveProfileId, competencyUnitId: "skttk-u-design", frameworkId: "framework-skttk-solar-pv", kind: "module", title: "INACTIVE_RECOMMENDATION_MUST_NOT_LEAK", rationale: "Inactive assignment", priority: "Critical", createdBy: learnerC },
    ]);
    await db.insert(diagnosticSafetyFlagsTable).values([
      { id: `diagnostic-safety-historical-${suffix}`, profileId: historicalProfileId, competencyUnitId: "skttk-u-design", code: "HISTORICAL_SAFETY_MUST_NOT_LEAK", severity: "Critical", detail: "Historical pathway", createdBy: learnerA },
      { id: `diagnostic-safety-inactive-${suffix}`, profileId: inactiveProfileId, competencyUnitId: "skttk-u-design", code: "INACTIVE_SAFETY_MUST_NOT_LEAK", severity: "Critical", detail: "Inactive assignment", createdBy: learnerC },
    ]);
    const [trainerADashboard, trainerBDashboard] = await Promise.all([
      request<any>("/trainer/dashboard", {}, 200, "trainer-a"),
      request<any>("/trainer/dashboard", {}, 200, "trainer-b"),
    ]);
    assert(trainerADashboard.diagnosticFollowUps.length === 1 && trainerADashboard.diagnosticFollowUps[0].learnerId === learnerA && trainerADashboard.diagnosticFollowUps[0].pathwayId === "path-a", "Trainer A diagnostic follow-ups escaped its active learner/pathway assignment");
    assert(trainerADashboard.diagnosticFollowUps[0].currentState === completed1.currentState && trainerADashboard.diagnosticFollowUps[0].gaps.length > 0 && trainerADashboard.diagnosticFollowUps[0].recommendations.length > 0 && trainerADashboard.diagnosticFollowUps[0].safetyFindings.length > 0, "Trainer A did not receive its assigned learner diagnostic summary");
    assert(trainerBDashboard.diagnosticFollowUps.length === 1 && trainerBDashboard.diagnosticFollowUps[0].learnerId === learnerB && trainerBDashboard.diagnosticFollowUps[0].pathwayId === "path-a", "Trainer B diagnostic follow-ups escaped its active learner/pathway assignment");
    assert(trainerBDashboard.diagnosticFollowUps[0].completedAt === null && trainerBDashboard.diagnosticFollowUps[0].baselineScore === null && trainerBDashboard.diagnosticFollowUps[0].gaps.length === 0 && trainerBDashboard.diagnosticFollowUps[0].recommendations.length === 0 && trainerBDashboard.diagnosticFollowUps[0].safetyFindings.length === 0, "Learner without a completed profile was omitted or populated from another assignment");
    const serializedTrainerDashboards = JSON.stringify([trainerADashboard.diagnosticFollowUps, trainerBDashboard.diagnosticFollowUps]);
    assert(!serializedTrainerDashboards.includes("MUST_NOT_LEAK") && !serializedTrainerDashboards.includes(learnerC), "Historical or inactive diagnostic data leaked into a trainer dashboard");
    const recommendation = trainerADashboard.diagnosticFollowUps[0].recommendations[0];
    assert(Array.isArray(recommendation.followUps) && recommendation.followUps.length === 0, "New recommendation unexpectedly had follow-up history");
    const readinessBeforeFollowUp = await request<any>("/readiness", {}, 200, "a");
    await request(`/trainer/diagnostic-recommendations/${recommendation.id}/follow-ups`, { method: "POST", body: JSON.stringify({ status: "planned", targetAt: "2026-10-01T12:00:00.000Z", note: "Schedule supervised practice" }) }, 403, "trainer-b");
    await request(`/trainer/diagnostic-recommendations/diagnostic-recommendation-historical-${suffix}/follow-ups`, { method: "POST", body: JSON.stringify({ status: "planned", note: "Must not be written" }) }, 403, "trainer-a");
    const firstFollowUp = await request<any>(`/trainer/diagnostic-recommendations/${recommendation.id}/follow-ups`, { method: "POST", body: JSON.stringify({ status: "planned", targetAt: "2026-10-01T12:00:00.000Z", note: "Schedule supervised practice" }) }, 201, "trainer-a");
    const secondFollowUp = await request<any>(`/trainer/diagnostic-recommendations/${recommendation.id}/follow-ups`, { method: "POST", body: JSON.stringify({ status: "in_progress", targetAt: null, note: "Practice is underway" }) }, 201, "trainer-a");
    assert(firstFollowUp.trainerId === trainerA && firstFollowUp.trainerName === "Diagnostic Trainer A" && firstFollowUp.status === "planned", "Follow-up did not record trainer identity and status");
    assert(secondFollowUp.status === "in_progress" && secondFollowUp.note === "Practice is underway", "Follow-up status change was not recorded");
    const storedFollowUps = await db.select().from(diagnosticRecommendationFollowUpsTable).where(eq(diagnosticRecommendationFollowUpsTable.recommendationId, recommendation.id));
    assert(storedFollowUps.length === 2, "Follow-up changes were not append-only");
    const dashboardAfterFollowUp = await request<any>("/trainer/dashboard", {}, 200, "trainer-a");
    const dashboardRecommendation = dashboardAfterFollowUp.diagnosticFollowUps[0].recommendations.find((item: any) => item.id === recommendation.id);
    assert(dashboardRecommendation.followUps.length === 2 && dashboardRecommendation.followUps[0].status === "in_progress", "Latest follow-up status was not visible on the learner card");
    const readinessAfterFollowUp = await request<any>("/readiness", {}, 200, "a");
    assert(JSON.stringify(stableReadiness(readinessBeforeFollowUp)) === JSON.stringify(stableReadiness(readinessAfterFollowUp)), "Operational follow-up changed learner readiness");
    const [dashboardA, dashboardB, journeyA, journeyB] = await Promise.all([
      request<any>("/learner/dashboard", {}, 200, "a"),
      request<any>("/learner/dashboard", {}, 200, "b"),
      request<any[]>("/learner/journey", {}, 200, "a"),
      request<any[]>("/learner/journey", {}, 200, "b"),
    ]);
    assert(dashboardA.learner.id === learnerA && dashboardA.diagnostic.status === "completed", "learner A dashboard did not use learner A diagnostic");
    assert(dashboardB.learner.id === learnerB && dashboardB.diagnostic.status === "in_progress", "learner B dashboard did not use learner B diagnostic");
    assert(journeyA.find(step => step.id === "journey-diagnostic")?.status === "Complete", "learner A journey did not use learner A result");
    assert(journeyB.find(step => step.id === "journey-diagnostic")?.status === "Active", "learner B journey leaked learner A completion");
    for (const path of ["/diagnostic", "/diagnostic/sessions", "/competency-profile", "/readiness-map", "/learner/dashboard", "/learner/journey"]) {
      await request(path, path === "/diagnostic/sessions" ? { method: "POST", body: "{}" } : {}, 401);
    }
    await request(`/diagnostic/sessions/${sessionA.id}/responses`, { method: "PUT", body: JSON.stringify(crossSaveBody) }, 401);
    await request(`/diagnostic/sessions/${sessionA.id}/complete`, { method: "POST", body: "{}" }, 401);
    const stored = await db.select().from(diagnosticResponsesTable).where(eq(diagnosticResponsesTable.sessionId, sessionA.id));
    assert(stored.length === 6, "response upsert did not preserve one row per question");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await cleanup();
    if (previousDemoAccess === undefined) delete process.env.TERAS_ENABLE_DEMO_ACCESS;
    else process.env.TERAS_ENABLE_DEMO_ACCESS = previousDemoAccess;
  }
}
run().then(() => process.stdout.write("Diagnostic integration check passed\n")).catch(error => { console.error(error); process.exitCode = 1; });