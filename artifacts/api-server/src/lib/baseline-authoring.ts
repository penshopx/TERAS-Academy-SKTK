import { createHash } from "node:crypto";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  db,
  learningBaselineAuditTable,
  learningBaselinePathwayScopesTable,
  learningBaselineVersionsTable,
  learningBaselinesTable,
  cohortsTable,
  enrollmentsTable,
  modulesTable,
  pathwaysTable,
} from "@workspace/db";

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
type Snapshot = {
  baseline?: Record<string, unknown>;
  modules?: Array<Record<string, unknown>>;
  selections?: Array<Record<string, unknown>>;
};

export type BaselineValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export function validateBaselineSnapshot(value: unknown, expectedBaselineId?: string): { valid: boolean; errors: BaselineValidationIssue[] } {
  const errors: BaselineValidationIssue[] = [];
  const object = (input: unknown): input is Record<string, unknown> =>
    Boolean(input && typeof input === "object" && !Array.isArray(input));
  if (!object(value)) return { valid: false, errors: [{ code: "SNAPSHOT_OBJECT_REQUIRED", message: "snapshot must be an object", path: "snapshot" }] };
  const baseline = value.baseline;
  const modules = value.modules;
  const selections = value.selections;
  if (!object(baseline)) errors.push({ code: "BASELINE_REQUIRED", message: "snapshot.baseline must be an object", path: "baseline" });
  if (!Array.isArray(modules)) errors.push({ code: "MODULES_REQUIRED", message: "snapshot.modules must be an array", path: "modules" });
  if (!Array.isArray(selections)) errors.push({ code: "SELECTIONS_REQUIRED", message: "snapshot.selections must be an array", path: "selections" });
  if (errors.length) return { valid: false, errors };
  const baselineObject = baseline as Record<string, unknown>;
  const moduleRows = modules as unknown[];
  const selectionRows = selections as unknown[];
  const baselineId = typeof baselineObject.id === "string" ? baselineObject.id : typeof baselineObject.id_ === "string" ? baselineObject.id_ : undefined;
  if (!baselineId) errors.push({ code: "BASELINE_ID_REQUIRED", message: "snapshot.baseline.id is required", path: "baseline.id" });
  if (expectedBaselineId && baselineId && baselineId !== expectedBaselineId) errors.push({ code: "BASELINE_ID_MISMATCH", message: "snapshot.baseline.id must match the route baseline", path: "baseline.id" });
  const moduleIds = new Set<string>();
  for (const [index, module] of moduleRows.entries()) {
    if (!object(module)) { errors.push({ code: "MODULE_OBJECT_REQUIRED", message: "each module must be an object", path: `modules[${index}]` }); continue; }
    const moduleId = typeof module.id === "string" ? module.id : undefined;
    if (!moduleId) errors.push({ code: "MODULE_ID_REQUIRED", message: "each module needs an id", path: `modules[${index}].id` });
    else if (moduleIds.has(moduleId)) errors.push({ code: "MODULE_ID_DUPLICATE", message: "module ids must be unique", path: `modules[${index}].id` });
    else moduleIds.add(moduleId);
    if ((typeof module.moduleId !== "string" || !module.moduleId)
      && (typeof module.module_id !== "string" || !module.module_id)) {
      errors.push({ code: "MODULE_FIELD_REQUIRED", message: "moduleId is required", path: `modules[${index}].moduleId` });
    }
    for (const field of ["code", "name"]) {
      if (typeof module[field] !== "string" || !module[field]) errors.push({ code: "MODULE_FIELD_REQUIRED", message: `${field} is required`, path: `modules[${index}].${field}` });
    }
    if (baselineId && ((module.baselineId !== undefined && module.baselineId !== baselineId)
      || (module.baseline_id !== undefined && module.baseline_id !== baselineId))) {
      errors.push({ code: "MODULE_BASELINE_MISMATCH", message: "module baseline must match snapshot baseline", path: `modules[${index}]` });
    }
  }
  const selectionKeys = new Set<string>();
  for (const [index, selection] of selectionRows.entries()) {
    if (!object(selection)) { errors.push({ code: "SELECTION_OBJECT_REQUIRED", message: "each selection must be an object", path: `selections[${index}]` }); continue; }
    const pathwayId = selection.pathwayId ?? selection.pathway_id;
    const baselineModuleId = selection.baselineModuleId ?? selection.baseline_module_id;
    if (typeof pathwayId !== "string" || !pathwayId) errors.push({ code: "SELECTION_PATHWAY_REQUIRED", message: "selection pathwayId is required", path: `selections[${index}].pathwayId` });
    if (typeof baselineModuleId !== "string" || !baselineModuleId) errors.push({ code: "SELECTION_MODULE_REQUIRED", message: "selection baselineModuleId is required", path: `selections[${index}].baselineModuleId` });
    if (typeof baselineModuleId === "string" && !moduleIds.has(baselineModuleId)) errors.push({ code: "SELECTION_MODULE_UNKNOWN", message: "selection references a missing baseline module", path: `selections[${index}].baselineModuleId` });
    const key = `${String(pathwayId)}:${String(baselineModuleId)}`;
    if (selectionKeys.has(key)) errors.push({ code: "SELECTION_DUPLICATE", message: "pathway/module selections must be unique", path: `selections[${index}]` });
    selectionKeys.add(key);
    if (selection.sequence !== undefined && (!Number.isInteger(selection.sequence) || Number(selection.sequence) < 1)) errors.push({ code: "SELECTION_SEQUENCE_INVALID", message: "selection sequence must be a positive integer", path: `selections[${index}].sequence` });
  }
  return { valid: errors.length === 0, errors };
}

