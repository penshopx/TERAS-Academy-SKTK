import { relations, sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, index, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { peopleTable, pathwaysTable, enrollmentsTable, modulesTable, practiceTasksTable, evidenceRequirementsTable } from "./teras";
import { competencyFrameworksTable, competencyUnitsTable } from "./competency";

const audit = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  createdBy: text("created_by").notNull().default("system"),
};

export const diagnosticTemplatesTable = pgTable("teras_diagnostic_templates", {
  id: text("id").primaryKey(), frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id),
  pathwayId: text("pathway_id").notNull().references(() => pathwaysTable.id), version: text("version").notNull(),
  name: text("name").notNull(), description: text("description").notNull(), status: text("status").notNull().default("draft"),
  dimensions: text("dimensions").array().notNull().default([]), ...audit,
}, table => [uniqueIndex("teras_diagnostic_templates_pathway_version_unique").on(table.pathwayId, table.version)]);

export const diagnosticQuestionsTable = pgTable("teras_diagnostic_questions", {
  id: text("id").primaryKey(), templateId: text("template_id").notNull().references(() => diagnosticTemplatesTable.id, { onDelete: "cascade" }),
  frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), competencyUnitId: text("competency_unit_id").references(() => competencyUnitsTable.id),
  dimension: text("dimension").notNull(), questionType: text("question_type").notNull().default("single_choice"), prompt: text("prompt").notNull(), explanation: text("explanation"),
  difficulty: text("difficulty").notNull().default("core"), sequence: integer("sequence").notNull(),
  required: boolean("required").notNull().default(true), metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}), ...audit,
}, table => [uniqueIndex("teras_diagnostic_questions_template_sequence_unique").on(table.templateId, table.sequence), check("teras_diagnostic_questions_sequence_check", sql`${table.sequence} > 0`)]);

export const diagnosticOptionsTable = pgTable("teras_diagnostic_options", {
  id: text("id").primaryKey(), questionId: text("question_id").notNull().references(() => diagnosticQuestionsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(), label: text("label").notNull(), score: integer("score").notNull().default(0),
  safetyOutcome: text("safety_outcome"), safetyFlag: boolean("safety_flag").notNull().default(false), metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}), ...audit,
}, table => [uniqueIndex("teras_diagnostic_options_question_code_unique").on(table.questionId, table.code), check("teras_diagnostic_options_score_check", sql`${table.score} >= 0 AND ${table.score} <= 3`)]);

export const diagnosticSessionsTable = pgTable("teras_diagnostic_sessions", {
  id: text("id").primaryKey(), learnerId: text("learner_id").notNull().references(() => peopleTable.id, { onDelete: "cascade" }),
  enrollmentId: text("enrollment_id").notNull().references(() => enrollmentsTable.id, { onDelete: "cascade" }), pathwayId: text("pathway_id").notNull().references(() => pathwaysTable.id),
  templateId: text("template_id").notNull().references(() => diagnosticTemplatesTable.id), frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id),
  status: text("status").notNull().default("in_progress"), progress: integer("progress").notNull().default(0), completedAt: timestamp("completed_at", { withTimezone: true }), ...audit,
}, table => [
  unique("teras_diagnostic_sessions_id_learner_unique").on(table.id, table.learnerId),
  index("teras_diagnostic_sessions_learner_pathway_idx").on(table.learnerId, table.pathwayId),
  uniqueIndex("teras_diagnostic_sessions_one_active_unique").on(table.learnerId, table.pathwayId).where(sql`${table.status} = 'in_progress'`),
  check("teras_diagnostic_sessions_progress_check", sql`${table.progress} >= 0 AND ${table.progress} <= 100`),
]);

export const diagnosticResponsesTable = pgTable("teras_diagnostic_responses", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull().references(() => diagnosticSessionsTable.id, { onDelete: "cascade" }),
  questionId: text("question_id").notNull().references(() => diagnosticQuestionsTable.id), optionId: text("option_id").notNull().references(() => diagnosticOptionsTable.id),
  frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), competencyUnitId: text("competency_unit_id").references(() => competencyUnitsTable.id),
  answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(), ...audit,
}, table => [uniqueIndex("teras_diagnostic_responses_session_question_unique").on(table.sessionId, table.questionId)]);

