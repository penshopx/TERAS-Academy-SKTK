import { Router, type IRouter } from "express";
import type { Response } from "express";
import {
  ApplyCourseAuthoringCommandBody, ApplyCourseAuthoringCommandResponse,
  ListAuthoredCoursesResponse, ListAuthoredCourseVersionsParams, ListAuthoredCourseVersionsResponse,
  ListCourseAuthoringAuditParams, ListCourseAuthoringAuditResponse,
  PreviewAuthoredCourseParams, PreviewAuthoredCourseResponse,
  PublishAuthoredCourseParams, PublishAuthoredCourseResponse,
  CreateBaselineDraftParams, CreateBaselineDraftResponse,
  CancelBaselineDraftBody, CancelBaselineDraftParams, CancelBaselineDraftResponse,
  UpdateBaselineDraftBody, UpdateBaselineDraftParams, UpdateBaselineDraftResponse,
  PublishBaselineVersionParams, PublishBaselineVersionResponse,
  PreviewBaselinePublicationParams, PreviewBaselinePublicationResponse, PublishBaselineVersionBody,
  ListBaselineVersionsParams, ListBaselineVersionsResponse,
  ListManagedBaselinesResponse,
  ListBaselineAuditParams, ListBaselineAuditResponse,
  ValidateAuthoredCourseParams, ValidateAuthoredCourseResponse,
} from "@workspace/api-zod";
import { authorizeBaselineManager, authorizeWorkspaceRole, type BaselineManager } from "../lib/authorization";
import { applyCourseAuthoring, authoredCourse, courseAudit, coursePreview, courseVersions, listAuthoredCourses, publishCourse, trainerHasAssignment, validateCourse } from "../lib/course-authoring";
import { db, enrollmentsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { baselineAudit, baselinePathwayIds, baselinePublicationPreview, cancelBaselineDraft, createBaselineDraft, listBaselineVersions, listManagedBaselines, publishBaseline, snapshotPathwayIds, updateBaselineDraft } from "../lib/baseline-authoring";

const router: IRouter = Router();
async function requireBaselineScope(baselineId: string, manager: BaselineManager, res: Response, additionalPathways: Iterable<string> = []) {
  if (manager.global) return true;
  const pathwayIds = [...new Set([...await baselinePathwayIds(baselineId), ...additionalPathways])];
  if (!pathwayIds.length) { res.status(404).json({ error: "Baseline not found" }); return false; }
  const assignments = await db.select({ pathwayId: enrollmentsTable.pathwayId }).from(enrollmentsTable).where(and(
    eq(enrollmentsTable.trainerId, manager.id), eq(enrollmentsTable.status, "active"),
    inArray(enrollmentsTable.pathwayId, pathwayIds),
  ));
  const assignedPathways = new Set(assignments.map(row => row.pathwayId));
  if (!pathwayIds.every(pathwayId => assignedPathways.has(pathwayId))) {
    res.status(403).json({ error: "You must be assigned to every pathway governed by this baseline" });
    return false;
  }
  return true;
}

router.get("/trainer/authoring/baselines", async (req, res): Promise<void> => {
  const manager = await authorizeBaselineManager(req, res);
  if (!manager) return;
  res.json(ListManagedBaselinesResponse.parse(await listManagedBaselines(manager)));
});

router.post("/trainer/authoring/baselines/:baselineId/drafts", async (req, res): Promise<void> => {
  const manager = await authorizeBaselineManager(req, res);
  if (!manager) return;
  const parsed = CreateBaselineDraftParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireBaselineScope(parsed.data.baselineId, manager, res)) return;
  const result = await createBaselineDraft(parsed.data.baselineId, manager.id);
  if ("error" in result) { res.status(result.error === "Baseline not found" ? 404 : 409).json({ error: result.error }); return; }
  res.status(201).json(CreateBaselineDraftResponse.parse(result));
});

