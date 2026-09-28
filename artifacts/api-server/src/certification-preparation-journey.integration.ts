/**
 * A single, fresh-database release journey.  Every identity below is created
 * through the admin API and all subsequent requests use those same identities.
 * The gate drops the database, so this deliberately has no demo cleanup path.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import {
  assessmentAttemptsTable, assessmentCriteriaTable, assessmentsTable, baselineModulesTable, contentResourcesTable, courseVersionsTable, coursesTable, db, evidenceRequirementsTable,
  competencyFrameworksTable, competencyFrameworkSourcesTable, competencyUnitsTable, diagnosticGapsTable, diagnosticOptionsTable, diagnosticQuestionsTable,
    diagnosticRecommendationsTable, diagnosticTemplatesTable, pathwayCompetencyUnitsTable, competencyUnitPracticeTasksTable,
  evidenceReviewsTable, enrollmentsTable, gapEventsTable, gapsTable, learningRecordLinksTable, learningTransitionEventsTable, reassessmentLinksTable, readinessEventsTable, readinessTransferEventsTable,
  learningBaselinesTable, learningBaselineVersionsTable, modulesTable, pathwaysTable, pathwayBaselineModulesTable, pathwayModuleContractsTable, regulatoryReferencesTable,
    practiceAttemptsTable, practiceReviewsTable, remediationActivitiesTable, remediationEventsTable, remediationPlansTable,
    practiceTasksTable, readinessGatesTable,
} from "@workspace/db";
import { createIntegrationTestApp } from "./integration-test-app";
import { ObjectStorageService } from "./lib/objectStorage";
import { workspaceAssignmentContexts } from "./lib/teras";

const run = crypto.randomUUID();
const pathAGoldenJourney = process.env.TERAS_PATH_A_GOLDEN_JOURNEY === "1";
// Keep the existing certification-preparation fixture semantics unchanged;
// Path A opts into its explicit purpose only in the dedicated gate.
const pathwayPurpose = pathAGoldenJourney ? "capability-development" : "unspecified";
const terminalPortfolio = pathAGoldenJourney ? "Capability Portfolio" : "Certification Readiness Portfolio";
const storageScope = (process.env.TERAS_GATE_STORAGE_NAMESPACE ?? "local-test").replace(/[^a-zA-Z0-9._-]/g, "-");
const id = (kind: string) => `gate-${run}-${kind}`;
const secondModule = id("second-module"), secondTask = id("second-task");
const ids = {
  admin: id("admin"), learner: id("learner"), otherLearner: id("other-learner"),
  trainer: id("trainer"), assessor: id("assessor"), otherTrainer: id("other-trainer"), otherAssessor: id("other-assessor"),
  program: id("program"), otherProgram: id("other-program"), path: id("path"),
  otherPath: id("other-path"), cohort: id("cohort"), enrollment: id("enrollment"),
  module: id("module"), task: id("task"), assessment: id("assessment"), gate: id("gate"),
  course: id("course"), draft: id("draft"), objectPath: `/objects/uploads/${storageScope}-${run}.pdf`,
};
class GateStorageAdapter {
  readonly objects = new Map<string, { bytes: string; mime: string; owner: string | null; verified: unknown }>();
  constructor(readonly namespace: string, readonly path: string) { assert(path.includes(namespace.replace(/[^a-zA-Z0-9._-]/g, "-"))); this.objects.set(path, { bytes: "gate protected media", mime: "application/pdf", owner: null, verified: null }); }
  record(path: string) { const object = this.objects.get(path); assert(object, `storage path outside ${this.namespace}`); return object; }
}
const storage = new GateStorageAdapter(process.env.TERAS_GATE_STORAGE_NAMESPACE ?? "local-test", ids.objectPath);
ObjectStorageService.prototype.getObjectEntityUploadURL = async () => `https://storage.googleapis.com/test/${run}.pdf`;
ObjectStorageService.prototype.normalizeObjectEntityPath = () => ids.objectPath;
ObjectStorageService.prototype.verifyUploadedMetadata = async (path, expected) => { storage.record(path).verified = expected; };
ObjectStorageService.prototype.setPrivateOwner = async (path, value) => { storage.record(path).owner = value; };
ObjectStorageService.prototype.ownerCanRead = async (path, value) => storage.record(path).owner === value;
ObjectStorageService.prototype.getObjectEntityFile = async (path) => path as never;
ObjectStorageService.prototype.downloadObject = async (path) => { const object = storage.record(path as unknown as string); return new Response(object.bytes, { headers: { "content-type": object.mime } }); };

type Role = "admin" | "learner" | "trainer" | "assessor" | "none";
async function main() {
  const app = createIntegrationTestApp(req => {
    const role = (req.get("x-gate-role") || "none") as Role;
    const users: Record<Role, string | null> = { admin: ids.admin, learner: ids.learner, trainer: ids.trainer, assessor: ids.assessor, none: null };
    if (role === "learner" && req.get("x-gate-other") === "1") return { userId: ids.otherLearner, role, learnerId: ids.otherLearner };
    if (role === "trainer" && req.get("x-gate-other") === "1") return { userId: ids.otherTrainer, role, learnerId: ids.otherLearner };
    if (role === "assessor" && req.get("x-gate-other") === "1") return { userId: ids.otherAssessor, role, learnerId: ids.otherLearner };
    return {
      userId: users[role],
      role: role === "none" ? null : role,
      learnerId: role === "learner" || role === "trainer" || role === "assessor" ? ids.learner : undefined,
    };
  });
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const address = server.address() as AddressInfo;
  const request = async (path: string, role: Role, body?: unknown, method = body === undefined ? "GET" : "POST", other = false) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, { method, headers: { "content-type": "application/json", "x-gate-role": role, ...(other ? { "x-gate-other": "1" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return response;
  };
  const expect = async (path: string, role: Role, body: unknown, status = 201, method = "POST") => {
    const response = await request(path, role, body, method);
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return response.json() as Promise<any>;
  };
  try {
    // Admin owns the identities, programme, pathway, cohort and active enrollment.
    for (const [person, name, role] of [[ids.learner, "Gate Learner", "learner"], [ids.otherLearner, "Other Learner", "learner"], [ids.trainer, "Gate Instructor", "trainer"], [ids.otherTrainer, "Other Instructor", "trainer"], [ids.assessor, "Gate Validator", "assessor"], [ids.otherAssessor, "Other Validator", "assessor"]] as const)
      await expect("/admin/users", "admin", { id: person, name, initials: name.slice(0, 2), email: `${person}@test.invalid`, clerkUserId: person, organization: null, status: "active", roles: [role] });
    await expect("/admin/programs", "admin", { id: ids.program, domain: "Gate", name: pathAGoldenJourney ? "Capability development" : "Certification preparation", description: "run scoped", status: "active" });
    await expect("/admin/programs", "admin", { id: ids.otherProgram, domain: "Other", name: "Other program", description: "run scoped", status: "active" });
    await expect("/admin/pathways", "admin", { id: ids.path, programId: ids.program, name: pathAGoldenJourney ? "Capability pathway" : "Preparation pathway", type: "Standard", purpose: pathAGoldenJourney ? "unspecified" : pathwayPurpose, outcome: "Internal readiness", status: "active" });
    await expect("/admin/pathways", "admin", { id: ids.otherPath, programId: ids.otherProgram, name: "Other pathway", type: "Standard", outcome: "Other", status: "active" });
    if (pathAGoldenJourney) {
      const earlyBaseline = id("baseline");
      const earlyBaselineModule = id("baseline-module");
      await db.insert(modulesTable).values([
        { id: ids.module, programId: ids.program, pathwayId: ids.path, sequence: 1, code: "GATE", name: "Gate capability", capability: "Safe gate practice", evidence: "Observed record", learningOutcomes: [], theory: [] },
        { id: secondModule, programId: ids.program, pathwayId: ids.path, sequence: 2, code: "SECOND", name: "Second capability", capability: "Independent second capability", evidence: "Second record", learningOutcomes: [], theory: [] },
      ]);
      await db.insert(practiceTasksTable).values([
        { id: ids.task, moduleId: ids.module, title: "Gate task", description: "Practice", mode: "Observed", durationMinutes: 5, output: "Record" },
        { id: secondTask, moduleId: secondModule, title: "Second task", description: "Separate practice", mode: "Observed", durationMinutes: 5, output: "Second record" },
      ]);
      await db.insert(learningBaselinesTable).values({ id: earlyBaseline, code: id("baseline-code"), name: "Gate baseline", description: "Run-scoped shared learning baseline" });
      await db.insert(baselineModulesTable).values([
        { id: earlyBaselineModule, baselineId: earlyBaseline, moduleId: ids.module, sequence: 1, code: "M01", name: "Gate capability", learningOutcome: "Safe gate practice", evidenceId: "E01" },
        { id: id("second-baseline-module"), baselineId: earlyBaseline, moduleId: secondModule, sequence: 2, code: "M02", name: "Second capability", learningOutcome: "Independent second capability", evidenceId: "E02" },
      ]);
      await db.insert(pathwayBaselineModulesTable).values([
        { id: id("pathway-baseline-module"), pathwayId: ids.path, baselineModuleId: earlyBaselineModule, sequence: 1 },
        { id: id("second-pathway-baseline-module"), pathwayId: ids.path, baselineModuleId: id("second-baseline-module"), sequence: 2 },
      ]);
      const earlyVersion = id("baseline-version");
      await db.insert(learningBaselineVersionsTable).values({
        id: earlyVersion,
        baselineId: earlyBaseline,
        version: 1,
        status: "PUBLISHED",
        snapshot: {
          baselineId: earlyBaseline,
          modules: [
            { id: earlyBaselineModule, baselineId: earlyBaseline, moduleId: ids.module, code: "M01", name: "Gate capability" },
            { id: id("second-baseline-module"), baselineId: earlyBaseline, moduleId: secondModule, code: "M02", name: "Second capability" },
          ],
          selections: [
            { pathwayId: ids.path, baselineModuleId: earlyBaselineModule, sequence: 1 },
            { pathwayId: ids.path, baselineModuleId: id("second-baseline-module"), sequence: 2 },
          ],
        },
        publishedAt: new Date(),
        publishedBy: ids.trainer,
      });
      await db.update(learningBaselinesTable).set({ publishedVersionId: earlyVersion }).where(eq(learningBaselinesTable.id, earlyBaseline));
    }
    await expect("/admin/cohorts", "admin", { id: ids.cohort, programId: ids.program, name: `Cohort ${run}`, status: "active", startsOn: null, endsOn: null });
    if (pathAGoldenJourney) {
      // The enrollment is fixture authentication context; all learner journey
      // mutations below still use the authorized production routes.
      const baselineVersionId = id("baseline-version");
      await db.insert(enrollmentsTable).values([
        { id: ids.enrollment, learnerId: ids.learner, programId: ids.program, pathwayId: ids.path, trainerId: ids.trainer, assessorId: ids.assessor, cohortId: ids.cohort, status: "active", baselineVersionId, createdBy: ids.admin },
        { id: id("other-enrollment"), learnerId: ids.otherLearner, programId: ids.otherProgram, pathwayId: ids.otherPath, trainerId: ids.otherTrainer, assessorId: ids.otherAssessor, cohortId: null, status: "active", baselineVersionId: null, createdBy: ids.admin },
      ]);
    } else {
      await expect("/admin/enrollments", "admin", { id: ids.enrollment, learnerId: ids.learner, programId: ids.program, pathwayId: ids.path, trainerId: ids.trainer, assessorId: ids.assessor, cohortId: ids.cohort, status: "active" });
      await expect("/admin/enrollments", "admin", { id: id("other-enrollment"), learnerId: ids.otherLearner, programId: ids.otherProgram, pathwayId: ids.otherPath, trainerId: ids.otherTrainer, assessorId: ids.otherAssessor, cohortId: null, status: "active" });
    }
    const trainerAssignments = await workspaceAssignmentContexts(ids.trainer, "trainer");
    assert.equal(trainerAssignments.length, 1, "trainer fixture must have exactly one active assignment");
    assert.equal(trainerAssignments[0]?.program.id, ids.program, "trainer fixture must be assigned to the journey program");
    assert.equal(trainerAssignments[0]?.pathway.id, ids.path, "trainer fixture must be assigned to the journey pathway before authoring");
    assert.equal((await request("/admin/users", "learner")).status, 403, "cross-role admin access");

    if (!pathAGoldenJourney) await db.insert(modulesTable).values([
      { id: ids.module, programId: ids.program, pathwayId: ids.path, sequence: 1, code: "GATE", name: "Gate capability", capability: "Safe gate practice", evidence: "Observed record", learningOutcomes: [], theory: [] },
      { id: secondModule, programId: ids.program, pathwayId: ids.path, sequence: 2, code: "SECOND", name: "Second capability", capability: "Independent second capability", evidence: "Second record", learningOutcomes: [], theory: [] },
    ]);
    if (!pathAGoldenJourney) await db.insert(practiceTasksTable).values([
      { id: ids.task, moduleId: ids.module, title: "Gate task", description: "Practice", mode: "Observed", durationMinutes: 5, output: "Record" },
      { id: secondTask, moduleId: secondModule, title: "Second task", description: "Separate practice", mode: "Observed", durationMinutes: 5, output: "Second record" },
    ]);
    const frameworkId = id("framework"), competencyUnitId = id("competency-unit"), secondCompetencyUnitId = id("second-competency-unit");
    const diagnosticTemplateId = id("diagnostic-template"), diagnosticQuestionId = id("diagnostic-question"), secondDiagnosticQuestionId = id("second-diagnostic-question");
    const diagnosticOptionId = id("diagnostic-option"), secondDiagnosticOptionId = id("second-diagnostic-option");
    await db.insert(competencyFrameworksTable).values({ id: frameworkId, code: id("framework-code"), name: "Gate competency framework", description: "Run-scoped framework", domain: "Gate", version: "1.0", status: "active" });
    await db.insert(competencyUnitsTable).values([
      { id: competencyUnitId, frameworkId, code: "GATE-UNIT", title: "Safe gate practice", description: "Run-scoped capability", sequence: 1, status: "active" },
      { id: secondCompetencyUnitId, frameworkId, code: "SECOND-UNIT", title: "Second capability", description: "Separate capability", sequence: 2, status: "active" },
    ]);
    await db.insert(pathwayCompetencyUnitsTable).values([
      { id: id("pathway-competency-unit"), pathwayId: ids.path, unitId: competencyUnitId, sequence: 1 },
      { id: id("second-pathway-competency-unit"), pathwayId: ids.path, unitId: secondCompetencyUnitId, sequence: 2 },
    ]);
    await db.insert(competencyUnitPracticeTasksTable).values([
      { id: id("competency-practice"), unitId: competencyUnitId, taskId: ids.task },
      { id: id("second-competency-practice"), unitId: secondCompetencyUnitId, taskId: secondTask },
    ]);
    // This disposable gate database contains only synthetic competency content.
    // Exercise the production authority requirement without claiming that the
    // run-scoped framework or its units are official SKTTK content.
    const fixtureReferenceId = id("synthetic-reference");
    await db.insert(regulatoryReferencesTable).values({
      id: fixtureReferenceId, type: "TEST_FIXTURE", issuer: "Gate fixture", number: run, year: 2026,
      title: "Synthetic authority for isolated journey test", enactedDate: "2026-01-01",
      effectiveDate: "2026-01-01", beritaNegara: "Not a legal citation",
      authorityRole: "DOMAIN_AUTHORITY", status: "ACTIVE", contentSha256: "0".repeat(64),
    });
    await db.insert(competencyFrameworkSourcesTable).values({
      id: id("framework-source"), frameworkId, regulatoryReferenceId: fixtureReferenceId, provenanceType: "AUTHORITATIVE",
    });
    await db.update(competencyFrameworksTable).set({ authorityStatus: "AUTHORITATIVE" }).where(eq(competencyFrameworksTable.id, frameworkId));
    await db.insert(diagnosticTemplatesTable).values({ id: diagnosticTemplateId, frameworkId, pathwayId: ids.path, version: "1.0", name: "Gate diagnostic", description: "Run-scoped diagnostic", status: "active", dimensions: ["KNOWLEDGE"] });
    await db.insert(diagnosticQuestionsTable).values([
      { id: diagnosticQuestionId, templateId: diagnosticTemplateId, frameworkId, competencyUnitId, dimension: "KNOWLEDGE", prompt: "Can the learner complete the gate capability?", sequence: 1 },
      { id: secondDiagnosticQuestionId, templateId: diagnosticTemplateId, frameworkId, competencyUnitId: secondCompetencyUnitId, dimension: "KNOWLEDGE", prompt: "Can the learner complete the second capability?", sequence: 2 },
    ]);
    await db.insert(diagnosticOptionsTable).values([
      { id: diagnosticOptionId, questionId: diagnosticQuestionId, code: "GAP", label: "Needs guided development", score: 0 },
      { id: secondDiagnosticOptionId, questionId: secondDiagnosticQuestionId, code: "GAP", label: "Needs separate development", score: 0 },
    ]);
    const diagnosticSession = await expect("/diagnostic/sessions", "learner", {});
    await expect(`/diagnostic/sessions/${diagnosticSession.id}/responses`, "learner", { progress: 100, responses: [
      { questionId: diagnosticQuestionId, optionId: diagnosticOptionId },
      { questionId: secondDiagnosticQuestionId, optionId: secondDiagnosticOptionId },
    ] }, 200, "PUT");
    const diagnosticProfile = await expect(`/diagnostic/sessions/${diagnosticSession.id}/complete`, "learner", {}, 200);
    const profileGaps = (await db.select().from(diagnosticGapsTable)).filter(row => row.profileId === diagnosticProfile.id);
    const profileRecommendations = (await db.select().from(diagnosticRecommendationsTable)).filter(row => row.profileId === diagnosticProfile.id);
    const diagnosticGap = profileGaps.find(row => row.competencyUnitId === competencyUnitId);
    const secondDiagnosticGap = profileGaps.find(row => row.competencyUnitId === secondCompetencyUnitId);
    const diagnosticRecommendation = profileRecommendations.find(row => row.competencyUnitId === competencyUnitId);
    const secondDiagnosticRecommendation = profileRecommendations.find(row => row.competencyUnitId === secondCompetencyUnitId);
    assert(diagnosticGap && diagnosticRecommendation && secondDiagnosticGap && secondDiagnosticRecommendation, "diagnostic must persist module-scoped gaps and recommendations before learning");
    assert.equal(diagnosticRecommendation.moduleId, ids.module);
    assert.equal(secondDiagnosticRecommendation.moduleId, secondModule);

    // The authoring API creates the full publishable hierarchy and claims managed media.
    const baselineId = id("baseline"), baselineModuleId = id("baseline-module");
    if (!pathAGoldenJourney) await db.insert(learningBaselinesTable).values({ id: baselineId, code: id("baseline-code"), name: "Gate baseline", description: "Run-scoped shared learning baseline" });
    const secondBaselineModuleId = id("second-baseline-module");
    if (!pathAGoldenJourney) await db.insert(baselineModulesTable).values([
      { id: baselineModuleId, baselineId, moduleId: ids.module, sequence: 1, code: "M01", name: "Gate capability", learningOutcome: "Safe gate practice", evidenceId: "E01" },
      { id: secondBaselineModuleId, baselineId, moduleId: secondModule, sequence: 2, code: "M02", name: "Second capability", learningOutcome: "Independent second capability", evidenceId: "E02" },
    ]);
    if (!pathAGoldenJourney) await db.insert(pathwayBaselineModulesTable).values([
      { id: id("pathway-baseline-module"), pathwayId: ids.path, baselineModuleId, sequence: 1 },
      { id: id("second-pathway-baseline-module"), pathwayId: ids.path, baselineModuleId: secondBaselineModuleId, sequence: 2 },
    ]);
    if (pathAGoldenJourney) {
      // Enrollment is created before the run-scoped catalogue is published.
      // Promote the fixture pathway only after its canonical baseline exists.
      await db.update(pathwaysTable).set({ purpose: pathwayPurpose }).where(eq(pathwaysTable.id, ids.path));
    }
    const otherModule = id("other-module"), otherTask = id("other-task");
    await db.insert(modulesTable).values({ id: otherModule, programId: ids.otherProgram, pathwayId: ids.otherPath, sequence: 1, code: "OTHER", name: "Other capability", capability: "Other", evidence: "Other", learningOutcomes: [], theory: [] });
    await db.insert(practiceTasksTable).values({ id: otherTask, moduleId: otherModule, title: "Other task", description: "Other", mode: "Observed", durationMinutes: 5, output: "Other" });
    const author = async (body: object, status = 201) => expect("/trainer/authoring/commands", "trainer", body, status);
    await author({ action: "CREATE", entity: "COURSE", id: ids.course, courseId: ids.course, data: { programId: ids.program, pathwayId: ids.path, title: "Published course", description: "Safe content", sequence: 1 } });
    assert.equal((await request("/trainer/authoring/commands", "trainer", { action: "CREATE", entity: "COURSE", id: id("stolen"), courseId: ids.course, data: { programId: ids.program, pathwayId: ids.path, title: "stolen" } }, "POST", true)).status, 403, "unassigned instructor rejected");
    await author({ action: "CREATE", entity: "COURSE", id: ids.draft, courseId: ids.draft, data: { programId: ids.program, pathwayId: ids.path, title: "Draft course", description: "Hidden", sequence: 2 } });
    const link = await author({ action: "CREATE", entity: "COURSE_MODULE", courseId: ids.course, data: { moduleId: ids.module } });
    const lesson = await author({ action: "CREATE", entity: "LESSON", courseId: ids.course, data: { courseModuleId: link.id, title: "Learn", description: "Learn safely" } });
    const activity = await author({ action: "CREATE", entity: "ACTIVITY", courseId: ids.course, data: { lessonId: lesson.id, title: "Practice", description: "Practice safely", type: "READING" } });
    const outcome = await author({ action: "CREATE", entity: "OUTCOME", courseId: ids.course, data: { activityId: activity.id, capabilityModuleId: ids.module, description: "Outcome", verificationMethod: "TRAINER_REVIEW" } });
    await author({ action: "CREATE", entity: "RESOURCE", courseId: ids.course, data: { activityId: activity.id, type: "TEXT", title: "Guide", content: "Safe guide" } });
    const resourcesBeforeUnsafe = (await db.select().from(contentResourcesTable)).length;
    assert.equal((await request("/learning/resources", "trainer", { activityId: activity.id, type: "LINK", title: "unsafe", uri: "javascript:alert(1)" })).status, 400, "unsafe media rejected");
    assert.equal((await db.select().from(contentResourcesTable)).length, resourcesBeforeUnsafe);
    await expect("/storage/uploads/request-url", "trainer", { name: "guide.pdf", size: 1, contentType: "application/pdf" }, 200);
    await author({ action: "CREATE", entity: "RESOURCE", courseId: ids.course, data: { activityId: activity.id, type: "PDF", title: "Protected", objectPath: ids.objectPath, mimeType: "application/pdf" } });
    assert.deepEqual(storage.record(ids.objectPath).verified, { size: 1, mimeType: "application/pdf" });
    assert.equal(storage.record(ids.objectPath).owner, ids.trainer);
    assert.deepEqual([...storage.objects.keys()], [ids.objectPath]);
    assert.equal((await request("/storage" + ids.objectPath, "learner")).status, 404, "draft media hidden");
    const firstPublish = await expect(`/trainer/authoring/courses/${ids.course}/publish`, "trainer", {}, 201);
    const originalSnapshot = structuredClone((await db.select().from(courseVersionsTable)).find(row => row.courseId === ids.course && row.version === 1)!.snapshot);
    await author({ action: "UPDATE", entity: "LESSON", id: lesson.id, courseId: ids.course, data: { title: "Learn revised after v1" } }, 200);
    const publish = await Promise.all([request(`/trainer/authoring/courses/${ids.course}/publish`, "trainer", {}), request(`/trainer/authoring/courses/${ids.course}/publish`, "trainer", {})]);
    assert.deepEqual(publish.map(x => x.status).sort(), [201, 201], "concurrent publish serialized");
    const publishBodies = await Promise.all(publish.map(response => response.json() as Promise<any>));
    assert.deepEqual([firstPublish.version, ...publishBodies.map(item => item.version)].sort(), [1, 2, 3]);
    const versions = (await db.select().from(courseVersionsTable)).filter(row => row.courseId === ids.course);
    const [publishedCourse] = (await db.select().from(coursesTable)).filter(row => row.id === ids.course);
    assert.equal(versions.length, 3); assert.equal(publishedCourse.publishedVersionId, versions.find(row => row.version === 3)?.id);
    assert.deepEqual(versions.find(row => row.version === 1)?.snapshot, originalSnapshot, "v1 remains immutable after authoring update");
    assert(versions.filter(row => row.version > 1).every(row => JSON.stringify(row.snapshot).includes("Learn revised after v1")));
    assert(versions.every(row => JSON.stringify(row.snapshot).includes(ids.objectPath)), "immutable snapshots retain hierarchy and managed resource");
    const media = await request("/storage" + ids.objectPath, "learner"); assert.equal(media.status, 200); assert.equal(media.headers.get("content-type"), "application/pdf"); assert.equal(await media.text(), "gate protected media");
    assert.equal((await request("/storage" + ids.objectPath, "learner", undefined, "GET", true)).status, 403);
    assert.equal((await request("/storage" + ids.objectPath, "trainer", undefined, "GET", true)).status, 403);
    const visibleResponse = await request("/learning/courses", "learner");
    assert.equal(visibleResponse.status, 200, await visibleResponse.text());
    const visible = await (await request("/learning/courses", "learner")).json() as any[];
    assert.equal(visible.length, 1, "only published active-path content is visible");
    assert.equal(visible[0].id, ids.course); const otherCourses = await request("/learning/courses", "learner", undefined, "GET", true); assert.equal(otherCourses.status, 200); assert.deepEqual(await otherCourses.json(), [], "other-path learner sees no course");
    const learningPlan = await (await request("/learner/learning-plan", "learner")).json() as any[];
    const primaryPlan = learningPlan.find(item => item.module.id === ids.module);
    const secondPlan = learningPlan.find(item => item.module.id === secondModule);
    assert(primaryPlan?.causalReferences?.diagnosticGapIds?.includes(diagnosticGap.id) &&
      primaryPlan.causalReferences.diagnosticRecommendationIds.includes(diagnosticRecommendation.id) &&
      !primaryPlan.causalReferences.diagnosticRecommendationIds.includes(secondDiagnosticRecommendation.id), "primary plan must contain only its module-scoped diagnostic chain");
    assert(secondPlan?.causalReferences?.diagnosticGapIds?.includes(secondDiagnosticGap.id) &&
      secondPlan.causalReferences.diagnosticRecommendationIds.includes(secondDiagnosticRecommendation.id) &&
      !secondPlan.causalReferences.diagnosticRecommendationIds.includes(diagnosticRecommendation.id), "second plan must not inherit the primary module diagnostic chain");

    // The activity uses the same published activity ID; attempts/evidence are route writes.
    const attemptsBeforeCrossPath = (await db.select().from(practiceAttemptsTable)).length;
    assert.equal((await request(`/practice/tasks/${otherTask}/attempts`, "learner", { reflection: "cross path", outputSummary: "must not write", sourceActivityId: activity.id, idempotencyKey: id("cross-path") })).status, 404, "other-path task rejected");
    assert.equal((await db.select().from(practiceAttemptsTable)).length, attemptsBeforeCrossPath, "cross-path rejection made no attempt");
    await db.insert(assessmentsTable).values({ id: ids.assessment, moduleId: ids.module, name: "Gate assessment", gateCode: "G1" });
    await db.insert(assessmentCriteriaTable).values(["valid", "relevant", "sufficient", "traceable"].map((code, index) => ({ id: id(`criterion-${code}`), assessmentId: ids.assessment, code, label: code, layer: "evidence", critical: index === 0 })));
    await db.insert(evidenceRequirementsTable).values({ id: id("requirement"), moduleId: ids.module, code: "E1", name: "Gate evidence", description: "Valid evidence", allowedTypes: ["Checklist"] });
    await db.insert(pathwayModuleContractsTable).values({ id: id("pathway-module-contract"), pathwayId: ids.path, moduleId: ids.module, assessmentId: ids.assessment, evidenceRequirementId: id("requirement"), gateCode: "G1", assessment: "Gate assessment", evidence: "Gate evidence", output: "Readiness record", kpi: "All criteria competent", portfolio: terminalPortfolio });
    await db.insert(readinessGatesTable).values({ id: ids.gate, programId: ids.program, pathwayId: ids.path, sequence: 1, code: "G1", name: "Internal gate", requirement: "Internal preparation", assessmentMode: "Mapped", evidenceMode: "Mapped", competencyUnitId });
    const criteria = (await db.select().from(assessmentCriteriaTable)).filter(row => row.assessmentId === ids.assessment);
    const transition = (currentState: string, targetState: string, key: string, references: object = {}) => ({ currentState, targetState, learnerId: ids.learner, pathwayId: ids.path, programId: ids.program, activityId: activity.id, entityReference: key, reason: "gate journey", idempotencyKey: id(key), references });
    const eventsBeforeWrongDiagnostic = (await db.select().from(learningTransitionEventsTable)).length;
    const linksBeforeWrongDiagnostic = (await db.select().from(learningRecordLinksTable)).length;
    const wrongModuleDiagnostic = await request("/learning/transitions", "learner", transition("NOT_STARTED", "IN_PROGRESS", "wrong-module-diagnostic", {
      diagnosticProfileId: diagnosticProfile.id,
      diagnosticGapId: secondDiagnosticGap.id,
      diagnosticRecommendationId: secondDiagnosticRecommendation.id,
    }));
    assert.equal(wrongModuleDiagnostic.status, 409, "module-two diagnostic chain must be rejected for module-one learning");
    assert.equal((await db.select().from(learningTransitionEventsTable)).length, eventsBeforeWrongDiagnostic, "wrong-module diagnostic request must not append a transition");
    assert.equal((await db.select().from(learningRecordLinksTable)).length, linksBeforeWrongDiagnostic, "wrong-module diagnostic request must not append a causal link");
    await expect("/learning/transitions", "learner", transition("NOT_STARTED", "IN_PROGRESS", "learn"), 201);
    await expect("/learning/transitions", "learner", transition("IN_PROGRESS", "LEARNING_COMPLETED", "complete"), 201);
    await expect("/learning/transitions", "trainer", transition("LEARNING_COMPLETED", "OUTCOME_VERIFIED", "verify", { outcomeId: outcome.id }), 201);
    await expect("/learning/transitions", "trainer", transition("OUTCOME_VERIFIED", "PRACTICE_REQUIRED", "required"), 201);
    const practiceBody = { reflection: "Run-scoped practice", outputSummary: "Safe completion", sourceActivityId: activity.id, idempotencyKey: id("practice") };
    const practice = await expect(`/practice/tasks/${ids.task}/attempts`, "learner", practiceBody);
    const retry = await expect(`/practice/tasks/${ids.task}/attempts`, "learner", practiceBody, 200);
    assert.equal(retry.id, practice.id, "reload retry must not duplicate practice");
    assert.equal((await request(`/practice/tasks/${ids.task}/attempts`, "learner", { ...practiceBody, reflection: "conflicting reuse" })).status, 409);
    assert.equal((await db.select().from(practiceAttemptsTable)).filter(row => row.learnerId === ids.learner).length, 1);
    const practiceReviewBody = { idempotencyKey: id("practice-review"), status: "Needs revision", feedback: "Repeat under supervision" };
    const firstPracticeReview = await expect(`/trainer/practice/${practice.id}/review`, "trainer", practiceReviewBody, 200);
    const retriedPracticeReview = await expect(`/trainer/practice/${practice.id}/review`, "trainer", practiceReviewBody, 200);
    assert.equal(retriedPracticeReview.id, firstPracticeReview.id, "practice review retry must return the original result");
    assert.equal((await db.select().from(practiceReviewsTable)).filter(row => row.attemptId === practice.id).length, 1, "practice review retry must not append history");
    assert.equal((await request(`/trainer/practice/${practice.id}/review`, "trainer", { ...practiceReviewBody, feedback: "conflicting reuse" })).status, 409);
    await expect(`/trainer/practice/${practice.id}/review`, "trainer", { ...practiceReviewBody, idempotencyKey: id("practice-review-changed"), status: "Reviewed", feedback: "Revision completed" }, 200);
    assert.equal((await db.select().from(practiceReviewsTable)).filter(row => row.attemptId === practice.id).length, 2, "changed practice review payload must append history");
    const evidenceBody = { moduleId: ids.module, taskId: ids.task, title: "Run-scoped evidence", type: "Checklist", description: "Traceable evidence", fileName: null, sourceActivityId: activity.id, practiceAttemptId: practice.id, idempotencyKey: id("evidence") };
    const evidence = await expect("/evidence", "learner", evidenceBody);
    assert.equal((await expect("/evidence", "learner", evidenceBody, 200)).id, evidence.id, "reload retry must not duplicate evidence");
    assert.equal((await request("/evidence", "learner", { ...evidenceBody, description: "conflicting reuse" })).status, 409);
    const beforeLearnerReview = (await db.select().from(evidenceReviewsTable)).length;
    assert.equal((await request(`/trainer/evidence/${evidence.id}/review`, "learner", { idempotencyKey: id("learner-review"), status: "Valid", comment: "no", quality: { valid: true, relevant: true, sufficient: true, traceable: true } })).status, 403, "learner cannot validate");
    assert.equal((await db.select().from(evidenceReviewsTable)).length, beforeLearnerReview);
    const reviewCountBeforeOther = (await db.select().from(evidenceReviewsTable)).filter(row => row.evidenceId === evidence.id).length;
    assert.equal((await request(`/trainer/evidence/${evidence.id}/review`, "trainer", { idempotencyKey: id("unassigned-review"), status: "Valid", comment: "unassigned", quality: { valid: true, relevant: true, sufficient: true, traceable: true } }, "POST", true)).status, 403);
    assert.equal((await db.select().from(evidenceReviewsTable)).filter(row => row.evidenceId === evidence.id).length, reviewCountBeforeOther);
    const remediationEventCountBeforeAuthorization = (await db.select().from(remediationEventsTable)).length;
    assert.equal((await request("/trainer/remediation", "learner", { diagnosticProfileId: diagnosticProfile.id, diagnosticGapId: diagnosticGap.id, diagnosticRecommendationId: diagnosticRecommendation.id, moduleId: ids.module, title: "Unauthorized", description: "no", activityTitle: "no", activityDescription: "no", activityType: "Practice", idempotencyKey: id("unauthorized-remediation") })).status, 403);
    assert.equal((await db.select().from(remediationEventsTable)).length, remediationEventCountBeforeAuthorization, "unauthorized remediation opening must not mutate");
    assert.equal((await request("/trainer/remediation", "assessor", { diagnosticProfileId: diagnosticProfile.id, diagnosticGapId: diagnosticGap.id, diagnosticRecommendationId: diagnosticRecommendation.id, moduleId: ids.module, title: "Wrong role", description: "no", activityTitle: "no", activityDescription: "no", activityType: "Practice", idempotencyKey: id("wrong-role-remediation") })).status, 403);
    assert.equal((await db.select().from(remediationEventsTable)).length, remediationEventCountBeforeAuthorization, "wrong-role remediation opening must not mutate");
    assert.equal((await request("/trainer/remediation", "trainer", { diagnosticProfileId: diagnosticProfile.id, diagnosticGapId: diagnosticGap.id, diagnosticRecommendationId: diagnosticRecommendation.id, moduleId: "wrong-module", title: "Mismatched", description: "no", activityTitle: "no", activityDescription: "no", activityType: "Practice", idempotencyKey: id("mismatched-remediation") })).status, 409);
    assert.equal((await db.select().from(remediationEventsTable)).length, remediationEventCountBeforeAuthorization, "mismatched remediation opening must not mutate");
    const remediationBody = {
      diagnosticProfileId: diagnosticProfile.id,
      diagnosticGapId: diagnosticGap.id,
      diagnosticRecommendationId: diagnosticRecommendation.id,
      moduleId: ids.module,
      title: "Repeat supervised practice",
      description: "Complete remediation before reassessment",
      dueLabel: "Gate run",
      activityTitle: "Supervised re-practice",
      activityDescription: "Repeat the practice safely",
      activityType: "Practice",
      idempotencyKey: id("remediation-open"),
    };
    if (pathAGoldenJourney) {
      const failedBody = { ...remediationBody, idempotencyKey: id("remediation-rollback") };
      const remediationCounts = async () => [
        (await db.select().from(gapsTable)).length,
        (await db.select().from(remediationPlansTable)).length,
        (await db.select().from(remediationActivitiesTable)).length,
        (await db.select().from(gapEventsTable)).length,
        (await db.select().from(remediationEventsTable)).length,
      ];
      const beforeFailedOpen = await remediationCounts();
      // This gate runs against a disposable database. The trigger targets only
      // the rollback fixture's final insert, never the normal journey.
      try {
        await db.execute(sql`
          CREATE FUNCTION reject_remediation_rollback_event() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'forced remediation final insert failure';
          END
          $$
        `);
        await db.execute(sql`
          CREATE TRIGGER reject_remediation_rollback_event
          BEFORE INSERT ON teras_remediation_events
          FOR EACH ROW WHEN (
            NEW.status = 'Open'
            AND NEW.idempotency_key LIKE 'gate-%-remediation-rollback'
          )
          EXECUTE FUNCTION reject_remediation_rollback_event()
        `);
        const failedOpen = await request("/trainer/remediation", "trainer", failedBody);
        assert.equal(failedOpen.status, 500, `final remediation event insert must fail: ${await failedOpen.text()}`);
        assert.deepEqual(await remediationCounts(), beforeFailedOpen,
          "failed final insert must roll back gap, plan, activity, gap event and remediation event");
        assert.deepEqual(await db.select().from(remediationEventsTable).where(eq(remediationEventsTable.idempotencyKey, failedBody.idempotencyKey)), [],
          "failed idempotency key must not be consumed");
      } finally {
        await db.execute(sql`DROP TRIGGER IF EXISTS reject_remediation_rollback_event ON teras_remediation_events`);
        await db.execute(sql`DROP FUNCTION IF EXISTS reject_remediation_rollback_event()`);
      }
      // The exact same request now succeeds, confirming the injected final
      // insert failure (rather than an invalid diagnostic chain) caused the 500.
      const recovered = await expect("/trainer/remediation", "trainer", failedBody);
      assert.equal((await db.select().from(remediationEventsTable).where(eq(remediationEventsTable.idempotencyKey, failedBody.idempotencyKey))).length, 1,
        "retry after rollback must create exactly one remediation event");
      assert(recovered.gapId && recovered.remediationPlanId && recovered.remediationActivityId);
    }
    const remediation = await expect("/trainer/remediation", "trainer", remediationBody);
    const { gapId, remediationPlanId: planId, remediationActivityId } = remediation;
    const remediationRetry = await expect("/trainer/remediation", "trainer", remediationBody, 200);
    assert.equal(remediationRetry.remediationPlanId, planId, "remediation retry must return the original plan");
    assert.equal((await db.select().from(remediationEventsTable)).filter(row => row.activityId === remediationActivityId).length, 1, "remediation retry must not append an event");
    assert.equal((await request("/trainer/remediation", "trainer", { ...remediationBody, title: "Conflicting reuse" })).status, 409, "conflicting remediation idempotency reuse is rejected");
    const concurrentBody = { ...remediationBody, idempotencyKey: id("concurrent-remediation") };
    const concurrentResponses = await Promise.all([
      request("/trainer/remediation", "trainer", concurrentBody),
      request("/trainer/remediation", "trainer", concurrentBody),
    ]);
    assert(concurrentResponses.every(response => response.status === 200 || response.status === 201), "concurrent same-key remediation requests must return 200/201");
    const concurrentRemediations = await Promise.all(concurrentResponses.map(response => response.json() as Promise<any>));
    assert.equal(new Set(concurrentRemediations.map(item => item.remediationPlanId)).size, 1, "concurrent same-key remediation requests must share one plan");
    assert.equal((await db.select().from(remediationEventsTable)).filter(row => row.idempotencyKey === concurrentBody.idempotencyKey).length, 1, "concurrent same-key remediation requests must create one event");
    const evidenceReviewBody = { idempotencyKey: id("evidence-review"), status: "Needs revision", comment: "Remediate", quality: { valid: true, relevant: true, sufficient: false, traceable: true } };
    await expect(`/trainer/evidence/${evidence.id}/review`, "trainer", evidenceReviewBody, 200);
    const gapEventsAfterFirstReview = (await db.select().from(gapEventsTable)).filter(row => row.gapId === gapId).length;
    const remediationEventsAfterFirstReview = (await db.select().from(remediationEventsTable)).filter(row => row.activityId === remediationActivityId).length;
    await expect(`/trainer/evidence/${evidence.id}/review`, "trainer", evidenceReviewBody, 200);
    assert.equal((await db.select().from(evidenceReviewsTable)).filter(row => row.evidenceId === evidence.id).length, 2, "evidence review retry must not append history");
    assert.equal((await db.select().from(gapEventsTable)).filter(row => row.gapId === gapId).length, gapEventsAfterFirstReview, "evidence review retry must not append gap transitions");
    assert.equal((await db.select().from(remediationEventsTable)).filter(row => row.activityId === remediationActivityId).length, remediationEventsAfterFirstReview, "evidence review retry must not append remediation transitions");
    assert.equal((await request(`/trainer/evidence/${evidence.id}/review`, "trainer", { ...evidenceReviewBody, comment: "conflicting reuse" })).status, 409);
    await expect(`/assessor/assessments/${ids.assessment}/decision`, "assessor", { learnerId: ids.learner, decision: "Not competent", observation: "Initial assessment failed before remediation", criteria: criteria.map(row => ({ criterionId: row.id, score: row.id === criteria[0]?.id ? 1 : 3, observation: "Needs remediation", evidenceId: row.id === criteria[0]?.id ? evidence.id : null })) });
    const failedAssessment = (await db.select().from(assessmentAttemptsTable)).filter(row => row.assessmentId === ids.assessment).at(-1)!;
    const revisionReview = (await db.select().from(evidenceReviewsTable)).filter(row => row.evidenceId === evidence.id).at(-1)!;
    assert.equal((await db.select().from(gapEventsTable)).filter(row => row.gapId === gapId).at(-1)?.status, "Open", "revision must append gap opening");
    assert.equal((await db.select().from(remediationEventsTable)).filter(row => row.activityId === remediationActivityId).at(-1)?.status, "In progress", "revision must append remediation opening");
    await expect("/learning/transitions", "trainer", transition("EVIDENCE_SUBMITTED", "UNDER_REVIEW", "under-review", { evidenceId: evidence.id }), 201);
    await expect("/learning/transitions", "trainer", transition("UNDER_REVIEW", "REVISION_REQUIRED", "revision", { evidenceId: evidence.id, evidenceReviewId: revisionReview.id }), 201);
    await expect("/learning/transitions", "trainer", transition("REVISION_REQUIRED", "REMEDIATION", "remediation", { gapId, remediationPlanId: planId }), 201);
    const beforeRejectedCompletion = (await db.select().from(remediationEventsTable)).filter(row => row.activityId === remediationActivityId).length;
    assert.equal((await request(`/remediation/${planId}/complete`, "learner", {})).status, 409);
    assert.equal((await db.select().from(remediationEventsTable)).filter(row => row.activityId === remediationActivityId).length, beforeRejectedCompletion);
    const completionBody = { idempotencyKey: id("remediation-complete"), completionNote: "Completed assigned coaching activity" };
    const concurrentCompletion = await Promise.all([request(`/remediation/${planId}/activities/${remediationActivityId}/complete`, "learner", completionBody), request(`/remediation/${planId}/activities/${remediationActivityId}/complete`, "learner", completionBody)]);
    assert.deepEqual(concurrentCompletion.map(response => response.status).sort(), [200, 201]);
    const beforeCompletionConflict = (await db.select().from(remediationEventsTable)).length;
    assert.equal((await request(`/remediation/${planId}/activities/${remediationActivityId}/complete`, "learner", { ...completionBody, completionNote: "changed payload" })).status, 409);
    assert.equal((await db.select().from(remediationEventsTable)).length, beforeCompletionConflict);
    assert.equal((await request(`/remediation/${planId}/complete`, "learner", {})).status, 409, "activity alone cannot close causal remediation");
    const remediationHistory = (await db.select().from(remediationEventsTable)).filter(row => row.activityId === remediationActivityId).map(row => row.status);
    assert(remediationHistory.includes("In progress") && remediationHistory.filter(status => status === "Completed").length === 1);
    const rePractice = await expect(`/practice/tasks/${ids.task}/attempts`, "learner", { ...practiceBody, reflection: "Run-scoped re-practice", idempotencyKey: id("re-practice") });
    const reEvidence = await expect("/evidence", "learner", { ...evidenceBody, title: "Revised run-scoped evidence", practiceAttemptId: rePractice.id, idempotencyKey: id("re-evidence") });
    await expect(`/trainer/evidence/${reEvidence.id}/review`, "trainer", { idempotencyKey: id("re-evidence-review"), status: "Valid", comment: "All four dimensions pass", quality: { valid: true, relevant: true, sufficient: true, traceable: true } }, 200);
    const attemptsBeforeOtherAssessor = (await db.select().from(assessmentAttemptsTable)).length;
    assert.equal((await request(`/assessor/assessments/${ids.assessment}/decision`, "assessor", { learnerId: ids.learner, decision: "Competent", observation: "unassigned", criteria: criteria.map(row => ({ criterionId: row.id, score: 3, observation: "no", evidenceId: null })) }, "POST", true)).status, 403);
    assert.equal((await db.select().from(assessmentAttemptsTable)).length, attemptsBeforeOtherAssessor);
    const attempts = (await db.select().from(practiceAttemptsTable)).filter(row => row.learnerId === ids.learner);
    assert.equal(attempts.length, 2, "initial and re-practice history must be append-only");
    assert.equal((await db.select().from(evidenceReviewsTable)).filter(row => row.evidenceId === evidence.id).length, 2, "old evidence review history retained");
    assert.equal((await db.select().from(learningRecordLinksTable)).filter(row => row.learnerId === ids.learner && row.activityId === activity.id).length >= 4, true, "causal activity links recorded");
    await expect("/learning/transitions", "trainer", transition("EVIDENCE_SUBMITTED", "UNDER_REVIEW", "re-under-review", { evidenceId: reEvidence.id }), 201);
    const beforePrematurePass = (await db.select().from(assessmentAttemptsTable)).length;
    assert.equal((await request(`/assessor/assessments/${ids.assessment}/decision`, "assessor", { learnerId: ids.learner, decision: "Competent", observation: "premature pass", criteria: criteria.map(row => ({ criterionId: row.id, score: 3, observation: "premature", evidenceId: null })) })).status, 409);
    assert.equal((await db.select().from(assessmentAttemptsTable)).length, beforePrematurePass, "premature pass made no attempt");
    await expect(`/assessor/assessments/${ids.assessment}/decision`, "assessor", { learnerId: ids.learner, decision: "Not competent", observation: "Remediation reassessment requires one more observation", criteria: criteria.map(row => ({ criterionId: row.id, score: row.id === criteria[0]?.id ? 1 : 3, observation: "Reassess", evidenceId: row.id === criteria[0]?.id ? reEvidence.id : null })) });
    const reassessmentAttempt = (await db.select().from(assessmentAttemptsTable)).filter(row => row.assessmentId === ids.assessment).at(-1)!;
    const reassessmentReferences = { practiceAttemptId: rePractice.id, evidenceId: reEvidence.id, evidenceReviewId: (await db.select().from(evidenceReviewsTable)).filter(row => row.evidenceId === reEvidence.id).at(-1)!.id, gapId, remediationPlanId: planId, reassessmentAttemptId: reassessmentAttempt.id, previousAssessmentAttemptId: failedAssessment.id };
    await expect("/learning/transitions", "assessor", transition("UNDER_REVIEW", "REASSESSMENT", "reassessment", reassessmentReferences), 201);
    const eventsBeforePrematureClosure = (await db.select().from(remediationEventsTable)).length;
    assert.equal((await request(`/remediation/${planId}/complete`, "learner", {})).status, 409, "failed linked reassessment cannot close plan");
    assert.equal((await db.select().from(remediationEventsTable)).length, eventsBeforePrematureClosure);
    await expect(`/assessor/assessments/${ids.assessment}/decision`, "assessor", { learnerId: ids.learner, decision: "Competent", observation: "Passing reassessment", criteria: criteria.map(row => ({ criterionId: row.id, score: 3, observation: "Verified", evidenceId: row.id === criteria[0]?.id ? reEvidence.id : null })) });
    const passedAssessment = (await db.select().from(assessmentAttemptsTable)).filter(row => row.assessmentId === ids.assessment).at(-1)!;
    assert.equal((await request(`/remediation/${planId}/complete`, "learner", {})).status, 200, "plan closes only after causal reassessment");
    await expect("/learning/transitions", "assessor", transition("REASSESSMENT", "READY", "ready", { reassessmentAttemptId: passedAssessment.id }), 201);
    const directPassportResponse = await request("/passport", "learner");
    assert.equal(directPassportResponse.status, 200, await directPassportResponse.clone().text());
    const directPassport = await directPassportResponse.json() as any;
    const readinessPayload = directPassport.readiness;
    assert.equal(readinessPayload.status, "Ready for Official Assessment");
    const matchingReadinessEvents = (await db.select().from(readinessEventsTable))
      .filter(row => row.enrollmentId === ids.enrollment &&
        row.pathwayId === ids.path &&
        row.evaluatedAt.toISOString() === readinessPayload.evaluatedAt);
    assert.equal(matchingReadinessEvents.length, 1, "passport readiness payload must identify exactly one persisted decision");
    const persistedReadiness = matchingReadinessEvents[0];
    assert(persistedReadiness, "readiness evaluation must be persisted");
    const gateSnapshot = persistedReadiness.inputEvidence.gates?.find(gate => gate.gateId === persistedReadiness.gateId);
    assert(gateSnapshot, "active gate must retain its causal identity snapshot");
    assert(gateSnapshot.criterionIds.length > 0, "gate snapshot must identify criteria");
    assert(gateSnapshot.assessmentAttemptIds.includes(passedAssessment.id), "gate snapshot must identify the competent reassessment");
    assert(gateSnapshot.evidenceIds.includes(reEvidence.id), "gate snapshot must identify reassessment evidence");
    assert(gateSnapshot.evidenceReviewIds.includes(reassessmentReferences.evidenceReviewId), "gate snapshot must identify evidence review");
    assert(gateSnapshot.remediationPlanIds.includes(planId), "gate snapshot must identify remediation");
    assert(gateSnapshot.reassessmentAttemptIds.includes(passedAssessment.id), "gate snapshot must classify reassessment identity");
    assert(gateSnapshot.diagnosticProfileIds?.includes(diagnosticProfile.id), "gate snapshot must retain the originating diagnostic profile");
    assert(gateSnapshot.diagnosticGapIds?.includes(diagnosticGap.id), "gate snapshot must retain the originating diagnostic gap");
    assert(gateSnapshot.diagnosticRecommendationIds?.includes(diagnosticRecommendation.id), "gate snapshot must retain the originating diagnostic recommendation");
    const directPassportReadiness = directPassport.timeline.find((step: any) => step.causalReferences?.readinessEventIds?.includes(persistedReadiness.id));
    assert(directPassportReadiness, "first passport request after READY must include its newly persisted readiness event");
    assert(directPassportReadiness.causalReferences.diagnosticProfileIds.includes(diagnosticProfile.id), "direct passport readiness must retain the diagnostic profile");
    assert(directPassportReadiness.causalReferences.diagnosticGapIds.includes(diagnosticGap.id), "direct passport readiness must retain the diagnostic gap");
    assert(directPassportReadiness.causalReferences.diagnosticRecommendationIds.includes(diagnosticRecommendation.id), "direct passport readiness must retain the diagnostic recommendation");
    assert.equal((await db.select().from(reassessmentLinksTable)).filter(row => row.reassessmentAttemptId === reassessmentAttempt.id && row.previousAssessmentAttemptId === failedAssessment.id && row.evidenceId === reEvidence.id).length, 1, "reassessment causal link retained");
    assert.equal((await db.select().from(reassessmentLinksTable)).filter(row => row.reassessmentAttemptId === passedAssessment.id && row.previousAssessmentAttemptId === reassessmentAttempt.id && row.remediationPlanId === planId).length, 1, "competent reassessment is causally linked");
    assert.equal((await db.select().from(readinessTransferEventsTable)).filter(row => row.learnerId === ids.learner && row.enrollmentId === ids.enrollment && row.reassessmentReferences.includes(passedAssessment.id) && row.evidenceReferences.includes(reEvidence.id) && row.practiceReferences.includes(rePractice.id)).length, 1, "ready transfer is append-only and scoped");
    const postProgressionPlan = await (await request("/learner/learning-plan", "learner")).json() as any[];
    const untouchedSecondPlan = postProgressionPlan.find(item => item.module.id === secondModule);
    assert(untouchedSecondPlan, "unfinished second module must remain in the learning plan");
    const secondReferences = untouchedSecondPlan.causalReferences;
    for (const [referenceName, primaryModuleIds] of Object.entries({
      learningRecordLinkIds: (await db.select().from(learningRecordLinksTable)).map(link => link.id),
      practiceAttemptIds: [rePractice.id],
      evidenceIds: [reEvidence.id],
      gapIds: [gapId],
      remediationPlanIds: [planId],
      reassessmentAttemptIds: [passedAssessment.id],
    })) {
      assert(primaryModuleIds.every(primaryId => !secondReferences[referenceName].includes(primaryId)), `second module must not inherit module-one ${referenceName}`);
    }
    const journeyResponse = await request("/learner/journey", "learner");
    assert.equal(journeyResponse.status, 200, await journeyResponse.clone().text());
    const journey = await journeyResponse.json() as any[];
    const assertDiagnosticChain = (step: any, stage: string) => {
      assert(step, `${stage} must exist in the persisted timeline`);
      assert(step.causalReferences?.diagnosticProfileIds?.includes(diagnosticProfile.id), `${stage} must retain the originating diagnostic profile`);
      assert(step.causalReferences?.diagnosticGapIds?.includes(diagnosticGap.id), `${stage} must retain the originating diagnostic gap`);
      assert(step.causalReferences?.diagnosticRecommendationIds?.includes(diagnosticRecommendation.id), `${stage} must retain the originating diagnostic recommendation`);
    };
    const diagnosticStep = journey.find(step => step.causalReferences?.diagnosticProfileIds?.includes(diagnosticProfile.id));
    assert(diagnosticStep?.causalReferences?.diagnosticGapIds?.includes(diagnosticGap.id), "timeline diagnostic event must identify the persisted core gap");
    assert(diagnosticStep?.causalReferences?.diagnosticRecommendationIds?.includes(diagnosticRecommendation.id), "timeline diagnostic event must identify the persisted recommendation");
    assertDiagnosticChain(journey.find(step => step.label === "Learning: IN_PROGRESS"), "learning");
    assertDiagnosticChain(journey.find(step => step.causalReferences?.practiceAttemptIds?.includes(rePractice.id)), "practice");
    assertDiagnosticChain(journey.find(step => step.id === `evidence-${reEvidence.id}`), "evidence");
    assertDiagnosticChain(journey.find(step => step.causalReferences?.evidenceReviewIds?.includes(reassessmentReferences.evidenceReviewId)), "evidence review");
    assertDiagnosticChain(journey.find(step => step.causalReferences?.remediationPlanIds?.includes(planId) && step.causalReferences?.remediationEventIds?.length), "remediation");
    assertDiagnosticChain(journey.find(step => step.causalReferences?.assessmentAttemptIds?.includes(failedAssessment.id)), "assessment");
    const reassessmentStep = journey.find(step => step.causalReferences?.reassessmentAttemptIds?.includes(passedAssessment.id));
    assert.equal(reassessmentStep?.label, "Reassessment attempt", "timeline must derive reassessment from the persisted causal link");
    assertDiagnosticChain(reassessmentStep, "reassessment");
    const readinessStep = journey.find(step => step.causalReferences?.readinessEventIds?.includes(persistedReadiness.id));
    assertDiagnosticChain(readinessStep, "readiness");
    const passport = directPassport;
    assert.match(passport.readinessDisclaimer, /not an official competency decision or certification claim/i);
    assert.equal(passport.achievements[0].capability, "Safe gate practice");
    assert.equal(passport.terminalPortfolio, terminalPortfolio);
    assert(passport.timeline.some((step: any) => step.id === reassessmentStep.id), "passport must reuse the persisted capability timeline");
    const passportStages: Array<[string, (step: any) => boolean]> = [
      ["learning", step => step.label === "Learning: IN_PROGRESS"],
      ["practice", step => step.causalReferences?.practiceAttemptIds?.includes(rePractice.id)],
      ["evidence", step => step.id === `evidence-${reEvidence.id}`],
      ["evidence review", step => step.causalReferences?.evidenceReviewIds?.includes(reassessmentReferences.evidenceReviewId)],
      ["remediation", step => step.causalReferences?.remediationPlanIds?.includes(planId) && step.causalReferences?.remediationEventIds?.length],
      ["assessment", step => step.causalReferences?.assessmentAttemptIds?.includes(failedAssessment.id)],
      ["reassessment", step => step.causalReferences?.reassessmentAttemptIds?.includes(passedAssessment.id)],
      ["readiness", step => step.causalReferences?.readinessEventIds?.includes(persistedReadiness.id)],
    ];
    for (const [stage, matches] of passportStages) {
      assertDiagnosticChain(passport.timeline.find(matches), `passport ${stage}`);
    }
    process.stdout.write(`${pathAGoldenJourney ? "Path A Golden Journey" : "Certification preparation shared-state journey"} passed (${run})\n`);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
await main();