export const diagnosticProfilesTable = pgTable("teras_diagnostic_profiles", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull(), learnerId: text("learner_id").notNull().references(() => peopleTable.id, { onDelete: "cascade" }),
  pathwayId: text("pathway_id").notNull().references(() => pathwaysTable.id), frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), frameworkVersion: text("framework_version").notNull(),
  currentState: text("current_state").notNull(), safetyOverride: boolean("safety_override").notNull().default(false), dimensionSummaries: jsonb("dimension_summaries").$type<Record<string, unknown>>().notNull().default({}),
  /** Immutable response/question/option identities used to derive this profile. */
  provenance: jsonb("provenance").$type<DiagnosticProvenance>(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(), ...audit,
}, table => [
  uniqueIndex("teras_diagnostic_profiles_session_unique").on(table.sessionId),
  index("teras_diagnostic_profiles_learner_pathway_idx").on(table.learnerId, table.pathwayId, table.completedAt),
  foreignKey({
    columns: [table.sessionId, table.learnerId],
    foreignColumns: [diagnosticSessionsTable.id, diagnosticSessionsTable.learnerId],
    name: "teras_diagnostic_profiles_session_learner_fk",
  }),
  check("teras_diagnostic_profiles_provenance_check", sql`
    ${table.provenance} IS NULL OR (
      ${table.provenance}->>'sessionId' <> ''
      AND jsonb_array_length(${table.provenance}->'responseIds') > 0
      AND jsonb_array_length(${table.provenance}->'questionIds') > 0
      AND jsonb_array_length(${table.provenance}->'optionIds') > 0
    )
  `),
]);

export const diagnosticProfileItemsTable = pgTable("teras_diagnostic_profile_items", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull().references(() => diagnosticProfilesTable.id, { onDelete: "cascade" }), competencyUnitId: text("competency_unit_id").notNull().references(() => competencyUnitsTable.id),
  frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), unitCode: text("unit_code").notNull().default(""), unitTitle: text("unit_title").notNull().default(""), state: text("state").notNull(), score: integer("score").notNull().default(0), evidenceLevel: text("evidence_level").notNull().default("none"),
  provenance: jsonb("provenance").$type<DiagnosticProvenance>(), ...audit,
}, table => [
  uniqueIndex("teras_diagnostic_profile_items_profile_unit_unique").on(table.profileId, table.competencyUnitId),
  check("teras_diagnostic_profile_items_provenance_check", sql`
    ${table.provenance} IS NULL OR (
      ${table.provenance}->>'sessionId' <> ''
      AND jsonb_array_length(${table.provenance}->'responseIds') > 0
      AND jsonb_array_length(${table.provenance}->'questionIds') > 0
      AND jsonb_array_length(${table.provenance}->'optionIds') > 0
    )
  `),
]);