async function validateSnapshotReferences(value: unknown, baselineId: string, executor: any) {
  const report = validateBaselineSnapshot(value, baselineId);
  if (!report.valid) return report;
  const snapshot = value as Snapshot;
  const selections = snapshot.selections ?? [];
  const modules = snapshot.modules ?? [];
  const pathwayIds = [...new Set(selections.map(selection => selection.pathwayId ?? selection.pathway_id).filter((id): id is string => typeof id === "string"))];
  const moduleIds = [...new Set(modules.map(module => module.moduleId ?? module.module_id).filter((id): id is string => typeof id === "string"))];
  // Validation also runs on a transaction connection during publish, so keep
  // these reads sequential rather than issuing concurrent queries on one client.
  const pathways = await executor.select({ id: pathwaysTable.id, programId: pathwaysTable.programId }).from(pathwaysTable)
    .where(pathwayIds.length ? inArray(pathwaysTable.id, pathwayIds) : eq(pathwaysTable.id, ""));
  const catalogueModules = await executor.select({ id: modulesTable.id, programId: modulesTable.programId }).from(modulesTable)
    .where(moduleIds.length ? inArray(modulesTable.id, moduleIds) : eq(modulesTable.id, ""));
  const pathwayPrograms = new Map(pathways.map((row: { id: string; programId: string }) => [row.id, row.programId]));
  const modulePrograms = new Map(catalogueModules.map((row: { id: string; programId: string }) => [row.id, row.programId]));
  const snapshotModuleCatalogueIds = new Map(modules.flatMap(module => {
    const snapshotModuleId = module.id;
    const catalogueModuleId = module.moduleId ?? module.module_id;
    return typeof snapshotModuleId === "string" && typeof catalogueModuleId === "string"
      ? [[snapshotModuleId, catalogueModuleId] as const]
      : [];
  }));
  for (const [index, selection] of selections.entries()) {
    const pathwayId = selection.pathwayId ?? selection.pathway_id;
    const baselineModuleId = selection.baselineModuleId ?? selection.baseline_module_id;
    if (typeof pathwayId === "string" && !pathwayPrograms.has(pathwayId)) {
      report.errors.push({ code: "SELECTION_PATHWAY_UNKNOWN", message: "selection references a missing pathway", path: `selections[${index}].pathwayId` });
    } else if (typeof pathwayId === "string" && typeof baselineModuleId === "string") {
      const catalogueModuleId = snapshotModuleCatalogueIds.get(baselineModuleId);
      if (catalogueModuleId && pathwayPrograms.get(pathwayId) !== modulePrograms.get(catalogueModuleId)) {
        report.errors.push({ code: "SELECTION_PROGRAM_MISMATCH", message: "selected modules must belong to the pathway program", path: `selections[${index}]` });
      }
    }
  }
  for (const [index, module] of modules.entries()) {
    const moduleId = module.moduleId ?? module.module_id;
    if (typeof moduleId === "string" && !modulePrograms.has(moduleId)) report.errors.push({ code: "MODULE_UNKNOWN", message: "snapshot module references a missing catalogue module", path: `modules[${index}].moduleId` });
    const linkedBaseline = module.baselineId ?? module.baseline_id;
    if (linkedBaseline !== undefined && linkedBaseline !== baselineId) report.errors.push({ code: "MODULE_BASELINE_MISMATCH", message: "module baseline must match snapshot baseline", path: `modules[${index}].baselineId` });
  }
  return { valid: report.errors.length === 0, errors: report.errors };
}

