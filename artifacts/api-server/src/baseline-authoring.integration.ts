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
  baselinePublicationPreview,
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
  const baselineListResponse = await request("/trainer/authoring/baselines");
  assert.equal(baselineListResponse.status, 200);
  const baselineList = await baselineListResponse.json() as Array<{
    baselineId: string; name: string; activeVersion: number | null; draftCount: number;
  }>;
  const listedBaseline = baselineList.find(item => item.baselineId === baseline.id);
  assert(listedBaseline, "assigned trainer can discover the governed baseline without knowing its ID");
  assert.equal(listedBaseline.name, baseline.name);
  assert.equal(listedBaseline.activeVersion, active.version);
  assert.equal(listedBaseline.draftCount, 0);
  activeLearner = newPerson.id;
  const outOfScopeList = await request("/trainer/authoring/baselines").then(response => response.json()) as Array<{
    baselineId: string;
  }>;
  assert.equal(outOfScopeList.some(item => item.baselineId === baseline.id), false,
    "the server excludes baselines outside the trainer's active assignments");
  activeLearner = person.id;
  const cloneResponse = await request(`/trainer/authoring/baselines/${baseline.id}/drafts`, "POST");
  assert.equal(cloneResponse.status, 201);
  const draftResult = await cloneResponse.json() as { versionId: string; version: number };
  const draft = (await db.select().from(learningBaselineVersionsTable)
    .where(eq(learningBaselineVersionsTable.id, draftResult.versionId)))[0]!;
  const listWithDraft = await request("/trainer/authoring/baselines").then(response => response.json()) as Array<{
    baselineId: string; draftCount: number;
  }>;
  assert.equal(listWithDraft.find(item => item.baselineId === baseline.id)?.draftCount, 1);
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
  const previewResponse = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${draft.id}/publication-preview`);
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as { previewFingerprint: string; impact: { preservedEnrollmentCount: number }; changes: unknown[] };
  assert.equal(preview.impact.preservedEnrollmentCount, 1, "preview marks the existing learner as preserved");
  assert(preview.changes.length > 0, "preview compares immutable active and draft snapshots");
  const missingPreviewResponse = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${draft.id}/publish`, "POST");
  assert.equal(missingPreviewResponse.status, 400, "publication is gated by a reviewed preview");
  const lateEnrollmentId = id("baseline-late-enrollment");
  await db.insert(enrollmentsTable).values({
    id: lateEnrollmentId, learnerId: person.id, programId: program.id, pathwayId: pathway.id,
    status: "inactive", trainerId: person.id, baselineVersionId: active.id, createdBy: "baseline-integration",
  });
  const stalePreviewResponse = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${draft.id}/publish`, "POST", { previewFingerprint: preview.previewFingerprint });
  assert.equal(stalePreviewResponse.status, 409, "publication rejects a preview whose enrollment impact changed");
  const refreshedPreview = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${draft.id}/publication-preview`).then(response => response.json()) as { previewFingerprint: string };
  const publishedResponse = await request(`/trainer/authoring/baselines/${baseline.id}/versions/${draft.id}/publish`, "POST", { previewFingerprint: refreshedPreview.previewFingerprint });
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

  const contentDraft = await createBaselineDraft(baseline.id, "trainer-content-change");
  assert(!("error" in contentDraft));
  if (!("error" in contentDraft)) {
    const contentVersion = (await db.select().from(learningBaselineVersionsTable).where(eq(learningBaselineVersionsTable.id, contentDraft.versionId)))[0]!;
    const contentSnapshot = structuredClone(contentVersion.snapshot as any);
    const selectedSnapshotModuleId = contentSnapshot.selections[0].baselineModuleId ?? contentSnapshot.selections[0].baseline_module_id;
    const selectedSnapshotModule = contentSnapshot.modules.find((module: { id: string }) => module.id === selectedSnapshotModuleId);
    assert(selectedSnapshotModule, "content-change fixture needs a selected snapshot module");
    selectedSnapshotModule.learningOutcome = `${selectedSnapshotModule.learningOutcome} updated`;
    contentSnapshot.baseline.description = `${contentSnapshot.baseline.description ?? ""} updated`;
    const contentUpdate = await updateBaselineDraft(baseline.id, contentDraft.versionId, contentSnapshot, "trainer-content-change");
    assert(!("error" in contentUpdate));
    const contentPreview = await baselinePublicationPreview(baseline.id, contentDraft.versionId);
    assert(!("error" in contentPreview));
    if (!("error" in contentPreview)) {
      assert.equal(contentPreview.changes.length, 1, "same-ID module content changes remain visible");
      assert.equal(contentPreview.changes[0]!.modifiedModules.length, 1, "content edit is classified as modified");
      assert(contentPreview.changes[0]!.modifiedModules[0]!.changedFields.includes("learningOutcome"), "all module curriculum fields are compared");
      assert.equal(contentPreview.changes[0]!.addedModules.length, 0, "content edit is not classified as added");
      assert.equal(contentPreview.changes[0]!.removedModules.length, 0, "content edit is not classified as removed");
      assert.equal(contentPreview.changes[0]!.orderChanged, false, "content edit is not classified as reorder");
      assert.equal(contentPreview.baselineChanged, true, "baseline metadata changes remain visible");
    }
  }

  const removalDraft = await createBaselineDraft(baseline.id, "trainer-removal-change");
  assert(!("error" in removalDraft));
  if (!("error" in removalDraft)) {
    const removalVersion = (await db.select().from(learningBaselineVersionsTable).where(eq(learningBaselineVersionsTable.id, removalDraft.versionId)))[0]!;
    const removalSnapshot = structuredClone(removalVersion.snapshot as any);
    removalSnapshot.selections = removalSnapshot.selections.filter((item: Record<string, unknown>) => (item.pathwayId ?? item.pathway_id) !== pathway.id);
    const removalUpdate = await updateBaselineDraft(baseline.id, removalDraft.versionId, removalSnapshot, "trainer-removal-change");
    assert(!("error" in removalUpdate));
    const removalPreview = await baselinePublicationPreview(baseline.id, removalDraft.versionId);
    assert(!("error" in removalPreview));
    if (!("error" in removalPreview)) {
      assert(removalPreview.impact.affectedPathways.some(item => item.pathwayId === pathway.id && item.publicationOutcome === "REMOVED_FROM_DRAFT"), "removed pathway remains in impact");
      assert(removalPreview.impact.preservedEnrollmentCount > 0, "removed pathway enrollments remain counted as preserved history");
    }
  }

  const cancellationDraft = await createBaselineDraft(baseline.id, "trainer-cancellation");
  assert(!("error" in cancellationDraft));
  if (!("error" in cancellationDraft)) {
    activeRole = "trainer";
    activeLearner = person.id;
    const pointerBeforeCancellation = (await db.select().from(learningBaselinesTable).where(eq(learningBaselinesTable.id, baseline.id)))[0]!.publishedVersionId;
    const cancellationResponse = await request(
      `/trainer/authoring/baselines/${baseline.id}/versions/${cancellationDraft.versionId}/cancel`,
      "POST",
      { reason: "Draft is no longer required" },
    );
    assert.equal(cancellationResponse.status, 200);
    const cancellation = await cancellationResponse.json() as { status: string; cancelledBy: string };
    assert.equal(cancellation.status, "CANCELLED");
    assert.equal(cancellation.cancelledBy, person.id);
    const blankReasonResponse = await request(
      `/trainer/authoring/baselines/${baseline.id}/versions/${cancellationDraft.versionId}/cancel`,
      "POST",
      { reason: "   " },
    );
    assert.equal(blankReasonResponse.status, 400, "whitespace-only cancellation reasons are rejected");
    const cancelled = (await db.select().from(learningBaselineVersionsTable).where(eq(learningBaselineVersionsTable.id, cancellationDraft.versionId)))[0]!;
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.cancelledBy, person.id);
    assert(cancelled.cancelledAt);
    assert.equal((await db.select().from(learningBaselinesTable).where(eq(learningBaselinesTable.id, baseline.id)))[0]!.publishedVersionId, pointerBeforeCancellation);
    assert.equal((await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, enrollmentId)))[0]!.baselineVersionId, active.id);
    assert("error" in await updateBaselineDraft(baseline.id, cancellationDraft.versionId, cancelled.snapshot as Record<string, unknown>, "trainer-cancellation"));
    const cancelledPreview = await baselinePublicationPreview(baseline.id, cancellationDraft.versionId);
    assert("error" in cancelledPreview);
    const cancelledPublish = await request(
      `/trainer/authoring/baselines/${baseline.id}/versions/${cancellationDraft.versionId}/publish`,
      "POST",
      { previewFingerprint: "a".repeat(64) },
    );
    assert.equal(cancelledPublish.status, 409, "cancelled drafts cannot be published");
    const cancellationAudit = await db.select().from(learningBaselineAuditTable).where(and(
      eq(learningBaselineAuditTable.versionId, cancellationDraft.versionId),
      eq(learningBaselineAuditTable.action, "CANCEL_DRAFT"),
    ));
    assert.equal(cancellationAudit.length, 1);
    assert.deepEqual(cancellationAudit[0]!.details, { version: cancellationDraft.version, reason: "Draft is no longer required" });
    await assert.rejects(
      db.update(learningBaselineVersionsTable).set({ snapshot: { malformed: true } }).where(eq(learningBaselineVersionsTable.id, cancellationDraft.versionId)),
    );
    await assert.rejects(
      db.delete(learningBaselineVersionsTable).where(eq(learningBaselineVersionsTable.id, cancellationDraft.versionId)),
    );
  }

  const clones = await Promise.all([
    createBaselineDraft(baseline.id, "trainer-a"),
    createBaselineDraft(baseline.id, "trainer-b"),
  ]);
  assert(clones.every(result => !("error" in result)));
  const cloneVersions = clones.map(result => ("error" in result ? -1 : result.version)).sort((a, b) => a - b);
  assert.equal(cloneVersions[1]! - cloneVersions[0]!, 1, "parallel clone versions are sequential");
  const stalePointerDraft = clones[0];
  const interveningDraft = clones[1];
  if (!("error" in stalePointerDraft) && !("error" in interveningDraft)) {
    const stalePointerPreview = await baselinePublicationPreview(baseline.id, stalePointerDraft.versionId);
    const interveningPreview = await baselinePublicationPreview(baseline.id, interveningDraft.versionId);
    assert(!("error" in stalePointerPreview) && !("error" in interveningPreview));
    if (!("error" in stalePointerPreview) && !("error" in interveningPreview)) {
      const interveningPublish = await publishBaseline(baseline.id, interveningDraft.versionId, { id: "trainer-intervening", global: true }, interveningPreview.previewFingerprint);
      assert(!("error" in interveningPublish), "identical intervening draft publishes");
      const stalePointerPublish = await publishBaseline(baseline.id, stalePointerDraft.versionId, { id: "trainer-stale", global: true }, stalePointerPreview.previewFingerprint);
      assert("error" in stalePointerPublish, "review against a previous active version is rejected even when snapshots are identical");
      const pointerAfterStaleAttempt = (await db.select().from(learningBaselinesTable).where(eq(learningBaselinesTable.id, baseline.id)))[0]!.publishedVersionId;
      assert.equal(pointerAfterStaleAttempt, interveningDraft.versionId, "stale publication cannot move the active pointer backward");
    }
  }
  const unauthorizedPublishDraft = clones[0];
  if (!("error" in unauthorizedPublishDraft)) {
    const unauthorizedPreview = await baselinePublicationPreview(baseline.id, unauthorizedPublishDraft.versionId);
    assert(!("error" in unauthorizedPreview));
    if (!("error" in unauthorizedPreview)) {
      const denied = await publishBaseline(baseline.id, unauthorizedPublishDraft.versionId, { id: "trainer-without-assignment", global: false }, unauthorizedPreview.previewFingerprint);
      assert("forbidden" in denied, "publish revalidates manager scope inside the serialized transaction");
    }
  }
  const concurrentDraft = await createBaselineDraft(baseline.id, "trainer-concurrent");
  assert(!("error" in concurrentDraft));
  if ("error" in concurrentDraft) return;
  const publishes = await Promise.all([
    baselinePublicationPreview(baseline.id, concurrentDraft.versionId).then(result => publishBaseline(baseline.id, concurrentDraft.versionId, { id: "trainer-a", global: true }, "error" in result ? "" : result.previewFingerprint)),
    baselinePublicationPreview(baseline.id, concurrentDraft.versionId).then(result => publishBaseline(baseline.id, concurrentDraft.versionId, { id: "trainer-b", global: true }, "error" in result ? "" : result.previewFingerprint)),
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
      baselinePublicationPreview(baseline.id, pinRaceDraft.versionId).then(result => publishBaseline(baseline.id, pinRaceDraft.versionId, { id: "trainer-pin-race", global: true }, "error" in result ? "" : result.previewFingerprint)),
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