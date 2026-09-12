import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  db,
  learningBaselineAuditTable,
  learningBaselineVersionsTable,
  learningBaselinesTable,
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

export async function publishBaseline(baselineId: string, versionId: string, actorId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('teras-baseline-publish-pin', 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${baselineId}, 0))`);
    const [draft] = await tx.select().from(learningBaselineVersionsTable).where(and(
      eq(learningBaselineVersionsTable.id, versionId),
      eq(learningBaselineVersionsTable.baselineId, baselineId),
    )).limit(1);
    if (!draft) return { error: "Baseline draft not found" as const };
    if (draft.status !== "DRAFT") return { error: "Baseline version is already published" as const };
    const report = await validateSnapshotReferences(draft.snapshot, baselineId, tx);
    if (!report.valid) return { error: "Baseline snapshot is invalid" as const, report };
    const [published] = await tx.update(learningBaselineVersionsTable).set({
      status: "PUBLISHED", publishedAt: new Date(), publishedBy: actorId,
    }).where(and(eq(learningBaselineVersionsTable.id, versionId), eq(learningBaselineVersionsTable.status, "DRAFT"))).returning();
    if (!published) return { error: "Baseline version is already published" as const };
    await tx.update(learningBaselinesTable).set({ publishedVersionId: published.id, status: "active" })
      .where(eq(learningBaselinesTable.id, baselineId));
    await tx.insert(learningBaselineAuditTable).values({
      id: id("baseline-audit"), baselineId, versionId: published.id, action: "PUBLISH",
      actorId, details: { version: published.version },
    });
    return { baselineId, versionId: published.id, version: published.version, status: published.status, publishedAt: published.publishedAt };
  });
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

export async function listBaselineVersions(baselineId: string) {
  return db.select().from(learningBaselineVersionsTable)
    .where(eq(learningBaselineVersionsTable.baselineId, baselineId))
    .orderBy(desc(learningBaselineVersionsTable.version));
}

export async function baselinePathwayIds(baselineId: string) {
  const versions = await listBaselineVersions(baselineId);
  const pathways = new Set<string>();
  for (const version of versions) {
    const snapshot = snapshotOf(version);
    for (const selection of snapshot.selections ?? []) {
      const pathwayId = selection.pathwayId ?? selection.pathway_id;
      if (typeof pathwayId === "string" && pathwayId) pathways.add(pathwayId);
    }
  }
  return pathways;
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