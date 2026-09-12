import assert from "node:assert/strict";
import fs from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  enrollmentPathwayEventsTable,
  enrollmentsTable,
  learningBaselineAuditTable,
  learningBaselineVersionsTable,
  learningBaselinesTable,
  peopleTable,
  pathwaysTable,
  programsTable,
  pool,
} from "@workspace/db";
import {
  createBaselineDraft,
  publishBaseline,
  updateBaselineDraft,
} from "./lib/baseline-authoring";
import { createIntegrationTestApp } from "./integration-test-app";

const suffix = crypto.randomUUID();
const id = (prefix: string) => `${prefix}-${suffix}`;

async function main() {
  const [baseline] = await db.select().from(learningBaselinesTable)
    .where(eq(learningBaselinesTable.id, "baseline-integration")).limit(1);
  assert(baseline, "migration fixture must provide the active Solar PV baseline");
  const [active] = await db.select().from(learningBaselineVersionsTable).where(and(
    eq(learningBaselineVersionsTable.id, baseline.publishedVersionId ?? ""),
    eq(learningBaselineVersionsTable.status, "PUBLISHED"),
  ));
  assert(active, "migration must materialize and point at a published baseline version");

  const people = await Promise.all([
    db.select().from(peopleTable).where(eq(peopleTable.id, "baseline-integration-person-1")).then(rows => rows[0]),
    db.select().from(peopleTable).where(eq(peopleTable.id, "baseline-integration-person-2")).then(rows => rows[0]),
    db.select().from(peopleTable).where(eq(peopleTable.id, "baseline-integration-person-3")).then(rows => rows[0]),
  ]);
  const selection = ((active.snapshot as any).selections ?? [])[0];
  const pathwayId = selection?.pathwayId ?? selection?.pathway_id;
  assert(typeof pathwayId === "string", "migration snapshot must include a pathway selection");
  const [pathway] = await db.select().from(pathwaysTable).where(eq(pathwaysTable.id, pathwayId)).limit(1);
  const [program] = await db.select().from(programsTable).limit(1);
  assert(people.length >= 3 && pathway && program, "isolated schema must provide catalogue identities");
  const person = people[0]!;
  const newPerson = people[1]!;
  const adminPerson = people[2]!;

  const enrollmentId = id("baseline-old-enrollment");
  await db.insert(enrollmentsTable).values({
    id: enrollmentId, learnerId: person.id, programId: program.id, pathwayId: pathway.id,
    status: "active", trainerId: person.id, baselineVersionId: active.id, createdBy: "baseline-integration",
  });
  await db.insert(enrollmentPathwayEventsTable).values({
    id: id("baseline-old-selection"), enrollmentId, pathwayId: pathway.id, programId: program.id,
    sequence: 1, baselineVersionId: active.id, createdBy: "baseline-integration",
  });

  let activeRole: "trainer" | "learner" | "admin" = "trainer";
  let activeLearner = person.id;
  const app = createIntegrationTestApp(() => ({ userId: "baseline-actor", role: activeRole, learnerId: activeLearner }));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const listener = app.listen(0, () => resolve(listener)); });
  server.unref();
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cloneResponse = await request(`/trainer/authoring/baselines/${baseline.id}/drafts`, "POST");
  assert.equal(cloneResponse.status, 201);
  const draftResult = await cloneResponse.json() as { versionId: string; version: number };
  const draft = (await db.select().from(learningBaselineVersionsTable)
    .where(eq(learningBaselineVersionsTable.id, draftResult.versionId)))[0]!;
  const editedSnapshot = {
    ...(draft.snapshot as Record<string, unknown>),
    baseline: { ...((draft.snapshot as any).baseline), description: "Version 2 integration snapshot" },
    selections: ((draft.snapshot as any).selections ?? []).map((row: Record<string, unknown>) => ({
      ...row,
      baseline_module_id: "baseline-module-integration-v2",
    })),
  };
  const updateResponse = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${draft.id}`, "PATCH", { snapshot: editedSnapshot });
  assert.equal(updateResponse.status, 200);
  const unauthorizedResponse = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${draft.id}`, "PATCH", "x");
  assert.equal(unauthorizedResponse.status, 400);
  const publishedResponse = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${draft.id}/publish`, "POST");
  assert.equal(publishedResponse.status, 201);
  const publishedResult = await publishedResponse.json() as { version: number };
  const published = (await db.select().from(learningBaselineVersionsTable)
    .where(eq(learningBaselineVersionsTable.id, draft.id)))[0]!;
  assert.equal(published.status, "PUBLISHED");
  assert.deepEqual(published.snapshot, editedSnapshot);
  const publishAudit = await db.select().from(learningBaselineAuditTable).where(and(
    eq(learningBaselineAuditTable.versionId, draft.id), eq(learningBaselineAuditTable.action, "PUBLISH"),
  ));
  assert.equal(publishAudit.length, 1, "publish and audit are committed together");

  const oldEnrollment = (await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, enrollmentId)))[0]!;
  const oldEvent = (await db.select().from(enrollmentPathwayEventsTable).where(eq(enrollmentPathwayEventsTable.enrollmentId, enrollmentId)))[0]!;
  assert.equal(oldEnrollment.baselineVersionId, active.id, "old enrollment remains pinned");
  assert.equal(oldEvent.baselineVersionId, active.id, "old pathway event remains pinned");
  activeRole = "learner";
  activeLearner = person.id;
  const oldProgramResponse = await request(`/programs/${program.id}`);
  const oldProgramText = await oldProgramResponse.text();
  assert.equal(oldProgramResponse.status, 200, oldProgramText);
  const oldProgram = JSON.parse(oldProgramText) as { modules: Array<{ id: string }> };
  assert.deepEqual(oldProgram.modules.map(module => module.id), ["baseline-integration-module"], "old learner keeps v1 module selection");
  const newEnrollmentId = id("baseline-new-enrollment");
  await db.insert(enrollmentsTable).values({
    id: newEnrollmentId, learnerId: newPerson.id, programId: program.id, pathwayId: pathway.id,
    status: "active", baselineVersionId: draft.id, createdBy: "baseline-integration",
  });
  await db.insert(enrollmentPathwayEventsTable).values({
    id: id("baseline-new-selection"), enrollmentId: newEnrollmentId, pathwayId: pathway.id,
    programId: program.id, sequence: 1, baselineVersionId: draft.id, createdBy: "baseline-integration",
  });
  assert.equal((await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, newEnrollmentId)))[0]!.baselineVersionId, draft.id);
  activeRole = "learner";
  activeLearner = newPerson.id;
  const learnerPathwayResponse = await request("/learner/pathway", "POST", { pathwayId: pathway.id });
  const learnerPathwayText = await learnerPathwayResponse.text();
  assert.equal(learnerPathwayResponse.status, 201, learnerPathwayText);
  const learnerPathwayPayload = JSON.parse(learnerPathwayText) as { baselineVersionId: string };
  assert.equal(learnerPathwayPayload.baselineVersionId, draft.id, "learner route pins the current published version");
  const newProgramResponse = await request(`/programs/${program.id}`);
  const newProgramText = await newProgramResponse.text();
  assert.equal(newProgramResponse.status, 200, newProgramText);
  const newProgram = JSON.parse(newProgramText) as { modules: Array<{ id: string }> };
  assert.deepEqual(newProgram.modules.map(module => module.id), ["baseline-integration-module-v2"], "new learner receives v2 module selection");
  const sharedModuleResponse = await request("/modules/baseline-integration-module-v2");
  assert.equal(sharedModuleResponse.status, 200, "pinned learner can open a shared module owned by another pathway");
  activeRole = "admin";
  activeLearner = adminPerson.id;
  const samePathwayUpdate = await request(`/admin/enrollments/${enrollmentId}`, "PATCH", {
    pathwayId: pathway.id,
    trainerId: person.id,
  });
  const samePathwayUpdateText = await samePathwayUpdate.text();
  assert.equal(samePathwayUpdate.status, 200, samePathwayUpdateText);
  assert.equal(
    (await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, enrollmentId)))[0]!.baselineVersionId,
    active.id,
    "an unrelated admin update with the same pathway preserves the learner's original pin",
  );
  const adminEnrollmentResponse = await request("/admin/enrollments", "POST", {
    id: id("baseline-admin-enrollment"), learnerId: adminPerson.id, programId: program.id,
    pathwayId: pathway.id, trainerId: person.id, assessorId: null, cohortId: null, status: "active",
  });
  const adminEnrollmentText = await adminEnrollmentResponse.text();
  assert.equal(adminEnrollmentResponse.status, 201, adminEnrollmentText);
  assert.equal((await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, id("baseline-admin-enrollment"))))[0]!.baselineVersionId, draft.id, "admin route pins current published version");

  const clones = await Promise.all([
    createBaselineDraft(baseline.id, "trainer-a"),
    createBaselineDraft(baseline.id, "trainer-b"),
  ]);
  assert(clones.every(result => !("error" in result)));
  const cloneVersions = clones.map(result => ("error" in result ? -1 : result.version)).sort((a, b) => a - b);
  assert.deepEqual(cloneVersions, [published.version + 1, published.version + 2], "parallel clone versions are sequential");
  const concurrentDraft = await createBaselineDraft(baseline.id, "trainer-concurrent");
  assert(!("error" in concurrentDraft));
  if ("error" in concurrentDraft) return;
  const publishes = await Promise.all([
    publishBaseline(baseline.id, concurrentDraft.versionId, "trainer-a"),
    publishBaseline(baseline.id, concurrentDraft.versionId, "trainer-b"),
  ]);
  assert.equal(publishes.filter(result => !("error" in result)).length, 1);
  assert.equal(publishes.filter(result => "error" in result).length, 1);
  const pinRaceDraft = await createBaselineDraft(baseline.id, "trainer-pin-race");
  assert(!("error" in pinRaceDraft));
  if (!("error" in pinRaceDraft)) {
    const currentPointer = (await db.select().from(learningBaselinesTable).where(eq(learningBaselinesTable.id, baseline.id)))[0]!.publishedVersionId;
    activeRole = "learner";
    activeLearner = newPerson.id;
    const [racePublish, raceSelection] = await Promise.all([
      publishBaseline(baseline.id, pinRaceDraft.versionId, "trainer-pin-race"),
      request("/learner/pathway", "POST", { pathwayId: pathway.id }),
    ]);
    assert(!("error" in racePublish));
    assert.equal(raceSelection.status, 201);
    const latestRaceEvent = (await db.select().from(enrollmentPathwayEventsTable)
      .where(eq(enrollmentPathwayEventsTable.enrollmentId, newEnrollmentId))
      .orderBy(desc(enrollmentPathwayEventsTable.sequence)).limit(1))[0]!;
    assert([currentPointer, pinRaceDraft.versionId].includes(latestRaceEvent.baselineVersionId ?? ""), "route pin is old-or-new and never stale/null");
    const racePin = (await db.select().from(learningBaselineVersionsTable)
      .where(eq(learningBaselineVersionsTable.id, latestRaceEvent.baselineVersionId ?? "")))[0]!;
    assert.equal(racePin?.status, "PUBLISHED");
  }
  activeRole = "trainer";
  const unauthorizedDraft = clones[0];
  if (!("error" in unauthorizedDraft)) {
    const unauthorizedSnapshot = (await db.select().from(learningBaselineVersionsTable)
      .where(eq(learningBaselineVersionsTable.id, unauthorizedDraft.versionId)))[0]!.snapshot as any;
    unauthorizedSnapshot.selections = [...(unauthorizedSnapshot.selections ?? []), {
      pathwayId: "pathway-outside-trainer-scope",
      baselineModuleId: unauthorizedSnapshot.modules[0].id,
    }];
    const expansion = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${unauthorizedDraft.versionId}`, "PATCH", { snapshot: unauthorizedSnapshot });
    assert.equal(expansion.status, 403, "trainer cannot expand a draft into an unassigned pathway");
  }

  await assert.rejects(
    db.update(learningBaselineVersionsTable).set({ snapshot: { malformed: true } }).where(eq(learningBaselineVersionsTable.id, draft.id)),
  );
  const auditId = publishAudit[0]!.id;
  await assert.rejects(
    db.update(learningBaselineAuditTable).set({ action: "tampered" }).where(eq(learningBaselineAuditTable.id, auditId)),
  );
  await assert.rejects(
    db.insert(learningBaselineVersionsTable).values({
      id: id("direct-published"), baselineId: baseline.id, version: 999,
      status: "PUBLISHED", snapshot: editedSnapshot, createdBy: "integration",
      publishedAt: new Date(), publishedBy: "integration",
    }),
    "database rejects direct published inserts",
  );

  const snapshotBeforeUpgrade = published.snapshot;
  const pinsBeforeUpgrade = {
    enrollment: oldEnrollment.baselineVersionId,
    event: oldEvent.baselineVersionId,
  };
  await pool.query(fs.readFileSync("../../lib/db/migrations/0039_baseline_versioned_publishing.sql", "utf8"));
  const snapshotAfterUpgrade = (await db.select().from(learningBaselineVersionsTable).where(eq(learningBaselineVersionsTable.id, draft.id)))[0]!.snapshot;
  const oldAfterUpgrade = (await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, enrollmentId)))[0]!;
  const eventAfterUpgrade = (await db.select().from(enrollmentPathwayEventsTable).where(eq(enrollmentPathwayEventsTable.enrollmentId, enrollmentId)))[0]!;
  assert.deepEqual(snapshotAfterUpgrade, snapshotBeforeUpgrade);
  assert.equal(oldAfterUpgrade.baselineVersionId, pinsBeforeUpgrade.enrollment);
  assert.equal(eventAfterUpgrade.baselineVersionId, pinsBeforeUpgrade.event);
  await new Promise<void>(resolve => server.close(() => resolve()));
  console.log("Baseline versioning integration passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end());