router.post("/trainer/authoring/baselines/:baselineId/versions/:versionId/publish", async (req, res): Promise<void> => {
  const manager = await authorizeBaselineManager(req, res);
  if (!manager) return;
  const parsed = PublishBaselineVersionParams.safeParse(req.params);
  const body = PublishBaselineVersionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  if (!await requireBaselineScope(parsed.data.baselineId, manager, res)) return;
  const result = await publishBaseline(parsed.data.baselineId, parsed.data.versionId, manager, body.data.previewFingerprint);
  if ("error" in result) { res.status("forbidden" in result ? 403 : result.error === "Baseline draft not found" ? 404 : 409).json({ error: result.error, ...("report" in result ? { report: result.report } : {}) }); return; }
  res.status(201).json(PublishBaselineVersionResponse.parse(result));
});

router.post("/trainer/authoring/baselines/:baselineId/versions/:versionId/cancel", async (req, res): Promise<void> => {
  const manager = await authorizeBaselineManager(req, res);
  if (!manager) return;
  const parsed = CancelBaselineDraftParams.safeParse(req.params);
  const body = CancelBaselineDraftBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  if (!await requireBaselineScope(parsed.data.baselineId, manager, res)) return;
  const result = await cancelBaselineDraft(parsed.data.baselineId, parsed.data.versionId, manager.id, body.data.reason);
  if ("error" in result) { res.status("invalid" in result ? 400 : result.error === "Baseline draft not found" ? 404 : 409).json({ error: result.error }); return; }
  res.json(CancelBaselineDraftResponse.parse(result));
});

router.get("/trainer/authoring/baselines/:baselineId/versions/:versionId/publication-preview", async (req, res): Promise<void> => {
  const manager = await authorizeBaselineManager(req, res);
  if (!manager) return;
  const parsed = PreviewBaselinePublicationParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireBaselineScope(parsed.data.baselineId, manager, res)) return;
  const result = await baselinePublicationPreview(parsed.data.baselineId, parsed.data.versionId);
  if ("error" in result) { res.status(result.error === "Baseline draft not found" ? 404 : 409).json({ error: result.error }); return; }
  res.json(PreviewBaselinePublicationResponse.parse(result));
});

router.patch("/trainer/authoring/baselines/:baselineId/versions/:versionId", async (req, res): Promise<void> => {
  const manager = await authorizeBaselineManager(req, res);
  if (!manager) return;
  const parsed = UpdateBaselineDraftParams.safeParse(req.params);
  const body = UpdateBaselineDraftBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error?.message ?? "Invalid baseline draft" }); return; }
  if (!await requireBaselineScope(parsed.data.baselineId, manager, res, snapshotPathwayIds(body.data.snapshot))) return;
  const result = await updateBaselineDraft(parsed.data.baselineId, parsed.data.versionId, body.data.snapshot, manager.id);
  if ("error" in result) { res.status(result.error === "Baseline draft not found" ? 404 : 409).json({ error: result.error, ...("report" in result ? { report: result.report } : {}) }); return; }
  res.json(UpdateBaselineDraftResponse.parse(result));
});

router.get("/trainer/authoring/baselines/:baselineId/versions", async (req, res): Promise<void> => {
  const manager = await authorizeBaselineManager(req, res);
  if (!manager) return;
  const parsed = ListBaselineVersionsParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireBaselineScope(parsed.data.baselineId, manager, res)) return;
  res.json(ListBaselineVersionsResponse.parse(await listBaselineVersions(parsed.data.baselineId)));
});

router.get("/trainer/authoring/baselines/:baselineId/audit", async (req, res): Promise<void> => {
  const manager = await authorizeBaselineManager(req, res);
  if (!manager) return;
  const parsed = ListBaselineAuditParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireBaselineScope(parsed.data.baselineId, manager, res)) return;
  res.json(ListBaselineAuditResponse.parse(await baselineAudit(parsed.data.baselineId)));
});
async function hasCourseScope(courseId: string, trainerId: string) {
  const aggregate = await authoredCourse(courseId);
  if (!aggregate) return "missing" as const;
  return await trainerHasAssignment(trainerId, aggregate.course.programId, aggregate.course.pathwayId) ? "allowed" as const : "forbidden" as const;
}
async function requireCourseScope(courseId: string, trainerId: string, res: Response) {
  const result = await hasCourseScope(courseId, trainerId);
  if (result === "allowed") return true;
  res.status(result === "missing" ? 404 : 403).json({ error: result === "missing" ? "Course not found" : "You are not assigned to this course pathway" });
  return false;
}