function snapshotOf(row: typeof learningBaselineVersionsTable.$inferSelect): Snapshot {
  return row.snapshot as Snapshot;
}

const stringField = (row: Record<string, unknown>, camel: string, snake: string) =>
  typeof row[camel] === "string" ? String(row[camel]) : typeof row[snake] === "string" ? String(row[snake]) : "";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

const moduleSummary = (row: Record<string, unknown>) => ({
  id: stringField(row, "id", "id"),
  moduleId: stringField(row, "moduleId", "module_id"),
  code: stringField(row, "code", "code"),
  name: stringField(row, "name", "name"),
  details: canonicalize(row) as Record<string, unknown>,
});

const pathwayModules = (snapshot: Snapshot) => {
  const modules = new Map((snapshot.modules ?? []).map(module => [String(module.id), module]));
  const result = new Map<string, Array<ReturnType<typeof moduleSummary> & { sequence: number }>>();
  for (const selection of snapshot.selections ?? []) {
    const pathwayId = stringField(selection, "pathwayId", "pathway_id");
    const selected = modules.get(stringField(selection, "baselineModuleId", "baseline_module_id"));
    if (!pathwayId || !selected) continue;
    const rows = result.get(pathwayId) ?? [];
    rows.push({ ...moduleSummary(selected), sequence: Number(selection.sequence ?? rows.length + 1) });
    result.set(pathwayId, rows);
  }
  for (const rows of result.values()) rows.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return result;
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function baselinePublicationPreviewWithExecutor(baselineId: string, versionId: string, executor: any) {
  const [baseline] = await executor.select().from(learningBaselinesTable).where(eq(learningBaselinesTable.id, baselineId)).limit(1);
  if (!baseline?.publishedVersionId) return { error: "Baseline has no active published version" as const };
  const versions = await executor.select().from(learningBaselineVersionsTable).where(inArray(
    learningBaselineVersionsTable.id, [baseline.publishedVersionId, versionId],
  ));
  const active = versions.find((row: typeof learningBaselineVersionsTable.$inferSelect) => row.id === baseline.publishedVersionId && row.status === "PUBLISHED");
  const draft = versions.find((row: typeof learningBaselineVersionsTable.$inferSelect) => row.id === versionId && row.baselineId === baselineId && row.status === "DRAFT");
  if (!active) return { error: "Baseline has no active published version" as const };
  if (!draft) return { error: "Baseline draft not found" as const };

  const activeByPathway = pathwayModules(snapshotOf(active));
  const draftByPathway = pathwayModules(snapshotOf(draft));
  const activeBaseline = canonicalize(snapshotOf(active).baseline ?? {}) as Record<string, unknown>;
  const draftBaseline = canonicalize(snapshotOf(draft).baseline ?? {}) as Record<string, unknown>;
  const baselineChanged = JSON.stringify(activeBaseline) !== JSON.stringify(draftBaseline);
  const pathwayIds = [...new Set([...activeByPathway.keys(), ...draftByPathway.keys()])].sort();
  const pathwayRows = (pathwayIds.length
    ? await executor.select({ id: pathwaysTable.id, name: pathwaysTable.name, programId: pathwaysTable.programId }).from(pathwaysTable).where(inArray(pathwaysTable.id, pathwayIds))
    : []).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  const pathwayNames = new Map(pathwayRows.map((row: { id: string; name: string }) => [row.id, row.name]));
  const changes = pathwayIds.map(pathwayId => {
    const before = activeByPathway.get(pathwayId) ?? [];
    const after = draftByPathway.get(pathwayId) ?? [];
    const beforeById = new Map(before.map(row => [row.id, row]));
    const afterById = new Map(after.map(row => [row.id, row]));
    const content = (row: typeof before[number]) => JSON.stringify(row.details);
    const sharedBeforeIds = before.map(row => row.id).filter(moduleId => afterById.has(moduleId));
    const sharedAfterIds = after.map(row => row.id).filter(moduleId => beforeById.has(moduleId));
    const orderChanged = sharedBeforeIds.some((moduleId, index) => moduleId !== sharedAfterIds[index]);
    return {
      pathwayId,
      pathwayName: pathwayNames.get(pathwayId) ?? pathwayId,
      status: !activeByPathway.has(pathwayId) ? "ADDED" : !draftByPathway.has(pathwayId) ? "REMOVED" : "CHANGED",
      addedModules: after.filter(row => !beforeById.has(row.id)),
      removedModules: before.filter(row => !afterById.has(row.id)),
      modifiedModules: before.flatMap(previous => {
        const next = afterById.get(previous.id);
        if (!next || content(previous) === content(next)) return [];
        const fields = [...new Set([...Object.keys(previous.details), ...Object.keys(next.details)])]
          .filter(field => JSON.stringify(previous.details[field]) !== JSON.stringify(next.details[field]))
          .sort();
        return [{ before: previous, after: next, changedFields: fields }];
      }),
      orderChanged,
      before,
      after,
    };
  }).filter(change => change.status !== "CHANGED" || change.addedModules.length || change.removedModules.length || change.modifiedModules.length || change.orderChanged);

  const affectedPathwayIds = pathwayIds;
  const existingEnrollments = (affectedPathwayIds.length
    ? await executor.select({
      id: enrollmentsTable.id, pathwayId: enrollmentsTable.pathwayId, cohortId: enrollmentsTable.cohortId,
      baselineVersionId: enrollmentsTable.baselineVersionId, status: enrollmentsTable.status,
    }).from(enrollmentsTable).where(inArray(enrollmentsTable.pathwayId, affectedPathwayIds))
    : []).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  const programIds: string[] = [...new Set<string>(
    pathwayRows
      .filter((row: { id: string }) => affectedPathwayIds.includes(row.id))
      .map((row: { programId: string }) => row.programId),
  )];
  const eligibleCohorts = (programIds.length
    ? await executor.select({ id: cohortsTable.id, name: cohortsTable.name, programId: cohortsTable.programId, status: cohortsTable.status })
      .from(cohortsTable).where(and(inArray(cohortsTable.programId, programIds), eq(cohortsTable.status, "active")))
    : []).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  const preservedByVersion = new Map<string, number>();
  for (const enrollment of existingEnrollments) {
    const key = enrollment.baselineVersionId ?? "legacy-unpinned";
    preservedByVersion.set(key, (preservedByVersion.get(key) ?? 0) + 1);
  }
  const preview = {
    baselineId,
    activeVersion: { versionId: active.id, version: active.version },
    draftVersion: { versionId: draft.id, version: draft.version },
    baselineChanged,
    baselineBefore: activeBaseline,
    baselineAfter: draftBaseline,
    changes,
    impact: {
      affectedPathways: affectedPathwayIds.map(pathwayId => ({
        pathwayId,
        pathwayName: pathwayNames.get(pathwayId) ?? pathwayId,
        publicationOutcome: draftByPathway.has(pathwayId) ? "NEW_ENROLLMENTS_USE_DRAFT" : "REMOVED_FROM_DRAFT",
      })),
      eligibleCohorts,
      futureEnrollmentRule: "New enrollments in pathways retained by the draft will pin the published draft version; removed pathways receive no new baseline coverage.",
      preservedEnrollmentCount: existingEnrollments.length,
      preservedEnrollmentsByVersion: [...preservedByVersion.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([baselineVersionId, count]) => ({ baselineVersionId, count })),
      historyRule: "Existing enrollments and pathway history remain pinned to their previous baseline version.",
    },
  };
  return { ...preview, previewFingerprint: digest(preview) };
}

export async function baselinePublicationPreview(baselineId: string, versionId: string) {
  return baselinePublicationPreviewWithExecutor(baselineId, versionId, db);
}

/** Resolve the active published version without ever selecting a draft. */
async function publishedBaselineForPathwayWithExecutor(pathwayId: string, executor: any) {
  const versions = await executor.select({
    version: learningBaselineVersionsTable,
    baseline: learningBaselinesTable,
  }).from(learningBaselineVersionsTable)
    .innerJoin(learningBaselinesTable, eq(learningBaselinesTable.id, learningBaselineVersionsTable.baselineId))
    .where(eq(learningBaselineVersionsTable.status, "PUBLISHED"))
    .orderBy(desc(learningBaselineVersionsTable.publishedAt), desc(learningBaselineVersionsTable.version));
  const applicable = ({ version }: typeof versions[number]) => snapshotOf(version).selections?.some(selection =>
    (selection.pathwayId ?? selection.pathway_id) === pathwayId,
  );
  return versions.find(({ version, baseline }: { version: typeof learningBaselineVersionsTable.$inferSelect; baseline: typeof learningBaselinesTable.$inferSelect }) => baseline.publishedVersionId === version.id && applicable({ version, baseline })) ?? null;
}

export async function publishedBaselineForPathway(pathwayId: string) {
  return publishedBaselineForPathwayWithExecutor(pathwayId, db);
}

export async function createBaselineDraft(baselineId: string, actorId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${baselineId}, 0))`);
    const [baseline] = await tx.select().from(learningBaselinesTable)
      .where(eq(learningBaselinesTable.id, baselineId)).limit(1);
    if (!baseline) return { error: "Baseline not found" as const };
    const [source] = await tx.select().from(learningBaselineVersionsTable)
      .where(and(eq(learningBaselineVersionsTable.id, baseline.publishedVersionId ?? ""), eq(learningBaselineVersionsTable.status, "PUBLISHED"))).limit(1);
    const [fallback] = source ? [source] : await tx.select().from(learningBaselineVersionsTable)
      .where(and(eq(learningBaselineVersionsTable.baselineId, baselineId), eq(learningBaselineVersionsTable.status, "PUBLISHED")))
      .orderBy(desc(learningBaselineVersionsTable.version)).limit(1);
    if (!fallback) return { error: "Baseline has no published version" as const };
    const sourceValidation = await validateSnapshotReferences(fallback.snapshot, baselineId, tx);
    if (!sourceValidation.valid) return { error: "Published baseline snapshot is invalid" as const, report: sourceValidation };
    const [next] = await tx.select({ value: max(learningBaselineVersionsTable.version) })
      .from(learningBaselineVersionsTable).where(eq(learningBaselineVersionsTable.baselineId, baselineId));
    const version = Number(next?.value ?? 0) + 1;
    const draft = (await tx.insert(learningBaselineVersionsTable).values({
      id: id("baseline-version"), baselineId, version, status: "DRAFT",
      snapshot: structuredClone(fallback.snapshot), createdBy: actorId,
    }).returning())[0];
    if (!draft) throw new Error("Baseline draft was not created");
    await tx.insert(learningBaselineAuditTable).values({
      id: id("baseline-audit"), baselineId, versionId: draft.id, action: "CLONE_DRAFT",
      actorId, details: { sourceVersionId: fallback.id, sourceVersion: fallback.version },
    });
    return { baselineId, versionId: draft.id, version: draft.version, status: draft.status, sourceVersion: fallback.version };
  });
}

export async function publishBaseline(
  baselineId: string,
  versionId: string,
  manager: { id: string; global: boolean },
  expectedPreviewFingerprint: string,
) {
  const attempt = () => db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('teras-baseline-publish-pin', 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${baselineId}, 0))`);
    const [draft] = await tx.select().from(learningBaselineVersionsTable).where(and(
      eq(learningBaselineVersionsTable.id, versionId),
      eq(learningBaselineVersionsTable.baselineId, baselineId),
    )).limit(1);
    if (!draft) return { error: "Baseline draft not found" as const };
    if (draft.status !== "DRAFT") return { error: "Baseline version is not an active draft" as const };
    const preview = await baselinePublicationPreviewWithExecutor(baselineId, versionId, tx);
    if ("error" in preview) return preview;
    if (!manager.global) {
      const pathwayIds = [...await baselinePathwayIdsWithExecutor(baselineId, tx)];
      const assignments = pathwayIds.length ? await tx.select({ pathwayId: enrollmentsTable.pathwayId }).from(enrollmentsTable).where(and(
        eq(enrollmentsTable.trainerId, manager.id),
        eq(enrollmentsTable.status, "active"),
        inArray(enrollmentsTable.pathwayId, pathwayIds),
      )) : [];
      const assigned = new Set(assignments.map((row: { pathwayId: string }) => row.pathwayId));
      if (!pathwayIds.length || pathwayIds.some(pathwayId => !assigned.has(pathwayId))) {
        return { error: "Baseline manager scope changed; publication is no longer authorized" as const, forbidden: true as const };
      }
    }
    if (preview.previewFingerprint !== expectedPreviewFingerprint) {
      return { error: "Publication preview is stale; review the latest baseline and cohort impact before publishing" as const };
    }
    const report = await validateSnapshotReferences(draft.snapshot, baselineId, tx);
    if (!report.valid) return { error: "Baseline snapshot is invalid" as const, report };
    const [published] = await tx.update(learningBaselineVersionsTable).set({
      status: "PUBLISHED", publishedAt: new Date(), publishedBy: manager.id,
    }).where(and(eq(learningBaselineVersionsTable.id, versionId), eq(learningBaselineVersionsTable.status, "DRAFT"))).returning();
    if (!published) return { error: "Baseline version is not an active draft" as const };
    await tx.update(learningBaselinesTable).set({ publishedVersionId: published.id, status: "active" })
      .where(eq(learningBaselinesTable.id, baselineId));
    await tx.insert(learningBaselineAuditTable).values({
      id: id("baseline-audit"), baselineId, versionId: published.id, action: "PUBLISH",
      actorId: manager.id,
      details: {
        version: published.version,
        previewFingerprint: preview.previewFingerprint,
        changedPathwayCount: preview.changes.length,
        eligibleCohortCount: preview.impact.eligibleCohorts.length,
        preservedEnrollmentCount: preview.impact.preservedEnrollmentCount,
      },
    });
    return { baselineId, versionId: published.id, version: published.version, status: published.status, publishedAt: published.publishedAt };
  }, { isolationLevel: "serializable" });
  for (let retries = 0; ; retries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } }).code
        ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code !== "40001" || retries >= 2) throw error;
    }
  }
}

