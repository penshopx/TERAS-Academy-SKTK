import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, pool, diagnosticAuditEventsTable, diagnosticGapsTable, diagnosticOptionsTable,
  diagnosticProfileItemsTable, diagnosticProfilesTable, diagnosticRecommendationsTable,
  diagnosticResponsesTable, diagnosticSafetyFlagsTable, diagnosticSessionsTable,
  enrollmentsTable, peopleTable, programsTable, pathwaysTable, competencyFrameworksTable,
  competencyUnitsTable, pathwayCompetencyUnitsTable, diagnosticTemplatesTable,
  diagnosticQuestionsTable,
} from "@workspace/db";
import { createIntegrationTestApp } from "./integration-test-app";

const suffix = crypto.randomUUID();
const learnerA = `diagnostic-a-${suffix}`;
const learnerB = `diagnostic-b-${suffix}`;
const enrollmentA = `diagnostic-enrol-a-${suffix}`;
const enrollmentB = `diagnostic-enrol-b-${suffix}`;
const ids = [learnerA, learnerB];
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function cleanup() {
  const sessions = await db.select({ id: diagnosticSessionsTable.id }).from(diagnosticSessionsTable).where(inArray(diagnosticSessionsTable.learnerId, ids));
  const sessionIds = sessions.map(x => x.id);
  if (sessionIds.length) {
    const profiles = await db.select({ id: diagnosticProfilesTable.id }).from(diagnosticProfilesTable).where(inArray(diagnosticProfilesTable.sessionId, sessionIds));
    const profileIds = profiles.map(x => x.id);
    if (profileIds.length) {
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
  await db.delete(enrollmentsTable).where(inArray(enrollmentsTable.id, [enrollmentA, enrollmentB]));
  await db.delete(peopleTable).where(inArray(peopleTable.id, ids));
}

async function run() {
  const migration = await readFile(new URL("../../../lib/db/migrations/0017_diagnostic.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await db.insert(programsTable).values({ id: "solar-pv-tech", domain: "renewable", name: "Solar PV", description: "Fixture", status: "active", createdBy: "diagnostic-test" }).onConflictDoNothing();
  await db.insert(pathwaysTable).values({ id: "path-a", programId: "solar-pv-tech", name: "Path A", type: "standard", outcome: "Technician", status: "active", createdBy: "diagnostic-test" }).onConflictDoNothing();
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
  ]);
  await db.insert(enrollmentsTable).values([
    { id: enrollmentA, learnerId: learnerA, programId: "solar-pv-tech", pathwayId: "path-a", trainerId: null, assessorId: null, createdBy: learnerA },
    { id: enrollmentB, learnerId: learnerB, programId: "solar-pv-tech", pathwayId: "path-a", trainerId: null, assessorId: null, createdBy: learnerB },
  ]);
  const app = createIntegrationTestApp(req => {
    const id = req.get("x-diagnostic-learner");
    return { userId: id === "b" ? learnerB : learnerA, role: "learner", learnerId: id === "b" ? learnerB : learnerA };
  });
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = async <T>(path: string, options: RequestInit = {}, expected = 200, who = "a"): Promise<T> => {
    const response = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", "x-diagnostic-learner": who, ...options.headers } });
    if (response.status !== expected) throw new Error(`${options.method ?? "GET"} ${path}: expected ${expected}, got ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const put = (path: string, body: unknown, expected = 200, who = "a") => request<any>(path, { method: "PUT", body: JSON.stringify(body) }, expected, who);
  try {
    const [beforeA, beforeB] = await Promise.all([request<any>("/diagnostic"), request<any>("/diagnostic", {}, 200, "b")]);
    assert(beforeA.template.id === "diag-skttk-spv-v1" && beforeA.session === null && beforeA.questions.length === 6, "diagnostic template output was not validated");
    assert(beforeB.session === null && beforeB.responses?.length === 0, "diagnostic state leaked between learners");
    const safety = beforeA.questions.find((q: any) => q.id === "diag-q-safety");
    const sessionA = await request<any>("/diagnostic/sessions", { method: "POST", body: "{}" }, 201);
    const sessionB = await request<any>("/diagnostic/sessions", { method: "POST", body: "{}" }, 201, "b");
    assert(sessionA.id !== sessionB.id, "sessions were not isolated");
    const invalid = await put(`/diagnostic/sessions/${sessionA.id}/responses`, { progress: 10, responses: [{ questionId: safety.id, optionId: "wrong-option" }] }, 400);
    assert(invalid.error === "INVALID_DIAGNOSTIC_QUESTION_OR_OPTION", "invalid question/option was not rejected with a useful error");
    const options = await db.select().from(diagnosticOptionsTable);
    const option = (q: string, code: string) => options.find(o => o.questionId === q && o.code === code)!.id;
    const low = ["diag-q-knowledge", "diag-q-practice", "diag-q-evidence", "diag-q-problem", "diag-q-readiness"].map(q => ({ questionId: q, optionId: option(q, "LOW") }));
    const incomplete = await put(`/diagnostic/sessions/${sessionA.id}/responses`, { progress: 100, responses: [{ questionId: "diag-q-safety", optionId: option("diag-q-safety", "SAFE_SEQUENCE") }] }, 400);
    assert(incomplete.error === "REQUIRED_DIAGNOSTIC_ANSWERS_MISSING", "completion did not reject missing required answers");
    await put(`/diagnostic/sessions/${sessionA.id}/responses`, { progress: 50, responses: low.slice(0, 2) });
    const resumed = await request<any>("/diagnostic", {});
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
    const readinessBefore = await request<any>("/readiness");
    const [completed1, completed2] = await Promise.all([
      request<any>(`/diagnostic/sessions/${sessionA.id}/complete`, { method: "POST", body: "{}" }),
      request<any>(`/diagnostic/sessions/${sessionA.id}/complete`, { method: "POST", body: "{}" }),
    ]);
    assert(completed1.id === completed2.id && completed1.safetyOverride === true, "concurrent completion was not idempotent");
    assert(completed1.pathwayId === "path-a" && Object.values(completed1.dimensionSummaries).some((score: any) => score > 0 && score <= 100), "profile dimensions were not normalized from answered options");
    assert(completed1.items.every((item: any) => Number.isInteger(item.score) && item.score >= 0 && item.score <= 100), "profile item scores were not normalized to 0-100");
    const profile = await request<any>("/competency-profile");
    const map = await request<any>("/readiness-map");
    assert(profile.id === completed1.id && map.profile.id === profile.id, "profile/readiness-map output failed validation");
    assert(map.profile.gaps.filter((g: any) => g.severity === "CRITICAL").every((g: any) => g.competencyUnitId === "skttk-u-safe-isolation"), "safety remediation was not scoped to the linked unit");
    assert(map.profile.recommendations.filter((r: any) => r.priority === "URGENT").every((r: any) => r.competencyUnitId === "skttk-u-safe-isolation"), "highest-priority safety remediation leaked to another unit");
    assert(map.profile.recommendations.some((r: any) => r.competencyUnitId === "skttk-u-installation" && r.priority === "HIGH"), "low practice/evidence did not produce mapped recommendations");
    assert((await request<any>("/diagnostic", {})).responses.length === 6, "completed responses were not returned");
    const audits = await db.select({ action: diagnosticAuditEventsTable.action, details: diagnosticAuditEventsTable.details }).from(diagnosticAuditEventsTable).where(eq(diagnosticAuditEventsTable.sessionId, sessionA.id));
    assert(["diagnostic_started", "responses_saved", "profile_generated", "gap_generated", "recommendation_generated", "diagnostic_completed"].every(action => audits.some(a => a.action === action)), "audit event names were incomplete");
    assert(audits.every(a => !JSON.stringify(a.details).includes("I would work live")), "audit stored response content");
    const readinessAfter = await request<any>("/readiness");
    assert(JSON.stringify(readinessBefore) === JSON.stringify(readinessAfter), "canonical readiness changed after diagnostic completion");
    const bStillOwnsSession = await request<any>("/diagnostic", {}, 200, "b");
    assert(bStillOwnsSession.session.id === sessionB.id && bStillOwnsSession.session.status === "in_progress", "learner A completion leaked into learner B");
    const stored = await db.select().from(diagnosticResponsesTable).where(eq(diagnosticResponsesTable.sessionId, sessionA.id));
    assert(stored.length === 6, "response upsert did not preserve one row per question");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await cleanup();
  }
}
run().then(() => process.stdout.write("Diagnostic integration check passed\n")).catch(error => { process.stderr.write(`${error}\n`); process.exitCode = 1; });