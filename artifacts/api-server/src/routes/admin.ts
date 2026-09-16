// Route transaction adapters span Drizzle's database and transaction executor
// types; runtime operations are constrained by the generated Zod contracts.
// @ts-nocheck
import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  CreateAdminCohortBody, CreateAdminCohortResponse, CreateAdminEnrollmentBody, CreateAdminEnrollmentResponse,
  CreateAdminPathwayBody, CreateAdminPathwayResponse, CreateAdminProgramBody, CreateAdminProgramResponse,
  ApproveAdminAccessRequestBody, ApproveAdminAccessRequestParams, CreateAdminAccessRequestBody, CreateAdminAccessRequestResponse, CreateAdminUserBody, CreateAdminUserResponse, GetAdminAccessResponse, GetAdminOperationalSummaryResponse, ListAdminAccessRequestsResponse, ListAdminAuditEventsResponse, ListAdminCohortsResponse,
  ListAdminEnrollmentsResponse, ListAdminPathwaysResponse, ListAdminProgramsResponse, ListAdminUsersResponse,
  ReplaceAdminUserRolesBody, ReplaceAdminUserRolesParams, ReplaceAdminUserRolesResponse,
  UpdateAdminCohortBody, UpdateAdminCohortParams, UpdateAdminCohortResponse, UpdateAdminEnrollmentBody,
  UpdateAdminEnrollmentParams, UpdateAdminEnrollmentResponse, UpdateAdminPathwayBody, UpdateAdminPathwayParams,
  UpdateAdminPathwayResponse, UpdateAdminProgramBody, UpdateAdminProgramParams, UpdateAdminProgramResponse,
  UpdateAdminUserBody, UpdateAdminUserParams, UpdateAdminUserResponse,
  ListAdminCompetencyFrameworksResponse, CreateAdminCompetencyFrameworkBody, CreateAdminCompetencyFrameworkResponse,
  UpdateAdminCompetencyFrameworkBody, UpdateAdminCompetencyFrameworkParams, UpdateAdminCompetencyFrameworkResponse,
  CreateAdminCompetencyUnitBody, CreateAdminCompetencyUnitResponse, UpdateAdminCompetencyUnitBody, UpdateAdminCompetencyUnitParams, UpdateAdminCompetencyUnitResponse,
  CreateAdminReadinessRuleVersionBody, CreateAdminReadinessRuleVersionResponse, ExportAdminReadinessHistoryQueryParams,
  ListAdminReadinessHistoryQueryParams, ListAdminReadinessHistoryResponse,
  ListAdminDiagnosticProvenanceExceptionsResponse,
  ListAdminReadinessRulesResponse,
  ListAdminReminderEscalationsQueryParams, ListAdminReminderEscalationsResponse,
  ResolveAdminReminderEscalationBody, ResolveAdminReminderEscalationParams, ResolveAdminReminderEscalationResponse,
  GetAdminReadinessExportTrendsResponse, RecordAdminReadinessExportTrendBody,
} from "@workspace/api-zod";
import {
  adminAccessRequestsTable, adminAuditEventsTable, assessmentAttemptsTable, cohortsTable, db, enrollmentsTable, evidenceReviewsTable,
  evidenceTable, gapsTable, pathwaysTable, peopleTable, personRolesTable, programsTable, reassessmentLinksTable,
  remediationActivitiesTable, remediationEventsTable, remediationPlansTable,
  competencyFrameworksTable, competencyUnitsTable, pathwayCompetencyUnitsTable, competencyUnitOutcomesTable,
  competencyUnitPracticeTasksTable, competencyUnitEvidenceRequirementsTable, competencyUnitSimulationsTable, competencyUnitSafetyRulesTable,
  readinessEventsTable, readinessGatesTable,
  diagnosticFollowUpFailureNotificationsTable, diagnosticFollowUpReminderDeliveriesTable, diagnosticFollowUpReminderResolutionsTable, diagnosticRecommendationFollowUpsTable,
  diagnosticRecommendationsTable,
  diagnosticProvenanceExceptionsTable,
  readinessAuditExportAggregatesTable,
} from "@workspace/db";
import { authorizeAdmin, authorizeLocalUser, authorizeSuperAdmin, type AdminActor } from "../lib/authorization";
import { pinPublishedBaseline } from "../lib/baseline-authoring";
import { supabaseEmailIsVerified, supabaseIdentity } from "../lib/supabase-auth";
import { allowsSuperAdminMfa } from "@workspace/db/super-admin-mfa-policy";
import { readinessAuditSigner } from "../lib/readiness-audit-signing";
import { safeReminderFailureReason } from "../lib/trainer-follow-up-notifications";
import {
  claimExistingSuperAdminIdentity,
  createManagedUser,
  createAdminAccessRequest,
  replaceManagedUserRoles,
  reviewAdminAccessRequest,
  updateManagedUser,
} from "@workspace/db/admin-membership";