export async function updateBaselineDraft(baselineId: string, versionId: string, snapshot: Record<string, unknown>, actorId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${baselineId}, 0))`);
    const [draft] = await tx.select().from(learningBaselineVersionsTable).where(and(
      eq(learningBaselineVersionsTable.id, versionId),
      eq(learningBaselineVersionsTable.baselineId, baselineId),
      eq(learningBaselineVersionsTable.status, "DRAFT"),
    )).limit(1);
    if (!draft) return { error: "Baseline draft not found" as const };
    const report = await validateSnapshotReferences(snapshot, baselineId, tx);
    if (!report.valid) return { error: "Baseline snapshot is invalid" as const, report };
    const [updated] = await tx.update(learningBaselineVersionsTable).set({ snapshot }).where(eq(learningBaselineVersionsTable.id, versionId)).returning();
    await tx.insert(learningBaselineAuditTable).values({
      id: id("baseline-audit"), baselineId, versionId, action: "UPDATE_DRAFT", actorId,
      details: { version: draft.version },
    });
    return { baselineId, versionId, version: updated!.version, status: updated!.status, snapshot: updated!.snapshot };
  });
}

export async function cancelBaselineDraft(
  baselineId: string,
  versionId: string,
  actorId: string,
  reason: string,
  idempotencyKey: string,
) {
  const cancellationReason = reason.trim();
  if (!cancellationReason) return { error: "Cancellation reason is required" as const, invalid: true as const };
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${baselineId}, 0))`);
    const [draft] = await tx.select().from(learningBaselineVersionsTable).where(and(
      eq(learningBaselineVersionsTable.id, versionId),
      eq(learningBaselineVersionsTable.baselineId, baselineId),
    )).limit(1);
    if (!draft) return { error: "Baseline draft not found" as const };
    if (draft.status === "CANCELLED") {
      const [audit] = await tx.select().from(learningBaselineAuditTable).where(and(
        eq(learningBaselineAuditTable.versionId, versionId),
        eq(learningBaselineAuditTable.action, "CANCEL_DRAFT"),
      )).limit(1);
      const details = audit?.details as { reason?: unknown; idempotencyKey?: unknown } | undefined;
      if (
        audit?.actorId !== actorId
        || details?.reason !== cancellationReason
        || details?.idempotencyKey !== idempotencyKey
      ) {
        return { error: "Cancellation retry does not match the committed operation" as const };
      }
      return {
        baselineId, versionId, version: draft.version, status: draft.status,
        cancelledAt: draft.cancelledAt, cancelledBy: draft.cancelledBy,
      };
    }
    if (draft.status !== "DRAFT") return { error: "Baseline version is not an active draft" as const };
    const cancelledAt = new Date();
    const [cancelled] = await tx.update(learningBaselineVersionsTable).set({
      status: "CANCELLED", cancelledAt, cancelledBy: actorId,
    }).where(and(
      eq(learningBaselineVersionsTable.id, versionId),
      eq(learningBaselineVersionsTable.status, "DRAFT"),
    )).returning();
    if (!cancelled) return { error: "Baseline version is not an active draft" as const };
    await tx.insert(learningBaselineAuditTable).values({
      id: id("baseline-audit"), baselineId, versionId, action: "CANCEL_DRAFT", actorId,
      details: { version: cancelled.version, reason: cancellationReason, idempotencyKey },
    });
    return {
      baselineId, versionId, version: cancelled.version, status: cancelled.status,
      cancelledAt: cancelled.cancelledAt, cancelledBy: cancelled.cancelledBy,
    };
  });
}

