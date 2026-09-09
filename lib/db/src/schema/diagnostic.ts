import { relations, sql } from "drizzle-orm";
import { boolean, check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, index } from "drizzle-orm/pg-core";
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
  currentState: text("current_state").notNull(), safetyOverride: boolean("safety_override").notNull().default(false), dimensionSummaries: jsonb("dimension_summaries").$type<Record<string, unknown>>().notNull().default({}), completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(), ...audit,
}, table => [
  uniqueIndex("teras_diagnostic_profiles_session_unique").on(table.sessionId),
  index("teras_diagnostic_profiles_learner_pathway_idx").on(table.learnerId, table.pathwayId, table.completedAt),
  foreignKey({
    columns: [table.sessionId, table.learnerId],
    foreignColumns: [diagnosticSessionsTable.id, diagnosticSessionsTable.learnerId],
    name: "teras_diagnostic_profiles_session_learner_fk",
  }),
]);

export const diagnosticProfileItemsTable = pgTable("teras_diagnostic_profile_items", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull().references(() => diagnosticProfilesTable.id, { onDelete: "cascade" }), competencyUnitId: text("competency_unit_id").notNull().references(() => competencyUnitsTable.id),
  frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), unitCode: text("unit_code").notNull().default(""), unitTitle: text("unit_title").notNull().default(""), state: text("state").notNull(), score: integer("score").notNull().default(0), evidenceLevel: text("evidence_level").notNull().default("none"), ...audit,
}, table => [uniqueIndex("teras_diagnostic_profile_items_profile_unit_unique").on(table.profileId, table.competencyUnitId)]);

export const diagnosticGapsTable = pgTable("teras_diagnostic_gaps", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull().references(() => diagnosticProfilesTable.id, { onDelete: "cascade" }), competencyUnitId: text("competency_unit_id").notNull().references(() => competencyUnitsTable.id),
  frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), unitCode: text("unit_code").notNull().default(""), unitTitle: text("unit_title").notNull().default(""), diagnosis: text("diagnosis").notNull(), severity: text("severity").notNull(), ...audit,
});
export const diagnosticRecommendationsTable = pgTable("teras_diagnostic_recommendations", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull().references(() => diagnosticProfilesTable.id, { onDelete: "cascade" }), competencyUnitId: text("competency_unit_id").references(() => competencyUnitsTable.id),
  frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id), unitCode: text("unit_code").notNull().default(""), unitTitle: text("unit_title").notNull().default(""), moduleId: text("module_id").references(() => modulesTable.id), practiceTaskId: text("practice_task_id").references(() => practiceTasksTable.id), evidenceRequirementId: text("evidence_requirement_id").references(() => evidenceRequirementsTable.id),
  simulationId: text("simulation_id"), safetyRuleId: text("safety_rule_id"), kind: text("kind").notNull(), title: text("title").notNull(), rationale: text("rationale").notNull(), priority: text("priority").notNull(), href: text("href"), ...audit,
});
export const diagnosticRecommendationFollowUpsTable = pgTable("teras_diagnostic_recommendation_follow_ups", {
  id: text("id").primaryKey(),
  recommendationId: text("recommendation_id").notNull().references(() => diagnosticRecommendationsTable.id, { onDelete: "cascade" }),
  trainerId: text("trainer_id").notNull().references(() => peopleTable.id),
  status: text("status").notNull(),
  targetAt: timestamp("target_at", { withTimezone: true }),
  note: text("note").notNull(),
  ...audit,
}, table => [
  index("teras_diagnostic_recommendation_follow_ups_recommendation_created_idx").on(table.recommendationId, table.createdAt),
  check("teras_diagnostic_recommendation_follow_ups_status_check", sql`${table.status} IN ('planned','in_progress','completed')`),
]);
export const diagnosticSafetyFlagsTable = pgTable("teras_diagnostic_safety_flags", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull().references(() => diagnosticProfilesTable.id, { onDelete: "cascade" }), competencyUnitId: text("competency_unit_id").references(() => competencyUnitsTable.id), code: text("code").notNull(), severity: text("severity").notNull(), blocking: boolean("blocking").notNull().default(true), detail: text("detail").notNull(), ...audit,
});
export const diagnosticAuditEventsTable = pgTable("teras_diagnostic_audit_events", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull().references(() => diagnosticSessionsTable.id, { onDelete: "cascade" }), learnerId: text("learner_id").notNull().references(() => peopleTable.id, { onDelete: "cascade" }), action: text("action").notNull(), details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}), ...audit,
}, table => [index("teras_diagnostic_audit_session_created_idx").on(table.sessionId, table.createdAt)]);

const tables = { diagnosticTemplatesTable, diagnosticQuestionsTable, diagnosticOptionsTable, diagnosticSessionsTable, diagnosticResponsesTable, diagnosticProfilesTable, diagnosticProfileItemsTable, diagnosticGapsTable, diagnosticRecommendationsTable, diagnosticRecommendationFollowUpsTable, diagnosticSafetyFlagsTable, diagnosticAuditEventsTable };
export const diagnosticInsertSchemas = Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, createInsertSchema(table).omit({ createdAt: true, updatedAt: true })]));
export type DiagnosticSession = typeof diagnosticSessionsTable.$inferSelect;
export type DiagnosticProfile = typeof diagnosticProfilesTable.$inferSelect;
export type InsertDiagnosticSession = z.infer<typeof diagnosticInsertSchemas.diagnosticSessionsTable>;
export const diagnosticRelations = relations(diagnosticTemplatesTable, ({ many }) => ({ questions: many(diagnosticQuestionsTable) }));