const router: IRouter = Router();
const conflict = (error: unknown) => String(error).includes("duplicate") || String(error).includes("unique");
const normalizeLifecycleRows = (rows: any[]) => rows.map(row => ({
  ...row,
  status: typeof row.status === "string" ? row.status.toLowerCase() : row.status,
}));
const parsed = <T>(schema: { safeParse(value: unknown): { success: boolean; data?: T; error?: { message: string } } }, value: unknown, res: any): T | null => {
  const result = schema.safeParse(value); if (!result.success) { res.status(400).json({ error: result.error?.message }); return null; } return result.data!;
};
async function audit(tx: any, actor: AdminActor, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
  await tx.insert(adminAuditEventsTable).values({ id: crypto.randomUUID(), actorPersonId: actor.personId, actorClerkUserId: actor.authSubject, actorAuthProvider: "supabase", actorAuthSubject: actor.authSubject, action, entityType, entityId, before, after, createdBy: `supabase:${actor.authSubject}` });
}
async function user(id: string, executor: any = db) {
  const [person] = await executor.select().from(peopleTable).where(eq(peopleTable.id, id)); if (!person) return null;
  const roles = await executor.select({ role: personRolesTable.role }).from(personRolesTable).where(eq(personRolesTable.personId, id));
  return { ...person, roles: roles.map(item => item.role) };
}
async function enrollmentValid(input: { learnerId: string; programId: string; pathwayId: string; trainerId?: string | null; assessorId?: string | null; cohortId?: string | null }) {
  const [learner, program, pathway] = await Promise.all([
    db.select().from(peopleTable).where(and(eq(peopleTable.id, input.learnerId), eq(peopleTable.status, "active"))).limit(1),
    db.select().from(programsTable).where(and(eq(programsTable.id, input.programId), eq(programsTable.status, "active"))).limit(1),
    db.select().from(pathwaysTable).where(and(eq(pathwaysTable.id, input.pathwayId), eq(pathwaysTable.programId, input.programId), eq(pathwaysTable.status, "active"))).limit(1),
  ]);
  if (!learner[0] || !program[0] || !pathway[0]) return "Learner, active program, and pathway must exist and share a program";
  if (input.cohortId) { const [cohort] = await db.select().from(cohortsTable).where(and(eq(cohortsTable.id, input.cohortId), eq(cohortsTable.programId, input.programId), eq(cohortsTable.status, "active"))); if (!cohort) return "Cohort must be active and belong to the enrollment program"; }
  for (const [id, role] of [[input.trainerId, "trainer"], [input.assessorId, "assessor"]] as const) if (id) {
    const [match] = await db.select().from(personRolesTable).innerJoin(peopleTable, eq(peopleTable.id, personRolesTable.personId)).where(and(eq(personRolesTable.personId, id), eq(personRolesTable.role, role), eq(peopleTable.status, "active"))); if (!match) return `${role} must be an active person with that role`;
  }
  return null;
}
const latestBy = <T extends { createdAt: Date }>(rows: T[], key: (row: T) => string) => {
  const result = new Map<string, T>();
  for (const row of rows) {
    const previous = result.get(key(row));
    if (!previous || row.createdAt > previous.createdAt) result.set(key(row), row);
  }
  return result;
};
const latestAssessmentAttempts = <T extends { assessmentId: string; learnerId: string; pathwayId: string; number: number; createdAt: Date }>(rows: T[]) => {
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.assessmentId}:${row.learnerId}:${row.pathwayId}`;
    const previous = result.get(key);
    if (!previous || row.number > previous.number || (row.number === previous.number && row.createdAt > previous.createdAt)) result.set(key, row);
  }
  return result;
};

const REMINDER_ESCALATION_SUMMARY_LIMIT = 25;

async function reminderEscalationCounts(executor: any = db) {
  const [counts] = await buildReminderEscalationCountQuery(executor);
  return {
    open: Number(counts?.open ?? 0),
    resolved: Number(counts?.resolved ?? 0),
    total: Number(counts?.total ?? 0),
  };
}

export function buildReminderEscalationCountQuery(executor: any = db) {
  return executor.select({
    open: sql<number>`count(*) filter (where ${diagnosticFollowUpReminderDeliveriesTable.escalationResolvedAt} is null)`,
    resolved: sql<number>`count(*) filter (where ${diagnosticFollowUpReminderDeliveriesTable.escalationResolvedAt} is not null)`,
    total: count(),
  })
    .from(diagnosticFollowUpReminderDeliveriesTable)
    .where(eq(diagnosticFollowUpReminderDeliveriesTable.status, "permanently_failed"));
}

export function buildOpenReminderEscalationIdsQuery(options: { limit: number; offset?: number }, executor: any = db) {
  return executor.select({ id: diagnosticFollowUpReminderDeliveriesTable.id })
    .from(diagnosticFollowUpReminderDeliveriesTable)
    .where(and(
      eq(diagnosticFollowUpReminderDeliveriesTable.status, "permanently_failed"),
      isNull(diagnosticFollowUpReminderDeliveriesTable.escalationResolvedAt),
    ))
    .orderBy(
      desc(diagnosticFollowUpReminderDeliveriesTable.lastAttemptAt),
      desc(diagnosticFollowUpReminderDeliveriesTable.id),
    )
    .limit(options.limit)
    .offset(options.offset ?? 0);
}

export function buildResolvedReminderEscalationIdsQuery(options: { limit: number; offset?: number }, executor: any = db) {
  return executor.select({ id: diagnosticFollowUpReminderDeliveriesTable.id })
    .from(diagnosticFollowUpReminderDeliveriesTable)
    .where(and(
      eq(diagnosticFollowUpReminderDeliveriesTable.status, "permanently_failed"),
      isNotNull(diagnosticFollowUpReminderDeliveriesTable.escalationResolvedAt),
    ))
    .orderBy(
      desc(diagnosticFollowUpReminderDeliveriesTable.escalationResolvedAt),
      desc(diagnosticFollowUpReminderDeliveriesTable.id),
    )
    .limit(options.limit)
    .offset(options.offset ?? 0);
}

async function reminderEscalationRows(options: { status?: "open" | "resolved"; limit: number; offset?: number }, executor: any = db) {
  const offset = options.offset ?? 0;
  let pageIds: string[];
  if (options.status === "open") {
    pageIds = (await buildOpenReminderEscalationIdsQuery({ limit: options.limit, offset }, executor)).map((row: any) => row.id);
  } else if (options.status === "resolved") {
    pageIds = (await buildResolvedReminderEscalationIdsQuery({ limit: options.limit, offset }, executor)).map((row: any) => row.id);
  } else {
    const branchLimit = options.limit + offset;
    const [openRows, resolvedRows] = await Promise.all([
      buildOpenReminderEscalationIdsQuery({ limit: branchLimit }, executor),
      buildResolvedReminderEscalationIdsQuery({ limit: branchLimit }, executor),
    ]);
    pageIds = [
      ...openRows.map((row: any) => row.id),
      ...resolvedRows.map((row: any) => row.id),
    ].slice(offset, offset + options.limit);
  }
  if (pageIds.length === 0) return [];

  const rows = await executor.select({
    id: diagnosticFollowUpReminderDeliveriesTable.id,
    trainerId: diagnosticFollowUpReminderDeliveriesTable.trainerId,
    trainerName: peopleTable.name,
    target: diagnosticRecommendationsTable.title,
    targetAt: diagnosticRecommendationFollowUpsTable.targetAt,
    lastAttemptAt: diagnosticFollowUpReminderDeliveriesTable.lastAttemptAt,
    failureReason: diagnosticFollowUpReminderDeliveriesTable.failureReason,
    resolutionId: diagnosticFollowUpReminderResolutionsTable.id,
    resolutionNote: diagnosticFollowUpReminderResolutionsTable.note,
    resolvedByPersonId: diagnosticFollowUpReminderResolutionsTable.resolvedByPersonId,
    resolvedAt: diagnosticFollowUpReminderResolutionsTable.resolvedAt,
    emailNotificationStatus: sql<string | null>`(
      select notification.status from teras_diagnostic_follow_up_failure_notifications notification
      where notification.reminder_delivery_id = ${diagnosticFollowUpReminderDeliveriesTable.id}
        and notification.channel = 'email' limit 1
    )`,
    emailNotificationAttemptedAt: sql<Date | null>`(
      select notification.attempted_at from teras_diagnostic_follow_up_failure_notifications notification
      where notification.reminder_delivery_id = ${diagnosticFollowUpReminderDeliveriesTable.id}
        and notification.channel = 'email' limit 1
    )`,
    emailNotificationSentAt: sql<Date | null>`(
      select notification.sent_at from teras_diagnostic_follow_up_failure_notifications notification
      where notification.reminder_delivery_id = ${diagnosticFollowUpReminderDeliveriesTable.id}
        and notification.channel = 'email' limit 1
    )`,
    emailNotificationReason: sql<string | null>`(
      select notification.failure_reason from teras_diagnostic_follow_up_failure_notifications notification
      where notification.reminder_delivery_id = ${diagnosticFollowUpReminderDeliveriesTable.id}
        and notification.channel = 'email' limit 1
    )`,
    webhookNotificationStatus: sql<string | null>`(
      select notification.status from teras_diagnostic_follow_up_failure_notifications notification
      where notification.reminder_delivery_id = ${diagnosticFollowUpReminderDeliveriesTable.id}
        and notification.channel = 'webhook' limit 1
    )`,
    webhookNotificationAttemptedAt: sql<Date | null>`(
      select notification.attempted_at from teras_diagnostic_follow_up_failure_notifications notification
      where notification.reminder_delivery_id = ${diagnosticFollowUpReminderDeliveriesTable.id}
        and notification.channel = 'webhook' limit 1
    )`,
    webhookNotificationSentAt: sql<Date | null>`(
      select notification.sent_at from teras_diagnostic_follow_up_failure_notifications notification
      where notification.reminder_delivery_id = ${diagnosticFollowUpReminderDeliveriesTable.id}
        and notification.channel = 'webhook' limit 1
    )`,
    webhookNotificationReason: sql<string | null>`(
      select notification.failure_reason from teras_diagnostic_follow_up_failure_notifications notification
      where notification.reminder_delivery_id = ${diagnosticFollowUpReminderDeliveriesTable.id}
        and notification.channel = 'webhook' limit 1
    )`,
  })
    .from(diagnosticFollowUpReminderDeliveriesTable)
    .innerJoin(diagnosticRecommendationFollowUpsTable, eq(diagnosticRecommendationFollowUpsTable.id, diagnosticFollowUpReminderDeliveriesTable.followUpId))
    .innerJoin(diagnosticRecommendationsTable, eq(diagnosticRecommendationsTable.id, diagnosticRecommendationFollowUpsTable.recommendationId))
    .innerJoin(peopleTable, eq(peopleTable.id, diagnosticFollowUpReminderDeliveriesTable.trainerId))
    .leftJoin(diagnosticFollowUpReminderResolutionsTable, eq(diagnosticFollowUpReminderResolutionsTable.reminderDeliveryId, diagnosticFollowUpReminderDeliveriesTable.id))
    .where(inArray(diagnosticFollowUpReminderDeliveriesTable.id, pageIds));
  const rowById = new Map(rows.map((row: any) => [row.id, row]));
  return pageIds.flatMap(id => {
    const row = rowById.get(id);
    return row ? [row] : [];
  });
}

function serializeReminderEscalations(rows: any[]) {
  const channelStatus = (status: unknown, attemptedAt: unknown, sentAt: unknown, failureReason: unknown) => {
    if (!status) return null;
    return {
      status,
      attemptedAt: attemptedAt ?? null,
      sentAt: sentAt ?? null,
      reason: status === "failed" ? safeReminderFailureReason(typeof failureReason === "string" ? failureReason : null) : null,
    };
  };
  return rows.flatMap(row => {
    if (!row.targetAt || !row.lastAttemptAt) return [];
    return [{
      id: row.id,
      trainerId: row.trainerId,
      trainerName: row.trainerName,
      target: row.target,
      targetAt: row.targetAt,
      lastAttemptAt: row.lastAttemptAt,
      reason: safeReminderFailureReason(row.failureReason),
      emailNotification: channelStatus(row.emailNotificationStatus, row.emailNotificationAttemptedAt, row.emailNotificationSentAt, row.emailNotificationReason),
      webhookNotification: channelStatus(row.webhookNotificationStatus, row.webhookNotificationAttemptedAt, row.webhookNotificationSentAt, row.webhookNotificationReason),
      status: row.resolutionId ? "resolved" : "open",
      resolution: row.resolutionId ? {
        id: row.resolutionId,
        reminderDeliveryId: row.id,
        note: row.resolutionNote,
        resolvedByPersonId: row.resolvedByPersonId,
        resolvedAt: row.resolvedAt,
      } : null,
    }];
  });
}

/** Aggregate-only view for administrators who do not hold the requested
 * operational role. It intentionally contains no actor identity, assignment,
 * or mutation capability. */
async function readOnlyDashboardProjection() {
  const [roles, people, programs, cohorts, enrollments] = await Promise.all([
    db.select().from(personRolesTable),
    db.select().from(peopleTable),
    db.select().from(programsTable),
    db.select().from(cohortsTable),
    db.select().from(enrollmentsTable),
  ]);
  const activePeople = new Set(people.filter(person => person.status === "active").map(person => person.id));
  const activeEnrollments = enrollments.filter(enrollment => enrollment.status === "active" && activePeople.has(enrollment.learnerId));
  const trainerMissing = activeEnrollments.filter(enrollment => !enrollment.trainerId).length;
  const assessorMissing = activeEnrollments.filter(enrollment => !enrollment.assessorId).length;
  const learners = new Set(roles.filter(role => role.role === "learner" && activePeople.has(role.personId)).map(role => role.personId)).size;
  return GetAdminOperationalSummaryResponse.parse({
    metrics: [
      { id: "learners", label: "Learner aktif", value: learners, description: "Pengguna aktif dengan peran learner." },
      { id: "programs", label: "Program aktif", value: programs.filter(program => program.status === "active").length, description: "Program yang siap menerima enrollment." },
      { id: "cohorts", label: "Cohort aktif", value: cohorts.filter(cohort => cohort.status === "active").length, description: "Cohort yang saat ini aktif." },
      { id: "enrollments", label: "Enrollment aktif", value: activeEnrollments.length, description: "Konteks lifecycle aktif di seluruh organisasi." },
    ],
    incompleteAssignments: { trainer: trainerMissing, assessor: assessorMissing, total: activeEnrollments.filter(enrollment => !enrollment.trainerId || !enrollment.assessorId).length },
    failedTrainerReminders: [],
    reminderEscalationCounts: { open: 0, resolved: 0, total: 0 },
    queues: [],
    bottleneck: { stage: "clear", label: "Gunakan Admin Control Room", count: 0, description: "Mode ini hanya menampilkan ringkasan organisasi dan tidak menjalankan pekerjaan atas nama role operasional.", targetTab: "enrollments" },
    actions: [],
    generatedAt: new Date(),
  });
}

router.get("/admin/access", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  res.json(GetAdminAccessResponse.parse({ authorized: true }));
});

router.post("/admin/reminder-escalations/:reminderDeliveryId/resolution", async (req, res): Promise<void> => {
  const actor = await authorizeAdmin(req, res);
  const params = parsed(ResolveAdminReminderEscalationParams, req.params, res);
  const input = parsed(ResolveAdminReminderEscalationBody, req.body, res);
  if (!actor || !params || !input) return;
  if (!actor.personId) {
    res.status(403).json({ error: "A local administrator identity is required to audit this resolution" });
    return;
  }
  try {
    const result = await db.transaction(async tx => {
      const [delivery] = await tx.select({ id: diagnosticFollowUpReminderDeliveriesTable.id, status: diagnosticFollowUpReminderDeliveriesTable.status })
        .from(diagnosticFollowUpReminderDeliveriesTable)
        .where(eq(diagnosticFollowUpReminderDeliveriesTable.id, params.reminderDeliveryId))
        .for("update");
      if (!delivery || delivery.status !== "permanently_failed") return { kind: "not_found" as const };
      const [existingResolution] = await tx.select({ id: diagnosticFollowUpReminderResolutionsTable.id })
        .from(diagnosticFollowUpReminderResolutionsTable)
        .where(eq(diagnosticFollowUpReminderResolutionsTable.reminderDeliveryId, delivery.id))
        .limit(1);
      if (existingResolution) return { kind: "already_resolved" as const };
      const [resolution] = await tx.insert(diagnosticFollowUpReminderResolutionsTable).values({
        id: crypto.randomUUID(),
        reminderDeliveryId: delivery.id,
        note: input.note.trim(),
        resolvedByPersonId: actor.personId,
        resolvedAt: new Date(),
        createdBy: `supabase:${actor.authSubject}`,
      }).returning();
      await tx.update(diagnosticFollowUpReminderDeliveriesTable)
        .set({ escalationResolvedAt: resolution.resolvedAt })
        .where(eq(diagnosticFollowUpReminderDeliveriesTable.id, delivery.id));
      await audit(tx, actor, "resolve", "trainer_reminder_escalation", delivery.id, null, resolution);
      return { kind: "created" as const, value: resolution };
    });
    if (result.kind === "not_found") {
      res.status(404).json({ error: "Open reminder escalation not found" });
      return;
    }
    if (result.kind === "already_resolved") {
      res.status(409).json({ error: "Reminder escalation has already been resolved" });
      return;
    }
    res.status(201).json(ResolveAdminReminderEscalationResponse.parse(result.value));
  } catch (error) {
    if (conflict(error)) {
      res.status(409).json({ error: "Reminder escalation has already been resolved" });
      return;
    }
    throw error;
  }
});

router.get("/admin/reminder-escalations", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const query = parsed(ListAdminReminderEscalationsQueryParams, req.query, res);
  if (!query) return;
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;
  const [rows, counts] = await Promise.all([
    reminderEscalationRows({ status: query.status, limit, offset }),
    reminderEscalationCounts(),
  ]);
  const items = serializeReminderEscalations(rows);
  const total = query.status ? counts[query.status] : counts.total;
  res.json(ListAdminReminderEscalationsResponse.parse({
    items,
    counts,
    pagination: {
      limit,
      offset,
      returned: items.length,
      total,
      hasMore: offset + items.length < total,
    },
  }));
});

router.get("/admin/readiness-rules", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const rules = await db.select().from(readinessGatesTable).where(eq(readinessGatesTable.active, true)).orderBy(readinessGatesTable.pathwayId, readinessGatesTable.sequence);
  res.json(ListAdminReadinessRulesResponse.parse(rules));
});

router.post("/admin/readiness-rules", async (req, res): Promise<void> => {
  const actor = await authorizeAdmin(req, res);
  const input = parsed(CreateAdminReadinessRuleVersionBody, req.body, res);
  if (!actor || !input) return;
  const [pathway] = await db.select().from(pathwaysTable).where(and(eq(pathwaysTable.id, input.pathwayId), eq(pathwaysTable.programId, input.programId)));
  if (!pathway) { res.status(400).json({ error: "Pathway must belong to the selected program" }); return; }
  try {
    const record = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`readiness-rule:${input.pathwayId}:${input.code}`}))`);
      const history = await tx.select().from(readinessGatesTable).where(and(eq(readinessGatesTable.pathwayId, input.pathwayId), eq(readinessGatesTable.code, input.code)));
      const version = Math.max(0, ...history.map(rule => rule.ruleVersion)) + 1;
      await tx.update(readinessGatesTable).set({ active: false }).where(and(eq(readinessGatesTable.pathwayId, input.pathwayId), eq(readinessGatesTable.code, input.code), eq(readinessGatesTable.active, true)));
      const [created] = await tx.insert(readinessGatesTable).values({ ...input, id: crypto.randomUUID(), ruleVersion: version, active: true, createdBy: `supabase:${actor.authSubject}` }).returning();
      await audit(tx as typeof db, actor, "publish_rule_version", "readiness_rule", created.id, history.find(rule => rule.active) ?? null, created);
      return created;
    });
    res.status(201).json(CreateAdminReadinessRuleVersionResponse.parse(record));
  } catch (error) {
    res.status(409).json({ error: "Readiness rule version conflicts with an existing version" });
  }
});