export async function listBaselineVersions(baselineId: string) {
  const table = learningBaselineVersionsTable;
  return db.select({
    id: table.id, baselineId: table.baselineId, version: table.version, status: table.status,
    createdAt: table.createdAt, createdBy: table.createdBy,
    publishedAt: table.publishedAt, publishedBy: table.publishedBy,
    cancelledAt: table.cancelledAt, cancelledBy: table.cancelledBy,
  }).from(table)
    .where(eq(learningBaselineVersionsTable.baselineId, baselineId))
    .orderBy(desc(learningBaselineVersionsTable.version));
}

export async function getBaselineVersion(baselineId: string, versionId: string) {
  const [version] = await db.select().from(learningBaselineVersionsTable).where(and(
    eq(learningBaselineVersionsTable.baselineId, baselineId),
    eq(learningBaselineVersionsTable.id, versionId),
  )).limit(1);
  return version ?? null;
}

export async function listManagedBaselines(manager: { id: string; global: boolean }) {
  const assignedPathways = manager.global ? null : new Set((await db.select({ pathwayId: enrollmentsTable.pathwayId })
    .from(enrollmentsTable).where(and(
      eq(enrollmentsTable.trainerId, manager.id),
      eq(enrollmentsTable.status, "active"),
    ))).map(row => row.pathwayId));
  const summaries = await db.execute<{
    baseline_id: string;
    code: string;
    name: string;
    status: string;
    active_version: number | null;
    draft_count: number;
    pathway_ids: string[];
  }>(sql`
    WITH version_summary AS (
      SELECT
        baseline_id,
        COUNT(*)::integer AS draft_count
      FROM ${learningBaselineVersionsTable}
      WHERE status = 'DRAFT'
      GROUP BY baseline_id
    ),
    baseline_scope AS (
      SELECT
        baseline_id,
        ARRAY_AGG(pathway_id) AS pathway_ids
      FROM ${learningBaselinePathwayScopesTable}
      GROUP BY baseline_id
    )
    SELECT
      baseline.id AS baseline_id,
      baseline.code,
      baseline.name,
      baseline.status,
      active_version.version AS active_version,
      COALESCE(version_summary.draft_count, 0)::integer AS draft_count,
      COALESCE(baseline_scope.pathway_ids, ARRAY[]::text[]) AS pathway_ids
    FROM ${learningBaselinesTable} AS baseline
    LEFT JOIN version_summary ON version_summary.baseline_id = baseline.id
    LEFT JOIN baseline_scope ON baseline_scope.baseline_id = baseline.id
    LEFT JOIN ${learningBaselineVersionsTable} AS active_version
      ON active_version.id = baseline.published_version_id
      AND active_version.status = 'PUBLISHED'
  `);
  return summaries.rows.flatMap(summary => {
    const pathwayIds = new Set(summary.pathway_ids);
    if (assignedPathways && (!pathwayIds.size || [...pathwayIds].some(pathwayId => !assignedPathways.has(pathwayId)))) return [];
    return [{
      baselineId: summary.baseline_id,
      code: summary.code,
      name: summary.name,
      status: summary.status,
      activeVersion: summary.active_version,
      draftCount: summary.draft_count,
    }];
  }).sort((left, right) => left.name.localeCompare(right.name) || left.code.localeCompare(right.code));
}