export const diagnosticGapsTable = pgTable("teras_diagnostic_gaps", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull().references(() => diagnosticProfilesTable.id, { onDelete: "cascade" }), competencyUnitId: text("competency_unit_id").notNull().references(() => competencyUnitsTable.id),
  frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), unitCode: text("unit_code").notNull().default(""), unitTitle: text("unit_title").notNull().default(""), diagnosis: text("diagnosis").notNull(), severity: text("severity").notNull(),
  provenance: jsonb("provenance").$type<DiagnosticProvenance>(), ...audit,
}, table => [
  index("teras_diagnostic_gaps_profile_idx").on(table.profileId, table.id),
  check("teras_diagnostic_gaps_provenance_check", sql`
    ${table.provenance} IS NULL OR (
      ${table.provenance}->>'sessionId' <> ''
      AND jsonb_array_length(${table.provenance}->'responseIds') > 0
      AND jsonb_array_length(${table.provenance}->'questionIds') > 0
      AND jsonb_array_length(${table.provenance}->'optionIds') > 0
    )
  `),
]);
export const diagnosticProvenanceExceptionsTable = pgTable("teras_diagnostic_provenance_exceptions", {
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  profileId: text("profile_id"),
  sessionId: text("session_id"),
  competencyUnitId: text("competency_unit_id"),
  reason: text("reason").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.entityType, table.entityId], name: "teras_diagnostic_provenance_exceptions_pk" }),
  check("teras_diagnostic_provenance_exceptions_entity_type_check", sql`${table.entityType} IN ('profile', 'profile_item', 'gap')`),
  check("teras_diagnostic_provenance_exceptions_reason_check", sql`${table.reason} IN ('NO_VALID_RESPONSE_CHAIN', 'NO_VALID_UNIT_RESPONSE_CHAIN')`),
]);
/** Bounded operational history; schema-check.sql retains the newest 30 runs. */
export const diagnosticProvenanceCheckRunsTable = pgTable("teras_diagnostic_provenance_check_runs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});
/** Aggregate snapshots cascade only when their owning retained check run is pruned. */
export const diagnosticProvenanceCheckCountsTable = pgTable("teras_diagnostic_provenance_check_counts", {
  checkRunId: bigint("check_run_id", { mode: "number" }).notNull().references(() => diagnosticProvenanceCheckRunsTable.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  reason: text("reason").notNull(),
  exceptionCount: integer("exception_count").notNull(),
}, table => [
  primaryKey({ columns: [table.checkRunId, table.entityType, table.reason], name: "teras_diagnostic_provenance_check_counts_pk" }),
  check("teras_diagnostic_provenance_check_counts_entity_type_check", sql`${table.entityType} IN ('profile', 'profile_item', 'gap')`),
  check("teras_diagnostic_provenance_check_counts_reason_check", sql`${table.reason} IN ('NO_VALID_RESPONSE_CHAIN', 'NO_VALID_UNIT_RESPONSE_CHAIN')`),
  check("teras_diagnostic_provenance_check_counts_nonnegative_check", sql`${table.exceptionCount} >= 0`),
]);
export const diagnosticRecommendationsTable = pgTable("teras_diagnostic_recommendations", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull().references(() => diagnosticProfilesTable.id, { onDelete: "cascade" }), competencyUnitId: text("competency_unit_id").references(() => competencyUnitsTable.id),
  frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), unitCode: text("unit_code").notNull().default(""), unitTitle: text("unit_title").notNull().default(""), moduleId: text("module_id").references(() => modulesTable.id), practiceTaskId: text("practice_task_id").references(() => practiceTasksTable.id), evidenceRequirementId: text("evidence_requirement_id").references(() => evidenceRequirementsTable.id),
  simulationId: text("simulation_id"), safetyRuleId: text("safety_rule_id"), kind: text("kind").notNull(), title: text("title").notNull(), rationale: text("rationale").notNull(), priority: text("priority").notNull(), href: text("href"), ...audit,
}, table => [index("teras_diagnostic_recommendations_profile_idx").on(table.profileId, table.id)]);
export const diagnosticRecommendationFollowUpsTable = pgTable("teras_diagnostic_recommendation_follow_ups", {
  id: text("id").primaryKey(),
  recommendationId: text("recommendation_id").notNull().references(() => diagnosticRecommendationsTable.id, { onDelete: "cascade" }),
  trainerId: text("trainer_id").notNull().references(() => peopleTable.id),
  idempotencyKey: text("idempotency_key"),
  idempotencyFingerprint: text("idempotency_fingerprint"),
  status: text("status").notNull(),
  targetAt: timestamp("target_at", { withTimezone: true }),
  note: text("note").notNull(),
  ...audit,
}, table => [
  index("teras_diagnostic_recommendation_follow_ups_recommendation_created_idx").on(table.recommendationId, table.createdAt),
  uniqueIndex("teras_diagnostic_recommendation_follow_ups_idempotency_unique").on(table.recommendationId, table.trainerId, table.idempotencyKey),
  check("teras_diagnostic_recommendation_follow_ups_status_check", sql`${table.status} IN ('planned','in_progress','completed')`),
]);
export const diagnosticFollowUpReminderDeliveriesTable = pgTable("teras_diagnostic_follow_up_reminder_deliveries", {
  id: text("id").primaryKey(),
  followUpId: text("follow_up_id").notNull().references(() => diagnosticRecommendationFollowUpsTable.id, { onDelete: "cascade" }),
  trainerId: text("trainer_id").notNull().references(() => peopleTable.id),
  channel: text("channel").notNull(),
  reminderKind: text("reminder_kind").notNull(),
  destination: text("destination").notNull(),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  escalationResolvedAt: timestamp("escalation_resolved_at", { withTimezone: true }),
  ...audit,
}, table => [
  uniqueIndex("teras_diagnostic_follow_up_reminder_delivery_unique").on(table.followUpId, table.reminderKind, table.channel),
  index("teras_diagnostic_follow_up_reminder_delivery_status_idx").on(table.status, table.lastAttemptAt),
  index("teras_diagnostic_follow_up_reminder_failed_history_idx")
    .on(table.lastAttemptAt.desc().nullsFirst(), table.id.desc().nullsFirst())
    .where(sql`${table.status} = 'permanently_failed' AND ${table.escalationResolvedAt} IS NULL`),
  index("teras_diagnostic_follow_up_reminder_resolved_history_idx")
    .on(table.escalationResolvedAt.desc().nullsFirst(), table.id.desc().nullsFirst())
    .where(sql`${table.status} = 'permanently_failed' AND ${table.escalationResolvedAt} IS NOT NULL`),
  check("teras_diagnostic_follow_up_reminder_delivery_channel_check", sql`${table.channel} IN ('email')`),
  check("teras_diagnostic_follow_up_reminder_delivery_kind_check", sql`${table.reminderKind} IN ('due_soon','overdue')`),
  check("teras_diagnostic_follow_up_reminder_delivery_status_check", sql`${table.status} IN ('pending','sending','sent','failed','permanently_failed')`),
  check("teras_diagnostic_follow_up_reminder_delivery_attempt_count_check", sql`${table.attemptCount} >= 0 AND ${table.attemptCount} <= 3`),
]);
export const diagnosticFollowUpFailureNotificationsTable = pgTable("teras_diagnostic_follow_up_failure_notifications", {
  id: text("id").primaryKey(),
  reminderDeliveryId: text("reminder_delivery_id").notNull().references(() => diagnosticFollowUpReminderDeliveriesTable.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("email"),
  destination: text("destination").notNull(),
  status: text("status").notNull().default("pending"),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  ...audit,
}, table => [
  uniqueIndex("teras_follow_up_failure_notification_delivery_channel_unique").on(table.reminderDeliveryId, table.channel),
  check("teras_diagnostic_follow_up_failure_notification_channel_check", sql`${table.channel} IN ('email','webhook')`),
  check("teras_diagnostic_follow_up_failure_notification_status_check", sql`${table.status} IN ('pending','sending','sent','failed')`),
]);
export const diagnosticFollowUpReminderResolutionsTable = pgTable("teras_diagnostic_follow_up_reminder_resolutions", {
  id: text("id").primaryKey(),
  reminderDeliveryId: text("reminder_delivery_id").notNull().references(() => diagnosticFollowUpReminderDeliveriesTable.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  resolvedByPersonId: text("resolved_by_person_id").notNull().references(() => peopleTable.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  ...audit,
}, table => [
  uniqueIndex("teras_diagnostic_follow_up_reminder_resolution_delivery_unique").on(table.reminderDeliveryId),
  index("teras_diagnostic_follow_up_reminder_resolution_resolved_at_idx").on(table.resolvedAt, table.reminderDeliveryId),
  check("teras_diagnostic_follow_up_reminder_resolution_note_check", sql`length(trim(${table.note})) > 0`),
]);
export const trainerReminderPreferencesTable = pgTable("teras_trainer_reminder_preferences", {
  id: text("id").primaryKey(),
  trainerId: text("trainer_id").notNull().references(() => peopleTable.id, { onDelete: "cascade" }),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  timeZone: text("time_zone").notNull().default("Asia/Jakarta"),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
  ...audit,
}, table => [
  index("teras_trainer_reminder_preferences_trainer_created_id_idx").on(table.trainerId, table.createdAt, table.id),
  check("teras_trainer_reminder_preferences_quiet_hours_check", sql`
    (${table.quietHoursStart} IS NULL AND ${table.quietHoursEnd} IS NULL)
    OR (${table.quietHoursStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND ${table.quietHoursEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  `),
]);
export const diagnosticSafetyFlagsTable = pgTable("teras_diagnostic_safety_flags", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull().references(() => diagnosticProfilesTable.id, { onDelete: "cascade" }), competencyUnitId: text("competency_unit_id").references(() => competencyUnitsTable.id), code: text("code").notNull(), severity: text("severity").notNull(), blocking: boolean("blocking").notNull().default(true), detail: text("detail").notNull(), ...audit,
});
export const diagnosticAuditEventsTable = pgTable("teras_diagnostic_audit_events", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull(), learnerId: text("learner_id").notNull().references(() => peopleTable.id, { onDelete: "cascade" }), action: text("action").notNull(), details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}), ...audit,
}, table => [
  index("teras_diagnostic_audit_session_created_idx").on(table.sessionId, table.createdAt),
  foreignKey({
    columns: [table.sessionId, table.learnerId],
    foreignColumns: [diagnosticSessionsTable.id, diagnosticSessionsTable.learnerId],
    name: "teras_diagnostic_audit_events_session_learner_fk",
  }).onDelete("cascade"),
]);

const tables = { diagnosticTemplatesTable, diagnosticQuestionsTable, diagnosticOptionsTable, diagnosticSessionsTable, diagnosticResponsesTable, diagnosticProfilesTable, diagnosticProfileItemsTable, diagnosticGapsTable, diagnosticRecommendationsTable, diagnosticRecommendationFollowUpsTable, diagnosticFollowUpReminderDeliveriesTable, diagnosticFollowUpFailureNotificationsTable, trainerReminderPreferencesTable, diagnosticSafetyFlagsTable, diagnosticAuditEventsTable };
export const diagnosticInsertSchemas = Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, createInsertSchema(table).omit({ createdAt: true, updatedAt: true })]));
export type DiagnosticSession = typeof diagnosticSessionsTable.$inferSelect;
export type DiagnosticProfile = typeof diagnosticProfilesTable.$inferSelect;
export type InsertDiagnosticSession = z.infer<typeof diagnosticInsertSchemas.diagnosticSessionsTable>;
export const diagnosticRelations = relations(diagnosticTemplatesTable, ({ many }) => ({ questions: many(diagnosticQuestionsTable) }));

export type DiagnosticProvenance = {
  sessionId: string;
  responseIds: string[];
  questionIds: string[];
  optionIds: string[];
};