type ReadinessHistoryFilters = {
  learnerId?: string;
  pathwayId?: string;
  status?: "Not Ready" | "Developing" | "Ready for Official Assessment";
  ruleVersion?: number;
};

const readinessHistoryConditions = (filters: ReadinessHistoryFilters) => [
  filters.learnerId ? eq(enrollmentsTable.learnerId, filters.learnerId) : undefined,
  filters.pathwayId ? eq(readinessEventsTable.pathwayId, filters.pathwayId) : undefined,
  filters.status ? eq(readinessEventsTable.status, filters.status) : undefined,
  filters.ruleVersion ? eq(readinessEventsTable.ruleVersion, filters.ruleVersion) : undefined,
].filter(Boolean);

async function readinessHistory(filters: ReadinessHistoryFilters, pagination?: {
  limit: number;
  offset?: number;
  before?: { evaluatedAt: Date; id: string };
}, executor: any = db) {
  const conditions = [
    ...readinessHistoryConditions(filters),
    pagination?.before ? or(
      lt(readinessEventsTable.evaluatedAt, pagination.before.evaluatedAt),
      and(
        eq(readinessEventsTable.evaluatedAt, pagination.before.evaluatedAt),
        lt(readinessEventsTable.id, pagination.before.id),
      ),
    ) : undefined,
  ].filter(Boolean);
  const query = executor.select({
    id: readinessEventsTable.id,
    enrollmentId: readinessEventsTable.enrollmentId,
    learnerId: enrollmentsTable.learnerId,
    learnerName: peopleTable.name,
    pathwayId: readinessEventsTable.pathwayId,
    pathwayName: pathwaysTable.name,
    gateId: readinessEventsTable.gateId,
    gateCode: readinessGatesTable.code,
    gateName: readinessGatesTable.name,
    status: readinessEventsTable.status,
    score: readinessEventsTable.score,
    blockers: readinessEventsTable.blockers,
    ruleVersion: readinessEventsTable.ruleVersion,
    inputEvidence: readinessEventsTable.inputEvidence,
    decisionReason: readinessEventsTable.decisionReason,
    evaluatedAt: readinessEventsTable.evaluatedAt,
  })
    .from(readinessEventsTable)
    .innerJoin(enrollmentsTable, eq(enrollmentsTable.id, readinessEventsTable.enrollmentId))
    .innerJoin(peopleTable, eq(peopleTable.id, enrollmentsTable.learnerId))
    .innerJoin(pathwaysTable, eq(pathwaysTable.id, readinessEventsTable.pathwayId))
    .innerJoin(readinessGatesTable, eq(readinessGatesTable.id, readinessEventsTable.gateId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(readinessEventsTable.evaluatedAt), desc(readinessEventsTable.id));
  return pagination ? query.limit(pagination.limit).offset(pagination.offset ?? 0) : query;
}

async function readinessHistoryCount(filters: ReadinessHistoryFilters, executor: any = db) {
  const conditions = readinessHistoryConditions(filters);
  const [result] = await executor.select({ total: count() })
    .from(readinessEventsTable)
    .innerJoin(enrollmentsTable, eq(enrollmentsTable.id, readinessEventsTable.enrollmentId))
    .where(conditions.length ? and(...conditions) : undefined);
  return result.total;
}

async function writeExportChunk(res: any, chunk: string) {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
  });
}

