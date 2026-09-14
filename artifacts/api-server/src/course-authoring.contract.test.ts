import assert from "node:assert/strict";
import { ApplyCourseAuthoringCommandBody, RequestManagedResourceUploadUrlBody, CreateBaselineDraftResponse, PreviewBaselinePublicationResponse, PublishBaselineVersionBody, PublishBaselineVersionResponse, SelectLearnerPathwayResponse, UpdateBaselineDraftBody } from "@workspace/api-zod";
import { allocatedSiblingSequence, assignmentAllows, orderedSiblingIds } from "./lib/course-authoring";
import { learnerCourseAvailable } from "./routes/learning";

// Fast contract coverage complements database integration tests: every UI action
// is represented by the generated contract and unsafe upload metadata is refused
// before a presigned URL can be issued.
for (const action of ["CREATE", "UPDATE", "REORDER", "DUPLICATE", "ARCHIVE"] as const) {
  for (const entity of ["COURSE", "COURSE_MODULE", "LESSON", "ACTIVITY", "OUTCOME", "RESOURCE"] as const) {
    assert.equal(ApplyCourseAuthoringCommandBody.safeParse({ action, entity, courseId: "course-1", id: "entity-1" }).success, true);
  }
}
assert.equal(RequestManagedResourceUploadUrlBody.safeParse({ name: "lesson.pdf", size: 1024, contentType: "application/pdf" }).success, true);
assert.equal(RequestManagedResourceUploadUrlBody.safeParse({ name: "../unsafe.pdf", size: 1024, contentType: "application/pdf" }).success, false);
assert.equal(RequestManagedResourceUploadUrlBody.safeParse({ name: "movie.exe", size: 1024, contentType: "application/octet-stream" }).success, false);
assert.equal(RequestManagedResourceUploadUrlBody.safeParse({ name: "large.mp4", size: 104857601, contentType: "video/mp4" }).success, false);

const siblings = [
  { id: "first", sequence: 1 },
  { id: "second", sequence: 2 },
  { id: "third", sequence: 3 },
];
assert.deepEqual(
  orderedSiblingIds(siblings, "second", { direction: "UP" }),
  ["second", "first", "third"],
  "UP swaps with the previous sibling",
);
assert.deepEqual(
  orderedSiblingIds(siblings, "second", { direction: "DOWN" }),
  ["first", "third", "second"],
  "DOWN swaps with the next sibling",
);
assert.deepEqual(
  orderedSiblingIds(siblings, "third", { sequence: 1 }),
  ["third", "first", "second"],
  "numeric sequence moves and normalizes the complete sibling set",
);
assert.throws(
  () => orderedSiblingIds(siblings, "cross-course", { direction: "UP" }),
  /not found in sibling set/,
);
assert.throws(
  () => orderedSiblingIds(siblings, "first", { direction: "SIDEWAYS" }),
  /UP or DOWN/,
);

assert.equal(
  learnerCourseAvailable({ status: "DRAFT", publishedVersionId: "version-1" }),
  true,
  "a mutable draft remains learner-visible through its immutable published version",
);
assert.equal(
  learnerCourseAvailable({ status: "ARCHIVED", publishedVersionId: "version-1" }),
  false,
  "intentional course archive removes learner availability",
);
assert.equal(
  learnerCourseAvailable({ status: "PUBLISHED", publishedVersionId: null }),
  false,
  "mutable status alone cannot expose an unpublished course",
);

const created: Array<{ id: string; sequence: number }> = [];
for (const id of ["one", "two", "three"]) {
  created.push({ id, sequence: allocatedSiblingSequence(created) });
}
assert.deepEqual(created.map(row => row.sequence), [1, 2, 3], "omitted sequences append without collisions");
assert.equal(allocatedSiblingSequence(created, 2), 2, "explicit insertion position is retained");