router.get("/trainer/authoring/courses", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer");
  if (!trainerId) return;
  const assignments = await db.select().from(enrollmentsTable).where(and(eq(enrollmentsTable.trainerId, trainerId), eq(enrollmentsTable.status, "active")));
  const scopes = new Set(assignments.map(row => `${row.programId}:${row.pathwayId}`));
  const courses = (await listAuthoredCourses()).filter((course): course is Exclude<typeof course, undefined> => course !== undefined && scopes.has(`${course.programId}:${course.pathwayId}`));
  res.json(ListAuthoredCoursesResponse.parse(courses));
});

router.post("/trainer/authoring/commands", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer");
  if (!trainerId) return;
  const parsed = ApplyCourseAuthoringCommandBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const requestedPathway = typeof parsed.data.data?.pathwayId === "string" ? parsed.data.data.pathwayId : undefined;
  if (parsed.data.action === "CREATE" && parsed.data.entity === "COURSE") {
    const requestedProgram = typeof parsed.data.data?.programId === "string" ? parsed.data.data.programId : "";
    if (!requestedPathway || !await trainerHasAssignment(trainerId, requestedProgram, requestedPathway)) { res.status(403).json({ error: "You are not assigned to this course pathway" }); return; }
  } else if (!await requireCourseScope(parsed.data.courseId, trainerId, res)) return;
  const result = await applyCourseAuthoring(parsed.data, trainerId);
  if ("error" in result && result.error) { res.status(result.error.includes("not found") ? 404 : 409).json({ error: result.error }); return; }
  req.log.info({ trainerId, courseId: parsed.data.courseId, entity: result.entity, action: result.action }, "Course authoring command applied");
  res.status(parsed.data.action === "CREATE" || parsed.data.action === "DUPLICATE" ? 201 : 200).json(ApplyCourseAuthoringCommandResponse.parse(result));
});

router.get("/trainer/authoring/courses/:courseId/preview", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer");
  if (!trainerId) return;
  const parsed = PreviewAuthoredCourseParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireCourseScope(parsed.data.courseId, trainerId, res)) return;
  const preview = await coursePreview(parsed.data.courseId);
  if (!preview) { res.status(404).json({ error: "Course not found" }); return; }
  res.json(PreviewAuthoredCourseResponse.parse(preview));
});

router.get("/trainer/authoring/courses/:courseId/validation", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer");
  if (!trainerId) return;
  const parsed = ValidateAuthoredCourseParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireCourseScope(parsed.data.courseId, trainerId, res)) return;
  const report = await validateCourse(parsed.data.courseId);
  if (!report) { res.status(404).json({ error: "Course not found" }); return; }
  res.json(ValidateAuthoredCourseResponse.parse(report));
});

router.post("/trainer/authoring/courses/:courseId/publish", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer");
  if (!trainerId) return;
  const parsed = PublishAuthoredCourseParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireCourseScope(parsed.data.courseId, trainerId, res)) return;
  const result = await publishCourse(parsed.data.courseId, trainerId);
  if ("error" in result) {
    res.status(result.error === "Course not found" ? 404 : 409).json({ error: result.error, ...("report" in result ? { report: result.report } : {}) });
    return;
  }
  req.log.info({ trainerId, courseId: result.courseId, version: result.version }, "Immutable course version published");
  res.status(201).json(PublishAuthoredCourseResponse.parse(result));
});

router.get("/trainer/authoring/courses/:courseId/versions", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  const parsed = ListAuthoredCourseVersionsParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireCourseScope(parsed.data.courseId, trainerId, res)) return;
  res.json(ListAuthoredCourseVersionsResponse.parse(await courseVersions(parsed.data.courseId)));
});

router.get("/trainer/authoring/courses/:courseId/audit", async (req, res): Promise<void> => {
  const trainerId = await authorizeWorkspaceRole(req, res, "trainer"); if (!trainerId) return;
  const parsed = ListCourseAuthoringAuditParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!await requireCourseScope(parsed.data.courseId, trainerId, res)) return;
  res.json(ListCourseAuthoringAuditResponse.parse(await courseAudit(parsed.data.courseId)));
});

export default router;