router.get("/admin/readiness-history", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const filters = parsed(ListAdminReadinessHistoryQueryParams, req.query, res);
  if (!filters) return;
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const [items, total] = await Promise.all([
    readinessHistory(filters, { limit: pageSize, offset: (page - 1) * pageSize }),
    readinessHistoryCount(filters),
  ]);
  res.json(ListAdminReadinessHistoryResponse.parse({ items, page, pageSize, total }));
});

router.get("/admin/diagnostic-provenance-exceptions", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const exceptions = await db
    .select({
      entityType: diagnosticProvenanceExceptionsTable.entityType,
      entityId: diagnosticProvenanceExceptionsTable.entityId,
      profileId: diagnosticProvenanceExceptionsTable.profileId,
      sessionId: diagnosticProvenanceExceptionsTable.sessionId,
      competencyUnitId: diagnosticProvenanceExceptionsTable.competencyUnitId,
      reason: diagnosticProvenanceExceptionsTable.reason,
      detectedAt: diagnosticProvenanceExceptionsTable.detectedAt,
    })
    .from(diagnosticProvenanceExceptionsTable)
    .orderBy(desc(diagnosticProvenanceExceptionsTable.detectedAt), diagnosticProvenanceExceptionsTable.entityType, diagnosticProvenanceExceptionsTable.entityId);
  res.json(ListAdminDiagnosticProvenanceExceptionsResponse.parse(exceptions));
});