const assignments = [
  { trainerId: "trainer-a", programId: "program-a", pathwayId: "path-a", status: "active" },
  { trainerId: "trainer-a", programId: "program-b", pathwayId: "path-b", status: "active" },
  { trainerId: "trainer-b", programId: "program-c", pathwayId: "path-c", status: "inactive" },
];
assert.equal(assignmentAllows(assignments, "trainer-a", "program-a", "path-a"), true);
assert.equal(assignmentAllows(assignments, "trainer-a", "program-b", "path-b"), true, "multiple active assignments are supported");
assert.equal(assignmentAllows(assignments, "trainer-a", "program-c", "path-c"), false, "unrelated pathways are denied");
assert.equal(assignmentAllows(assignments, "trainer-b", "program-c", "path-c"), false, "inactive assignments are denied");

assert.equal(CreateBaselineDraftResponse.safeParse({
  baselineId: "baseline-1", versionId: "baseline-version-2", version: 2, status: "DRAFT", sourceVersion: 1,
}).success, true, "baseline clone response is contract-valid");
assert.equal(PublishBaselineVersionResponse.safeParse({
  baselineId: "baseline-1", versionId: "baseline-version-2", version: 2, status: "PUBLISHED",
  publishedAt: new Date().toISOString(),
}).success, true, "baseline publish response is contract-valid");
assert.equal(PublishBaselineVersionBody.safeParse({ previewFingerprint: "a".repeat(64) }).success, true, "baseline publish requires a reviewed preview");
assert.equal(PublishBaselineVersionBody.safeParse({}).success, false, "baseline publish refuses a missing preview");
assert.equal(PreviewBaselinePublicationResponse.safeParse({
  baselineId: "baseline-1",
  activeVersion: { versionId: "v1", version: 1 },
  draftVersion: { versionId: "v2", version: 2 },
  previewFingerprint: "b".repeat(64),
  baselineChanged: false,
  baselineBefore: { id: "baseline-1" },
  baselineAfter: { id: "baseline-1" },
  changes: [{
    pathwayId: "path-1", pathwayName: "Primary", status: "CHANGED",
    addedModules: [], removedModules: [],
    modifiedModules: [{
      before: { id: "bm-1", moduleId: "m-1", code: "M01", name: "Old", sequence: 1, details: { name: "Old" } },
      after: { id: "bm-1", moduleId: "m-1", code: "M01", name: "New", sequence: 1, details: { name: "New" } },
      changedFields: ["name"],
    }],
    orderChanged: false,
    before: [{ id: "bm-1", moduleId: "m-1", code: "M01", name: "Old", sequence: 1, details: { name: "Old" } }],
    after: [{ id: "bm-1", moduleId: "m-1", code: "M01", name: "New", sequence: 1, details: { name: "New" } }],
  }],
  impact: {
    affectedPathways: [{ pathwayId: "path-1", pathwayName: "Primary", publicationOutcome: "NEW_ENROLLMENTS_USE_DRAFT" }],
    eligibleCohorts: [{ id: "cohort-1", name: "2026", programId: "program-1", status: "active" }],
    futureEnrollmentRule: "New enrollments pin v2.",
    preservedEnrollmentCount: 2,
    preservedEnrollmentsByVersion: [{ baselineVersionId: "v1", count: 2 }],
    historyRule: "Existing history stays on v1.",
  },
}).success, true, "baseline publication preview is contract-valid");
assert.equal(UpdateBaselineDraftBody.safeParse({ snapshot: { modules: [], selections: [] } }).success, true, "baseline draft edits are contract-valid");
assert.equal(SelectLearnerPathwayResponse.safeParse({
  pathway: { id: "path-1", name: "Path", type: "Primary", purpose: "unspecified", outcome: "Outcome", moduleCount: 1, gateCount: 0, gates: [], terminalPortfolio: "Capability Portfolio" },
  programId: "program-1", baselineVersionId: "baseline-version-2", selectedAt: new Date().toISOString(),
}).success, true, "learner pathway selection requires a baseline pin");
assert.equal(SelectLearnerPathwayResponse.safeParse({
  pathway: { id: "path-1", name: "Path", type: "Primary", purpose: "unspecified", outcome: "Outcome", moduleCount: 1, gateCount: 0, gates: [], terminalPortfolio: "Capability Portfolio" },
  programId: "program-1", selectedAt: new Date().toISOString(),
}).success, false, "learner pathway selection rejects a missing baseline pin");