export async function baselinePathwayIds(baselineId: string) {
  return baselinePathwayIdsWithExecutor(baselineId, db);
}

async function baselinePathwayIdsWithExecutor(baselineId: string, executor: any) {
  const scopes = await executor.select({ pathwayId: learningBaselinePathwayScopesTable.pathwayId })
    .from(learningBaselinePathwayScopesTable)
    .where(eq(learningBaselinePathwayScopesTable.baselineId, baselineId));
  return new Set<string>(scopes.map((scope: { pathwayId: string }) => scope.pathwayId));
}

export function snapshotPathwayIds(snapshot: unknown) {
  const value = snapshot as Snapshot;
  return new Set((value.selections ?? []).flatMap(selection => {
    const pathwayId = selection.pathwayId ?? selection.pathway_id;
    return typeof pathwayId === "string" ? [pathwayId] : [];
  }));
}

export async function baselineAudit(baselineId: string) {
  return db.select().from(learningBaselineAuditTable)
    .where(eq(learningBaselineAuditTable.baselineId, baselineId))
    .orderBy(desc(learningBaselineAuditTable.createdAt), desc(learningBaselineAuditTable.id));
}

/** Pin the applicable published baseline at enrollment/pathway selection time. */
export async function pinPublishedBaseline(pathwayId: string, executor: any) {
  // Canonical lock order: enrollment key (when present), then this global
  // publish/pin key. Every publish takes the same global key before its
  // baseline-specific key, so a version cannot become applicable mid-pin.
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('teras-baseline-publish-pin', 0))`);
  const result = await publishedBaselineForPathwayWithExecutor(pathwayId, executor);
  return result?.version.id ?? null;
}

/** Read module IDs from a pinned snapshot; mutable catalogue rows are fallback only for legacy data. */
export async function selectedBaselineModuleIdsFromVersion(pathwayId: string, versionId?: string | null) {
  if (!versionId) return null;
  const [version] = await db.select().from(learningBaselineVersionsTable)
    .where(eq(learningBaselineVersionsTable.id, versionId)).limit(1);
  if (!version) return null;
  const snapshot = snapshotOf(version);
  const moduleIds = new Set((snapshot.modules ?? [])
    .filter(module => (snapshot.selections ?? []).some(selection =>
      (selection.pathwayId ?? selection.pathway_id) === pathwayId
        && (selection.baselineModuleId ?? selection.baseline_module_id) === module.id,
    ))
    .map(module => module.moduleId ?? module.module_id).filter((value): value is string => typeof value === "string"));
  return moduleIds;
}