router.get("/admin/readiness-history/export", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const filters = parsed(ExportAdminReadinessHistoryQueryParams, req.query, res);
  if (!filters) return;
  let signChecksum: ReturnType<typeof readinessAuditSigner>;
  try {
    signChecksum = readinessAuditSigner();
  } catch {
    res.status(503).json({ error: "Readiness audit signing is not configured" });
    return;
  }
  await db.transaction(async tx => {
    const exportedAt = new Date();
    const recordCount = await readinessHistoryCount(filters, tx);
    const metadata = {
      schemaVersion: "1.0",
      exportedAt,
      filters: {
        learnerId: filters.learnerId ?? null,
        pathwayId: filters.pathwayId ?? null,
        status: filters.status ?? null,
        ruleVersion: filters.ruleVersion ?? null,
      },
      recordCount,
    };
    res.setHeader("Content-Disposition", `attachment; filename="readiness-audit-${exportedAt.toISOString().slice(0, 10)}.json"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Export-Record-Count", String(recordCount));
    res.setHeader("Access-Control-Expose-Headers", "X-Export-Record-Count");
    const hash = createHash("sha256");
    const writeCanonicalChunk = async (chunk: string) => {
      hash.update(chunk, "utf8");
      await writeExportChunk(res, chunk);
    };
    await writeCanonicalChunk(`${JSON.stringify(metadata).slice(0, -1)},"records":[`);
    const batchSize = 500;
    let before: { evaluatedAt: Date; id: string } | undefined;
    let exportedCount = 0;
    let first = true;
    while (exportedCount < recordCount && !res.destroyed) {
      const records = await readinessHistory(filters, { limit: batchSize, before }, tx);
      if (!records.length) break;
      for (const record of records) {
        if (res.destroyed) break;
        await writeCanonicalChunk(`${first ? "" : ","}${JSON.stringify(record)}`);
        first = false;
      }
      exportedCount += records.length;
      const last = records.at(-1)!;
      before = { evaluatedAt: last.evaluatedAt, id: last.id };
    }
    if (!res.destroyed) {
      hash.update("]}", "utf8");
      await writeExportChunk(res, "]");
      const checksum = hash.digest("hex");
      const integrity = {
        algorithm: "SHA-256",
        canonicalization: "teras-readiness-export-v1-json-stringify",
        checksum,
        signature: signChecksum(checksum),
        verificationCommand: "node artifacts/api-server/scripts/verify-readiness-audit.mjs <readiness-audit.json> <public-keys.json>",
      };
      res.end(`,"integrity":${JSON.stringify(integrity)}}`);
    }
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
});

const READINESS_EXPORT_TREND_THRESHOLDS = {
  minimumRecordCount: 1_000,
  minimumSampleSize: 5,
  failureRatio: 0.4,
  periodDays: 7,
} as const;
const READINESS_EXPORT_RECORD_GROUPS = [
  "1.000–4.999 record",
  "5.000–9.999 record",
  "10.000+ record",
] as const;
function readinessExportTrendPeriod(now = new Date()) {
  const periodEnd = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - READINESS_EXPORT_TREND_THRESHOLDS.periodDays + 1);
  return { periodStart: start.toISOString().slice(0, 10), periodEnd };
}

function readinessExportRecordGroup(recordCount: number) {
  if (recordCount >= 10_000) return "10.000+ record";
  if (recordCount >= 5_000) return "5.000–9.999 record";
  return "1.000–4.999 record";
}

router.post("/admin/readiness-history/export-trends", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  if (!req.body || typeof req.body !== "object"
    || Object.keys(req.body).some(key => key !== "outcome" && key !== "recordCount")) {
    res.status(400).json({ error: "Only outcome and recordCount are accepted" });
    return;
  }
  const input = parsed(RecordAdminReadinessExportTrendBody, req.body, res);
  if (!input) return;
  if (input.outcome === "started" || input.recordCount < READINESS_EXPORT_TREND_THRESHOLDS.minimumRecordCount) {
    res.sendStatus(204);
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const recordGroup = readinessExportRecordGroup(input.recordCount);
  await db.insert(readinessAuditExportAggregatesTable)
    .values({ day, recordGroup, outcome: input.outcome, count: 1 })
    .onConflictDoUpdate({
      target: [
        readinessAuditExportAggregatesTable.day,
        readinessAuditExportAggregatesTable.recordGroup,
        readinessAuditExportAggregatesTable.outcome,
      ],
      set: { count: sql`${readinessAuditExportAggregatesTable.count} + 1` },
    });
  res.sendStatus(204);
});

router.get("/admin/readiness-history/export-trends", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const { periodStart, periodEnd } = readinessExportTrendPeriod();
  const rows = await db.select()
    .from(readinessAuditExportAggregatesTable)
    .where(and(
      gte(readinessAuditExportAggregatesTable.day, periodStart),
      lte(readinessAuditExportAggregatesTable.day, periodEnd),
    ));
  const aggregates = rows.map(row => ({
    periodStart: row.day,
    periodEnd: row.day,
    recordGroup: row.recordGroup,
    outcome: row.outcome,
    count: row.count,
  }));
  const alerts = READINESS_EXPORT_RECORD_GROUPS.flatMap(recordGroup => {
    const entries = aggregates.filter(entry => entry.recordGroup === recordGroup);
    const sampleSize = entries.reduce((sum, entry) => sum + entry.count, 0);
    const failedCount = entries
      .filter(entry => entry.outcome === "failed" || entry.outcome === "cancelled")
      .reduce((sum, entry) => sum + entry.count, 0);
    const ratio = sampleSize === 0 ? 0 : failedCount / sampleSize;
    if (sampleSize < READINESS_EXPORT_TREND_THRESHOLDS.minimumSampleSize
      || ratio < READINESS_EXPORT_TREND_THRESHOLDS.failureRatio) return [];
    return [{
      periodStart,
      periodEnd,
      recordGroup,
      sampleSize,
      failedCount,
      failureRatio: ratio,
      explanation: `${failedCount} dari ${sampleSize} ekspor gagal atau dibatalkan (${Math.round(ratio * 100)}%), melewati ambang ${Math.round(READINESS_EXPORT_TREND_THRESHOLDS.failureRatio * 100)}%.`,
    }];
  });
  res.json(GetAdminReadinessExportTrendsResponse.parse({
    thresholds: READINESS_EXPORT_TREND_THRESHOLDS,
    periodStart,
    periodEnd,
    aggregates,
    alerts,
  }));
});

router.post("/admin/claim-supabase-identity", async (req, res): Promise<void> => {
  const identity = await supabaseIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!allowsSuperAdminMfa({ aal: identity.aal, test: false }, process.env)
    || !identity.email || !await supabaseEmailIsVerified(req, identity)) {
    res.status(403).json({ error: "A verified email, MFA (aal2), and locked MFA enrollment are required" });
    return;
  }
  try {
    const result = await claimExistingSuperAdminIdentity({
      authSubject: identity.subject,
      verifiedEmail: identity.email,
      expectedOwnerEmail: process.env.TERAS_SUPER_ADMIN_OWNER_EMAIL,
      allowRecoveryRebind: req.body?.confirmRecoveryRebind === true,
    });
    res.json(result);
  } catch (error) {
    if (String(error).includes("another Supabase identity")) {
      res.status(409).json({
        code: "SUPER_ADMIN_REBIND_CONFIRMATION_REQUIRED",
        error: "This Super Admin is linked to an older Supabase identity",
      });
      return;
    }
    if (String(error).includes("configured legacy owner")) {
      res.status(409).json({
        code: "LEGACY_OWNER_EMAIL_NOT_CONFIGURED_OR_MISMATCHED",
        error: "The verified account does not match the configured legacy owner",
      });
      return;
    }
    res.status(409).json({ error: "This account cannot claim the existing Super Admin identity" });
  }
});

const serveReadOnlyDashboardProjection = async (req: any, res: any): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  res.json(await readOnlyDashboardProjection());
};
router.get("/admin/projections/learner-dashboard", serveReadOnlyDashboardProjection);
router.get("/admin/projections/trainer-dashboard", serveReadOnlyDashboardProjection);
router.get("/admin/projections/assessor-dashboard", serveReadOnlyDashboardProjection);

router.get("/admin/summary", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const [
    roles, people, programs, pathways, cohorts, enrollments, evidence, evidenceReviews, attempts,
    gaps, remediationPlans, remediationActivities, remediationEvents, reassessmentLinks,
    failedReminderRows, reminderCounts,
  ] = await Promise.all([
    db.select().from(personRolesTable), db.select().from(peopleTable), db.select().from(programsTable),
    db.select().from(pathwaysTable), db.select().from(cohortsTable), db.select().from(enrollmentsTable), db.select().from(evidenceTable),
    db.select().from(evidenceReviewsTable), db.select().from(assessmentAttemptsTable),
    db.select().from(gapsTable),
    db.select().from(remediationPlansTable), db.select().from(remediationActivitiesTable),
    db.select().from(remediationEventsTable), db.select().from(reassessmentLinksTable),
    reminderEscalationRows({ limit: REMINDER_ESCALATION_SUMMARY_LIMIT }),
    reminderEscalationCounts(),
  ]);
  const activePeople = new Set(people.filter(person => person.status === "active").map(person => person.id));
  const activeEnrollments = enrollments.filter(enrollment => enrollment.status === "active" && activePeople.has(enrollment.learnerId));
  const activeContexts = new Set(activeEnrollments.map(enrollment => `${enrollment.learnerId}:${enrollment.pathwayId}`));
  const enrollmentByContext = new Map(activeEnrollments.map(enrollment => [`${enrollment.learnerId}:${enrollment.pathwayId}`, enrollment]));
  const peopleById = new Map(people.map(person => [person.id, person]));
  const pathwaysById = new Map(pathways.map(pathway => [pathway.id, pathway]));
  const inActiveContext = (row: { learnerId: string; pathwayId: string }) => activeContexts.has(`${row.learnerId}:${row.pathwayId}`);
  const queueItem = (row: { id: string; learnerId: string; pathwayId: string; createdAt: Date }, title: string, status: string) => {
    const enrollment = enrollmentByContext.get(`${row.learnerId}:${row.pathwayId}`);
    const learner = peopleById.get(row.learnerId);
    const pathway = pathwaysById.get(row.pathwayId);
    const trainer = enrollment?.trainerId ? peopleById.get(enrollment.trainerId) : undefined;
    const assessor = enrollment?.assessorId ? peopleById.get(enrollment.assessorId) : undefined;
    return {
      id: row.id, title, status,
      learnerId: row.learnerId, learnerName: learner?.name ?? row.learnerId,
      pathwayId: row.pathwayId, pathwayName: pathway?.name ?? row.pathwayId,
      trainerId: enrollment?.trainerId ?? null, trainerName: trainer?.name ?? null,
      assessorId: enrollment?.assessorId ?? null, assessorName: assessor?.name ?? null,
      createdAt: row.createdAt,
    };
  };
  const learners = new Set(roles.filter(role => role.role === "learner" && activePeople.has(role.personId)).map(role => role.personId)).size;
  const latestEvidenceReviews = latestBy(evidenceReviews, review => review.evidenceId);
  const evidenceItems = evidence
    .filter(item => inActiveContext(item) && latestEvidenceReviews.get(item.id)?.status === "Under review")
    .map(item => queueItem(item, item.title, "Under review"));
  const activeAttempts = attempts.filter(inActiveContext);
  const latestAttempts = latestAssessmentAttempts(activeAttempts);
  const assessmentItems = [...latestAttempts.values()]
    .filter(attempt => !attempt.decision)
    .map(attempt => queueItem(attempt, `Assessment attempt #${attempt.number}`, attempt.status));
  const latestRemediationEvents = latestBy(remediationEvents, event => event.activityId);
  const planActivities = new Map<string, typeof remediationActivities>();
  for (const activity of remediationActivities) planActivities.set(activity.planId, [...(planActivities.get(activity.planId) ?? []), activity]);
  const activeGapIds = new Set(gaps.filter(inActiveContext).map(gap => gap.id));
  const openRemediationPlanIds = new Set(remediationPlans.filter(plan => activeGapIds.has(plan.gapId) && (() => {
    const activities = planActivities.get(plan.id) ?? [];
    return activities.length > 0 && activities.some(activity => latestRemediationEvents.get(activity.id)?.status !== "Completed");
  })()).map(plan => plan.id));
  const gapsById = new Map(gaps.map(gap => [gap.id, gap]));
  const remediationItems = remediationPlans
    .filter(plan => openRemediationPlanIds.has(plan.id))
    .flatMap(plan => {
      const gap = gapsById.get(plan.gapId);
      return gap ? [queueItem({ ...plan, learnerId: gap.learnerId, pathwayId: gap.pathwayId }, plan.title, "Aktif")] : [];
    });
  const attemptById = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const latestReassessmentByPlan = new Map<string, typeof reassessmentLinks[number]>();
  for (const link of reassessmentLinks.filter(link => inActiveContext(link) && activeGapIds.has(link.originalGapId))) {
    const attempt = attemptById.get(link.reassessmentAttemptId);
    if (!attempt) continue;
    const previousLink = latestReassessmentByPlan.get(link.remediationPlanId);
    const previous = previousLink ? attemptById.get(previousLink.reassessmentAttemptId) : undefined;
    if (!previous || attempt.number > previous.number || (attempt.number === previous.number && attempt.createdAt > previous.createdAt)) latestReassessmentByPlan.set(link.remediationPlanId, link);
  }
  const reassessmentItems = [...latestReassessmentByPlan.values()]
    .filter(link => attemptById.get(link.reassessmentAttemptId)?.decision !== "Competent")
    .map(link => {
      const attempt = attemptById.get(link.reassessmentAttemptId)!;
      return queueItem(attempt, `Reassessment attempt #${attempt.number}`, attempt.decision ?? attempt.status);
    });
  const trainerMissing = activeEnrollments.filter(enrollment => !enrollment.trainerId).length;
  const assessorMissing = activeEnrollments.filter(enrollment => !enrollment.assessorId).length;
  const failedTrainerReminders = serializeReminderEscalations(failedReminderRows);
  const queues = [
    { id: "evidence", label: "Evidence menunggu review", count: evidenceItems.length, description: "Evidence dengan review terbaru masih Under review.", targetTab: "enrollments", items: evidenceItems },
    { id: "assessment", label: "Assessment menunggu keputusan", count: assessmentItems.length, description: "Attempt terbaru belum memiliki keputusan assessor.", targetTab: "enrollments", items: assessmentItems },
    { id: "remediation", label: "Remediation aktif", count: remediationItems.length, description: "Rencana dengan aktivitas yang belum seluruhnya selesai.", targetTab: "enrollments", items: remediationItems },
    { id: "reassessment", label: "Reassessment belum kompeten", count: reassessmentItems.length, description: "Reassessment terhubung yang masih perlu keputusan kompeten.", targetTab: "enrollments", items: reassessmentItems },
  ] as const;
  const largestQueue = queues.reduce((largest, queue) => queue.count > largest.count ? queue : largest, queues[0]);
  const bottleneck = largestQueue.count > 0
    ? { stage: largestQueue.id, label: largestQueue.label, count: largestQueue.count, description: `Tahap ${largestQueue.label.toLowerCase()} adalah antrean lifecycle terbesar saat ini.`, targetTab: "enrollments" as const }
    : { stage: "clear" as const, label: "Tidak ada antrean lifecycle", count: 0, description: "Tidak ada pekerjaan lifecycle yang tertahan saat ringkasan dibuat.", targetTab: "enrollments" as const };
  const actions = [
    ...(reminderCounts.open ? [{ id: "review-failed-trainer-reminders", label: "Periksa pengingat trainer yang gagal", description: `${reminderCounts.open} pengingat telah berhenti setelah tiga percobaan dan perlu ditangani pengelola.`, count: reminderCounts.open, targetTab: "enrollments" as const, urgency: "critical" as const }] : []),
    ...(trainerMissing ? [{ id: "assign-trainers", label: "Lengkapi assignment trainer", description: `${trainerMissing} enrollment aktif belum memiliki trainer.`, count: trainerMissing, targetTab: "enrollments" as const, urgency: "critical" as const }] : []),
    ...(assessorMissing ? [{ id: "assign-assessors", label: "Lengkapi assignment assessor", description: `${assessorMissing} enrollment aktif belum memiliki assessor.`, count: assessorMissing, targetTab: "enrollments" as const, urgency: "critical" as const }] : []),
    ...queues.filter(queue => queue.count > 0).map(queue => ({ id: `resolve-${queue.id}`, label: `Tindak lanjuti ${queue.label.toLowerCase()}`, description: queue.description, count: queue.count, targetTab: "enrollments" as const, urgency: queue.count === largestQueue.count ? "attention" as const : "normal" as const })),
    ...(!programs.some(program => program.status === "active") ? [{ id: "create-program", label: "Aktifkan program pertama", description: "Belum ada program aktif untuk enrollment baru.", count: 0, targetTab: "programs" as const, urgency: "attention" as const }] : []),
    ...(!cohorts.some(cohort => cohort.status === "active") ? [{ id: "create-cohort", label: "Siapkan cohort aktif", description: "Belum ada cohort aktif untuk pengelompokan learner.", count: 0, targetTab: "cohorts" as const, urgency: "normal" as const }] : []),
  ].slice(0, 6);
  res.json(GetAdminOperationalSummaryResponse.parse({
    metrics: [
      { id: "learners", label: "Learner aktif", value: learners, description: "Pengguna aktif dengan peran learner." },
      { id: "programs", label: "Program aktif", value: programs.filter(program => program.status === "active").length, description: "Program yang siap menerima enrollment." },
      { id: "cohorts", label: "Cohort aktif", value: cohorts.filter(cohort => cohort.status === "active").length, description: "Cohort yang saat ini aktif." },
      { id: "enrollments", label: "Enrollment aktif", value: activeEnrollments.length, description: "Learner yang masih berada dalam lifecycle aktif." },
    ],
    incompleteAssignments: { trainer: trainerMissing, assessor: assessorMissing, total: activeEnrollments.filter(enrollment => !enrollment.trainerId || !enrollment.assessorId).length },
    failedTrainerReminders,
    reminderEscalationCounts: reminderCounts,
    queues, bottleneck, actions, generatedAt: new Date(),
  }));
});
router.get("/admin/users", async (req, res): Promise<void> => { const actor = await authorizeAdmin(req, res); if (!actor) return; const people = await db.select().from(peopleTable); const rows = (await Promise.all(people.map(p => user(p.id)))).filter(Boolean) as any[]; res.json(ListAdminUsersResponse.parse(actor.roles.includes("super_admin") ? rows : rows.filter(person => !person.roles.some((role: string) => role === "admin" || role === "super_admin")))); });
router.post("/admin/users", async (req, res): Promise<void> => { const actor = await authorizeAdmin(req, res); if (!actor) return; const input = parsed(CreateAdminUserBody, req.body, res); if (!input) return; try { const outcome = await createManagedUser(input, actor); if (outcome.kind === "forbidden") { res.status(403).json({ error: "Only super administrators may grant privileged roles" }); return; } res.status(201).json(CreateAdminUserResponse.parse(outcome.value)); } catch (error) { res.status(conflict(error) ? 409 : 400).json({ error: conflict(error) ? "User or external identity already exists" : "Could not create user" }); } });
router.patch("/admin/users/:personId", async (req, res): Promise<void> => { const actor = await authorizeAdmin(req, res); const params = parsed(UpdateAdminUserParams, req.params, res); const input = parsed(UpdateAdminUserBody, req.body, res); if (!actor || !params || !input) return; try { const outcome = await updateManagedUser(params.personId, input, actor, { activeAdminFixtureIds: req.integrationActiveAdminFixtureIds }); if (outcome.kind === "forbidden") { res.status(403).json({ error: "Only super administrators may manage privileged users" }); return; } if (outcome.kind === "not_found") { res.status(404).json({ error: "User not found" }); return; } if (outcome.kind === "last_admin" || outcome.kind === "last_super_admin") { res.status(409).json({ error: "Cannot deactivate the final active super administrator or effective administrator" }); return; } res.json(UpdateAdminUserResponse.parse(outcome.value)); } catch (error) { res.status(conflict(error) ? 409 : 400).json({ error: "External identity or email already exists" }); } });
router.put("/admin/users/:personId/roles", async (req, res): Promise<void> => { const actor = await authorizeAdmin(req, res); const params = parsed(ReplaceAdminUserRolesParams, req.params, res); const input = parsed(ReplaceAdminUserRolesBody, req.body, res); if (!actor || !params || !input) return; const outcome = await replaceManagedUserRoles(params.personId, input.roles, actor, { activeAdminFixtureIds: req.integrationActiveAdminFixtureIds }); if (outcome.kind === "forbidden") { res.status(403).json({ error: "Only super administrators may grant or revoke privileged roles" }); return; } if (outcome.kind === "not_found") { res.status(404).json({ error: "User not found" }); return; } if (outcome.kind === "last_admin" || outcome.kind === "last_super_admin") { res.status(409).json({ error: "Cannot remove the final active super administrator or effective administrator role" }); return; } res.json(ReplaceAdminUserRolesResponse.parse(outcome.value)); });
router.get("/admin/access-requests", async (req, res): Promise<void> => { const actor = await authorizeLocalUser(req, res); if (!actor) return; const canReview = actor.roles.some(role => role === "admin" || role === "super_admin"); const rows = canReview ? await db.select().from(adminAccessRequestsTable).orderBy(desc(adminAccessRequestsTable.createdAt)) : await db.select().from(adminAccessRequestsTable).where(eq(adminAccessRequestsTable.targetPersonId, actor.personId)).orderBy(desc(adminAccessRequestsTable.createdAt)); res.json(ListAdminAccessRequestsResponse.parse(rows)); });
router.post("/admin/access-requests", async (req, res): Promise<void> => { const actor = await authorizeLocalUser(req, res); const input = parsed(CreateAdminAccessRequestBody, req.body, res); if (!actor || !input) return; const canRequestForOthers = actor.roles.some(role => role === "admin" || role === "super_admin"); if (!canRequestForOthers && input.targetPersonId !== actor.personId) { res.status(403).json({ error: "Users may only request administrative access for themselves" }); return; } const target = await user(input.targetPersonId); if (!target) { res.status(404).json({ error: "Target user not found" }); return; } if (target.roles.some((role: string) => role === "admin" || role === "super_admin")) { res.status(409).json({ error: "Target user already has administrative access" }); return; } try { const value = await createAdminAccessRequest(actor.personId, input.targetPersonId, input.requestedRole, input.reason, actor); res.status(201).json(CreateAdminAccessRequestResponse.parse(value)); } catch (error) { res.status(conflict(error) ? 409 : 400).json({ error: conflict(error) ? "A matching administrative access request is already pending" : "Could not create administrative access request" }); } });
for (const [suffix, decision] of [["approve", "approved"], ["reject", "rejected"]] as const) router.post(`/admin/access-requests/:requestId/${suffix}`, async (req, res): Promise<void> => { const actor = await authorizeAdmin(req, res); const params = parsed(ApproveAdminAccessRequestParams, req.params, res); const input = parsed(ApproveAdminAccessRequestBody, req.body ?? {}, res); if (!actor || !params || !input) return; const outcome = await reviewAdminAccessRequest(params.requestId, decision, input.reviewNote ?? null, actor); if (outcome.kind === "forbidden") { res.status(403).json({ error: "Administrator role required" }); return; } if (outcome.kind === "not_found") { res.status(404).json({ error: "Access request not found" }); return; } if (outcome.kind === "already_reviewed") { res.status(409).json({ error: "Access request has already been reviewed" }); return; } res.json(outcome.value); });

function lifecycle(prefix: string, table: any, listSchema: any, createSchema: any, createResponse: any, updateParams: any, updateBody: any, updateResponse: any, idColumn: any, entity: string) {
  router.get(`/admin/${prefix}`, async (req, res): Promise<void> => { if (!await authorizeAdmin(req, res)) return; res.json(listSchema.parse(normalizeLifecycleRows(await db.select().from(table)))); });
  router.post(`/admin/${prefix}`, async (req, res): Promise<void> => { const actor = await authorizeAdmin(req, res); const input = parsed(createSchema, req.body, res); if (!actor || !input) return; try { const value = await db.transaction(async tx => { const rows = await tx.insert(table).values({ ...input, createdBy: `supabase:${actor.authSubject}` }).returning() as any[]; await audit(tx as typeof db, actor, "create", entity, rows[0].id, null, rows[0]); return rows[0]; }); res.status(201).json(createResponse.parse(value)); } catch (error) { res.status(conflict(error) ? 409 : 400).json({ error: "Conflicting or invalid lifecycle record" }); } });
  router.patch(`/admin/${prefix}/:${entity}Id`, async (req, res): Promise<void> => { const actor = await authorizeAdmin(req, res); const params = parsed(updateParams, req.params, res); const input = parsed(updateBody, req.body, res); if (!actor || !params || !input) return; const id = (params as any)[`${entity}Id`]; const [before] = await db.select().from(table).where(eq(idColumn, id)); if (!before) { res.status(404).json({ error: `${entity} not found` }); return; } try { const value = await db.transaction(async tx => { const rows = await tx.update(table).set(input).where(eq(idColumn, id)).returning() as any[]; await audit(tx as typeof db, actor, "update", entity, id, before, rows[0]); return rows[0]; }); res.json(updateResponse.parse(value)); } catch (error) { res.status(conflict(error) ? 409 : 400).json({ error: "Conflicting or invalid lifecycle record" }); } });
}
lifecycle("programs", programsTable, ListAdminProgramsResponse, CreateAdminProgramBody, CreateAdminProgramResponse, UpdateAdminProgramParams, UpdateAdminProgramBody, UpdateAdminProgramResponse, programsTable.id, "program");
lifecycle("pathways", pathwaysTable, ListAdminPathwaysResponse, CreateAdminPathwayBody, CreateAdminPathwayResponse, UpdateAdminPathwayParams, UpdateAdminPathwayBody, UpdateAdminPathwayResponse, pathwaysTable.id, "pathway");
lifecycle("cohorts", cohortsTable, ListAdminCohortsResponse, CreateAdminCohortBody, CreateAdminCohortResponse, UpdateAdminCohortParams, UpdateAdminCohortBody, UpdateAdminCohortResponse, cohortsTable.id, "cohort");
router.get("/admin/enrollments", async (req, res): Promise<void> => { if (!await authorizeAdmin(req, res)) return; res.json(ListAdminEnrollmentsResponse.parse(await db.select().from(enrollmentsTable))); });
router.post("/admin/enrollments", async (req, res): Promise<void> => { const actor = await authorizeAdmin(req, res); const input = parsed(CreateAdminEnrollmentBody, req.body, res); if (!actor || !input) return; const error = await enrollmentValid(input); if (error) { res.status(409).json({ error }); return; } try { const value = await db.transaction(async tx => { const baselineVersionId = await pinPublishedBaseline(input.pathwayId, tx); if (!baselineVersionId) throw new Error("No published baseline is available for this pathway"); const [record] = await tx.insert(enrollmentsTable).values({ ...input, baselineVersionId, createdBy: `supabase:${actor.authSubject}` }).returning(); await audit(tx as typeof db, actor, "create", "enrollment", record.id, null, record); return record; }); res.status(201).json(CreateAdminEnrollmentResponse.parse(value)); } catch (error) { res.status(error instanceof Error && error.message.includes("No published") ? 409 : 409).json({ error: error instanceof Error && error.message.includes("No published") ? error.message : "Enrollment conflicts with existing lifecycle data" }); } });
router.patch("/admin/enrollments/:enrollmentId", async (req, res): Promise<void> => {
  const actor = await authorizeAdmin(req, res);
  const params = parsed(UpdateAdminEnrollmentParams, req.params, res);
  const input = parsed(UpdateAdminEnrollmentBody, req.body, res);
  if (!actor || !params || !input) return;
  try {
    const value = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${params.enrollmentId}))`);
      const [before] = await tx.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, params.enrollmentId)).limit(1);
      if (!before) return null;
      const candidate = { ...before, ...input };
      const validationError = await enrollmentValid(candidate);
      if (validationError) throw new Error(validationError);
      const pathwayChanged = input.pathwayId !== undefined && input.pathwayId !== before.pathwayId;
      const baselineVersionId = pathwayChanged ? await pinPublishedBaseline(input.pathwayId!, tx) : before.baselineVersionId;
      if (pathwayChanged && !baselineVersionId) throw new Error("No published baseline is available for this pathway");
      const [record] = await tx.update(enrollmentsTable)
        .set({ ...input, baselineVersionId })
        .where(eq(enrollmentsTable.id, params.enrollmentId))
        .returning();
      await audit(tx as typeof db, actor, "update", "enrollment", record.id, before, record);
      return record;
    });
    if (!value) { res.status(404).json({ error: "Enrollment not found" }); return; }
    res.json(UpdateAdminEnrollmentResponse.parse(value));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Enrollment conflicts with existing lifecycle data" });
  }
});
router.get("/admin/audit", async (req, res): Promise<void> => { if (!await authorizeAdmin(req, res)) return; res.json(ListAdminAuditEventsResponse.parse(await db.select().from(adminAuditEventsTable).orderBy(desc(adminAuditEventsTable.createdAt)))); });

async function competencyView(framework: any, executor: any = db) {
  const units = await executor.select().from(competencyUnitsTable).where(eq(competencyUnitsTable.frameworkId, framework.id));
  const result = await Promise.all(units.map(async (unit: any) => {
    const [pathways, outcomes, tasks, evidence, simulations, safetyRules] = await Promise.all([
      executor.select().from(pathwayCompetencyUnitsTable).where(eq(pathwayCompetencyUnitsTable.unitId, unit.id)),
      executor.select().from(competencyUnitOutcomesTable).where(eq(competencyUnitOutcomesTable.unitId, unit.id)),
      executor.select().from(competencyUnitPracticeTasksTable).where(eq(competencyUnitPracticeTasksTable.unitId, unit.id)),
      executor.select().from(competencyUnitEvidenceRequirementsTable).where(eq(competencyUnitEvidenceRequirementsTable.unitId, unit.id)),
      executor.select().from(competencyUnitSimulationsTable).where(eq(competencyUnitSimulationsTable.unitId, unit.id)),
      executor.select().from(competencyUnitSafetyRulesTable).where(eq(competencyUnitSafetyRulesTable.unitId, unit.id)),
    ]);
    return { ...unit, pathwayIds: pathways.map((row: any) => row.pathwayId), outcomeMappings: outcomes, practiceTaskIds: tasks.map((row: any) => row.taskId), evidenceRequirementIds: evidence.map((row: any) => row.requirementId), simulations, safetyRules };
  }));
  return { ...framework, units: result };
}
async function competencyAggregate(unitId: string, executor: any = db) {
  const [unit] = await executor.select().from(competencyUnitsTable).where(eq(competencyUnitsTable.id, unitId));
  if (!unit) return null;
  const [pathways, outcomes, tasks, evidence, simulations, safetyRules] = await Promise.all([
    executor.select().from(pathwayCompetencyUnitsTable).where(eq(pathwayCompetencyUnitsTable.unitId, unitId)),
    executor.select().from(competencyUnitOutcomesTable).where(eq(competencyUnitOutcomesTable.unitId, unitId)),
    executor.select().from(competencyUnitPracticeTasksTable).where(eq(competencyUnitPracticeTasksTable.unitId, unitId)),
    executor.select().from(competencyUnitEvidenceRequirementsTable).where(eq(competencyUnitEvidenceRequirementsTable.unitId, unitId)),
    executor.select().from(competencyUnitSimulationsTable).where(eq(competencyUnitSimulationsTable.unitId, unitId)),
    executor.select().from(competencyUnitSafetyRulesTable).where(eq(competencyUnitSafetyRulesTable.unitId, unitId)),
  ]);
  return { ...unit, pathwayAssignments: pathways, outcomeMappings: outcomes, practiceTaskMappings: tasks, evidenceRequirementMappings: evidence, simulations, safetyRules };
}
router.get("/admin/competency-frameworks", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const frameworks = await db.select().from(competencyFrameworksTable);
  res.json(ListAdminCompetencyFrameworksResponse.parse(await Promise.all(frameworks.map(item => competencyView(item)))));
});
router.post("/admin/competency-frameworks", async (req, res): Promise<void> => {
  const actor = await authorizeAdmin(req, res); if (!actor) return;
  const input = parsed(CreateAdminCompetencyFrameworkBody, req.body, res); if (!input) return;
  try {
    const value = await db.transaction(async tx => {
      const [record] = await tx.insert(competencyFrameworksTable).values({ ...input, createdBy: `supabase:${actor.authSubject}` }).returning();
      await audit(tx as typeof db, actor, "create", "competency_framework", record.id, null, record);
      return competencyView(record, tx);
    });
    res.status(201).json(CreateAdminCompetencyFrameworkResponse.parse(await value));
  } catch { res.status(409).json({ error: "Competency framework code and version already exist" }); }
});
router.patch("/admin/competency-frameworks/:frameworkId", async (req, res): Promise<void> => {
  const actor = await authorizeAdmin(req, res); const params = parsed(UpdateAdminCompetencyFrameworkParams, req.params, res); const input = parsed(UpdateAdminCompetencyFrameworkBody, req.body, res);
  if (!actor || !params || !input) return;
  const [before] = await db.select().from(competencyFrameworksTable).where(eq(competencyFrameworksTable.id, params.frameworkId));
  if (!before) { res.status(404).json({ error: "Competency framework not found" }); return; }
  try {
    const value = await db.transaction(async tx => { const [record] = await tx.update(competencyFrameworksTable).set(input).where(eq(competencyFrameworksTable.id, params.frameworkId)).returning(); await audit(tx as typeof db, actor, "update", "competency_framework", record.id, before, record); return competencyView(record, tx); });
    res.json(UpdateAdminCompetencyFrameworkResponse.parse(await value));
  } catch { res.status(409).json({ error: "Competency framework update conflicts with existing version" }); }
});
router.post("/admin/competency-units", async (req, res): Promise<void> => {
  const actor = await authorizeAdmin(req, res); if (!actor) return;
  const input = parsed(CreateAdminCompetencyUnitBody, req.body, res); if (!input) return;
  try {
    const value = await db.transaction(async tx => {
      const { pathwayIds = [], outcomeMappings = [], practiceTaskIds = [], evidenceRequirementIds = [], simulations = [], safetyRules = [], ...unit } = input as any;
      const [record] = await tx.insert(competencyUnitsTable).values({ ...unit, createdBy: `supabase:${actor.authSubject}` }).returning();
      if (pathwayIds.length) await tx.insert(pathwayCompetencyUnitsTable).values(pathwayIds.map((pathwayId: string, i: number) => ({ id: crypto.randomUUID(), pathwayId, unitId: record.id, sequence: i + 1, createdBy: `supabase:${actor.authSubject}` })));
      if (outcomeMappings.length) await tx.insert(competencyUnitOutcomesTable).values(outcomeMappings.map((row: any) => ({ ...row, id: crypto.randomUUID(), unitId: record.id, createdBy: `supabase:${actor.authSubject}` })));
      if (practiceTaskIds.length) await tx.insert(competencyUnitPracticeTasksTable).values(practiceTaskIds.map((taskId: string) => ({ id: crypto.randomUUID(), unitId: record.id, taskId, createdBy: `supabase:${actor.authSubject}` })));
      if (evidenceRequirementIds.length) await tx.insert(competencyUnitEvidenceRequirementsTable).values(evidenceRequirementIds.map((requirementId: string) => ({ id: crypto.randomUUID(), unitId: record.id, requirementId, createdBy: `supabase:${actor.authSubject}` })));
      if (simulations.length) await tx.insert(competencyUnitSimulationsTable).values(simulations.map((row: any) => ({ ...row, id: crypto.randomUUID(), unitId: record.id, createdBy: `supabase:${actor.authSubject}` })));
      if (safetyRules.length) await tx.insert(competencyUnitSafetyRulesTable).values(safetyRules.map((row: any) => ({ ...row, id: crypto.randomUUID(), unitId: record.id, createdBy: `supabase:${actor.authSubject}` })));
      await audit(tx as typeof db, actor, "create", "competency_unit", record.id, null, await competencyAggregate(record.id, tx));
      return competencyView(await tx.select().from(competencyFrameworksTable).where(eq(competencyFrameworksTable.id, record.frameworkId)).then((rows: any[]) => rows[0]), tx);
    });
    const framework = await value; const unit = framework.units.find((row: any) => row.id === input.id);
    res.status(201).json(CreateAdminCompetencyUnitResponse.parse(unit));
  } catch { res.status(409).json({ error: "Competency unit or mapping conflicts with existing records" }); }
});
router.patch("/admin/competency-units/:unitId", async (req, res): Promise<void> => {
  const actor = await authorizeAdmin(req, res); const params = parsed(UpdateAdminCompetencyUnitParams, req.params, res); const input = parsed(UpdateAdminCompetencyUnitBody, req.body, res);
  if (!actor || !params || !input) return;
  try {
    const value = await db.transaction(async tx => {
      const [before] = await (tx.select().from(competencyUnitsTable).where(eq(competencyUnitsTable.id, params.unitId)) as any).for("update");
      if (!before) throw Object.assign(new Error("Competency unit not found"), { code: "NOT_FOUND" });
      const beforeAggregate = await competencyAggregate(params.unitId, tx);
      const { pathwayIds, outcomeMappings, practiceTaskIds, evidenceRequirementIds, simulations, safetyRules, ...unit } = input as any;
      const record = Object.keys(unit).length
        ? (await tx.update(competencyUnitsTable).set(unit).where(eq(competencyUnitsTable.id, params.unitId)).returning())[0]
        : before;
      const createdBy = `supabase:${actor.authSubject}`;
      if (Object.prototype.hasOwnProperty.call(input, "pathwayIds")) {
        await tx.delete(pathwayCompetencyUnitsTable).where(eq(pathwayCompetencyUnitsTable.unitId, record.id));
        if (pathwayIds?.length) await tx.insert(pathwayCompetencyUnitsTable).values(pathwayIds.map((pathwayId: string, i: number) => ({ id: crypto.randomUUID(), pathwayId, unitId: record.id, sequence: i + 1, createdBy })));
      }
      if (Object.prototype.hasOwnProperty.call(input, "outcomeMappings")) {
        await tx.delete(competencyUnitOutcomesTable).where(eq(competencyUnitOutcomesTable.unitId, record.id));
        if (outcomeMappings?.length) await tx.insert(competencyUnitOutcomesTable).values(outcomeMappings.map((row: any) => ({ ...row, id: crypto.randomUUID(), unitId: record.id, createdBy })));
      }
      if (Object.prototype.hasOwnProperty.call(input, "practiceTaskIds")) {
        await tx.delete(competencyUnitPracticeTasksTable).where(eq(competencyUnitPracticeTasksTable.unitId, record.id));
        if (practiceTaskIds?.length) await tx.insert(competencyUnitPracticeTasksTable).values(practiceTaskIds.map((taskId: string) => ({ id: crypto.randomUUID(), unitId: record.id, taskId, createdBy })));
      }
      if (Object.prototype.hasOwnProperty.call(input, "evidenceRequirementIds")) {
        await tx.delete(competencyUnitEvidenceRequirementsTable).where(eq(competencyUnitEvidenceRequirementsTable.unitId, record.id));
        if (evidenceRequirementIds?.length) await tx.insert(competencyUnitEvidenceRequirementsTable).values(evidenceRequirementIds.map((requirementId: string) => ({ id: crypto.randomUUID(), unitId: record.id, requirementId, createdBy })));
      }
      if (Object.prototype.hasOwnProperty.call(input, "simulations")) {
        await tx.delete(competencyUnitSimulationsTable).where(eq(competencyUnitSimulationsTable.unitId, record.id));
        if (simulations?.length) await tx.insert(competencyUnitSimulationsTable).values(simulations.map((row: any) => ({ ...row, id: crypto.randomUUID(), unitId: record.id, createdBy })));
      }
      if (Object.prototype.hasOwnProperty.call(input, "safetyRules")) {
        await tx.delete(competencyUnitSafetyRulesTable).where(eq(competencyUnitSafetyRulesTable.unitId, record.id));
        if (safetyRules?.length) await tx.insert(competencyUnitSafetyRulesTable).values(safetyRules.map((row: any) => ({ ...row, id: crypto.randomUUID(), unitId: record.id, createdBy })));
      }
      await audit(tx as typeof db, actor, "update", "competency_unit", record.id, beforeAggregate, await competencyAggregate(record.id, tx)); return record;
    });
    const framework = await db.select().from(competencyFrameworksTable).where(eq(competencyFrameworksTable.id, value.frameworkId)).then(rows => rows[0]);
    const refreshed = await competencyView(framework);
    res.json(UpdateAdminCompetencyUnitResponse.parse(refreshed.units.find((unit: any) => unit.id === value.id)));
  } catch (error) { if ((error as any).code === "NOT_FOUND") { res.status(404).json({ error: "Competency unit not found" }); return; } res.status(409).json({ error: "Competency unit update conflicts with existing records" }); }
});
export default router;